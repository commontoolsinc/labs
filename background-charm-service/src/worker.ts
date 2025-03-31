import { type Charm, CharmManager } from "@commontools/charm";
import {
  Cell,
  idle,
  isErrorWithContext,
  isStream,
  onError,
  setBobbyServerUrl,
  setRecipeEnvironment,
  storage,
} from "@commontools/runner";
import {
  createAdminSession,
  type DID,
  Identity,
  KeyPairRaw,
} from "@commontools/identity";

let initialized = false;
let spaceId: DID;
let latestError: Error | null = null;
let currentSession: any = null;
let manager: CharmManager | null = null;
const loadedCharms = new Map<string, Cell<Charm>>();

// Capture errors in the charm
onError((e: Error) => {
  latestError = e;
});

async function setup(
  data: { did: string; toolshedUrl: string; rawIdentity: KeyPairRaw },
) {
  if (initialized) {
    console.log(`Worker: Already initialized, skipping setup`);
    return { setup: true, alreadyInitialized: true };
  }

  const { did, toolshedUrl, rawIdentity } = data || {};
  if (!did) {
    throw new Error("Worker missing did");
  }
  if (!toolshedUrl) {
    throw new Error("Worker missing toolshedUrl");
  }
  if (!rawIdentity) {
    throw new Error("Worker missing rawIdentity");
  }

  const identity = await Identity.deserialize(rawIdentity);
  const apiUrl = new URL(toolshedUrl);
  // Initialize storage and remote connection
  storage.setRemoteStorage(apiUrl);
  setBobbyServerUrl(toolshedUrl);
  storage.setSigner(identity);
  setRecipeEnvironment({
    apiUrl,
  });

  // Initialize session
  spaceId = did as DID;
  currentSession = await createAdminSession({
    identity,
    name: "~background-service-worker",
    space: spaceId,
  });

  // Initialize charm manager
  manager = new CharmManager(currentSession);

  console.log(`Worker: ${did} initialized`);
  initialized = true;
  return { setup: true };
}

// FIXME(ja) should we make sure we kill the worker?
async function shutdown() {
  if (!initialized) {
    console.log(`Worker: Not initialized, skipping shutdown`);
    return { shutdown: true };
  }
  console.log(`Worker: Shutting down execution environment`);

  loadedCharms.clear();
  currentSession = null;
  manager = null;

  // Ensure storage is synced before shutdown
  await storage.synced();

  initialized = false;
  return { shutdown: true };
}

async function runCharm(data: { charmId: string }) {
  if (!manager) {
    throw new Error("Worker session not initialized");
  }

  const { charmId } = data || {};
  if (!charmId) {
    throw new Error("Missing required parameter: charm");
  }

  console.log(`Worker: Running charm ${spaceId}/${charmId}`);

  try {
    // Reset error tracking
    latestError = null;

    // Check if we've already loaded this charm
    let runningCharm = loadedCharms.get(charmId);

    if (!runningCharm) {
      // If not loaded yet, get it from the manager
      console.log(`Worker: Loading charm ${charmId} for the first time`);
      runningCharm = await manager.get(charmId, true);

      if (!runningCharm) {
        throw new Error(`Charm not found: ${charmId}`);
      }

      // Store for future use
      loadedCharms.set(charmId, runningCharm);
    } else {
      console.log(`Worker: Using previously loaded charm ${charmId}`);
    }

    // Find the updater stream
    const updater = runningCharm.key("bgUpdater");
    if (!updater || !isStream(updater)) {
      throw new Error(`No updater stream found for charm: ${charmId}`);
    }

    // Execute the background updater
    updater.send({});

    // Wait for any pending operations to complete
    await idle();

    if (latestError) {
      throw latestError;
    }

    console.log(`Worker: Successfully executed charm ${spaceId}/${charmId}`);
    return { success: true, charmId };
  } catch (error) {
    const errorMessage = isErrorWithContext(error)
      ? `${error.message} @ ${error.space}:${error.charmId} running ${error.recipeId}`
      : String(error);
    console.error(
      `Worker error executing charm ${spaceId}/${charmId}: ${errorMessage}`,
    );

    // FIXME(ja): this isn't enough to ensure we reload/stop the charm
    loadedCharms.delete(charmId);

    return {
      success: false,
      charmId,
      error: errorMessage,
    };
  }
}

self.onmessage = async (event: MessageEvent) => {
  const { msgId, type, data } = event.data || {};

  try {
    if (type === "setup") {
      const result = await setup(data);
      self.postMessage({ msgId, result });
    } else if (type === "runCharm") {
      const result = await runCharm(data);
      self.postMessage({ msgId, result });
    } else if (type === "shutdown") {
      const result = await shutdown();
      self.postMessage({ msgId, result });
      self.close(); // terminates the worker
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    console.error(`Worker error:`, error);
    self.postMessage({
      msgId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
