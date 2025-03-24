import { sleep } from "@commontools/utils";
import { type Charm, CharmManager } from "@commontools/charm";
import {
  Cell,
  idle,
  isStream,
  onError,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { type DID, Identity, open, type Session } from "@commontools/identity";

let initialized = false;
let spaceId: DID;
let latestError: Error | null = null;
let currentSession: any = null;
let manager: CharmManager | null = null;
const loadedCharms = new Map<string, Cell<Charm>>();

// Capture errors in the charm
onError((e) => {
  latestError = e;
});

async function setup(
  data: { did: string; toolshed_url: string; operator_pass: string },
) {
  if (initialized) {
    console.log(`Worker: Already initialized, skipping setup`);
    return { setup: true, alreadyInitialized: true };
  }

  const { did, toolshed_url, operator_pass } = data || {};
  if (!did) {
    throw new Error("Worker missing did");
  }
  if (!toolshed_url) {
    throw new Error("Worker missing toolshed_url");
  }
  if (!operator_pass) {
    throw new Error("Worker missing operator_pass");
  }

  // Initialize storage and remote connection
  storage.setRemoteStorage(new URL(toolshed_url));
  storage.setSigner(await Identity.fromPassphrase(operator_pass));
  setBobbyServerUrl(toolshed_url);

  // Initialize session
  spaceId = did as DID;
  currentSession = await open({
    passphrase: operator_pass,
    name: "~background-service-worker",
    space: spaceId,
  });

  // Initialize charm manager
  manager = new CharmManager(currentSession);

  console.log(`Worker: ${did} initialized`);
  initialized = true;
  return { setup: true };
}

async function shutdown() {
  if (!initialized) {
    throw new Error("Worker not initialized");
  }
  console.log(`Worker: Shutting down habitat`);

  // Clear charm cache
  loadedCharms.clear();

  // Clear session and manager
  currentSession = null;
  manager = null;

  // Ensure storage is synced before shutdown
  await storage.synced();
  await sleep(1000);

  initialized = false;
  return { shutdown: true };
}

async function runCharm(data: { charm: string }) {
  if (!manager) {
    throw new Error("Worker session not initialized");
  }

  const { charm: charmId } = data || {};
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(
      `Worker error executing charm ${spaceId}/${charmId}: ${errorMessage}`,
    );

    // If there was an error, remove the charm from cache to force a reload next time
    loadedCharms.delete(charmId);

    return {
      success: false,
      charmId,
      error: errorMessage,
    };
  }
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, data } = event.data || {};

  try {
    if (type === "setup") {
      const result = await setup(data);
      self.postMessage({ id, result });
    } else if (type === "runCharm") {
      const result = await runCharm(data);
      self.postMessage({ id, result });
    } else if (type === "shutdown") {
      const result = await shutdown();
      self.postMessage({ id, result });
      self.close(); // terminates the worker
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    console.error(`Worker error:`, error);
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
