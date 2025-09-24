import { CharmManager } from "@commontools/charm";
import {
  Cell,
  type ConsoleHandler,
  ConsoleMethod,
  type ErrorHandler,
  type ErrorWithContext,
  isStream,
  Runtime,
  Stream,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

import {
  createAdminSession,
  type DID,
  Identity,
  Session,
} from "@commontools/identity";
import {
  InitializationData,
  isWorkerIPCRequest,
  RunData,
  WorkerIPCMessageType,
} from "./worker-ipc.ts";

let initialized = false;
let spaceId: DID;
let latestError: Error | null = null;
let currentSession: Session | null = null;
let manager: CharmManager | null = null;
let runtime: Runtime | null = null;
const loadedCharms = new Map<string, Cell<{ bgUpdater: Stream<unknown> }>>();

// Error handler that will be passed to Runtime
const errorHandler: ErrorHandler = (e: ErrorWithContext) => {
  latestError = e;
};

const trueConsole = globalThis.console;
// Console for "worker" messages
const console = {
  log(...args: unknown[]) {
    trueConsole.log(this.context(), ...args);
  },
  error(...args: unknown[]) {
    trueConsole.error(this.context(), ...args);
  },
  context() {
    return `Worker(${spaceId ?? "NO_SPACE"})`;
  },
};
// Console handler that will be passed to Runtime
const consoleHandler: ConsoleHandler = (
  metadata:
    | { charmId?: string; recipeId?: string; space?: string }
    | undefined,
  _method: ConsoleMethod,
  args: unknown[],
) => {
  if (!spaceId) {
    // Shouldn't happen.
    throw new Error(
      "FatalError: Charm executing but worker has no space ID.",
    );
  }
  let ctx;
  if (metadata) {
    if (metadata.space) {
      if (metadata.space !== spaceId) {
        throw new Error("FatalError: Mismatched space ids in worker.");
      }
    }
    if (metadata.charmId) {
      ctx = `Charm(${metadata.charmId})`;
    }
  }
  ctx = ctx ?? "Charm(NO_CHARM)";
  return [ctx, ...args.map((arg) => safeFormat(arg))];
};

async function initialize(
  data: InitializationData,
): Promise<void> {
  if (initialized) {
    console.log(`Already initialized, skipping initialize`);
    return;
  }

  const { did, toolshedUrl, rawIdentity } = data;
  const identity = await Identity.deserialize(rawIdentity);
  const apiUrl = new URL(toolshedUrl);

  // Initialize session
  spaceId = did as DID;
  currentSession = await createAdminSession({
    identity,
    name: "~background-service-worker",
    space: spaceId,
  });

  // Initialize runtime and charm manager
  runtime = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", toolshedUrl),
    }),
    blobbyServerUrl: toolshedUrl,
    recipeEnvironment: { apiUrl },
    consoleHandler: consoleHandler,
    errorHandlers: [errorHandler],
  });
  manager = new CharmManager(currentSession, runtime);
  await manager.ready;

  console.log(`Initialized`);
  initialized = true;
}

// FIXME(ja) should we make sure we kill the worker?
async function cleanup(): Promise<void> {
  if (!initialized) {
    console.log(`Not initialized, skipping cleanup`);
    return;
  }
  console.log(`Shutting down execution environment`);

  loadedCharms.clear();
  currentSession = null;
  manager = null;

  // Ensure storage is synced before cleanup
  if (runtime) {
    await runtime.storageManager.synced();
    await runtime.dispose();
    runtime = null;
  }

  initialized = false;
}

async function runCharm(data: RunData): Promise<void> {
  if (!manager) {
    throw new Error("Worker session not initialized");
  }

  const { charmId } = data;

  console.log(`Running charm ${spaceId}/${charmId}`);
  try {
    // Reset error tracking
    latestError = null;

    // Check whether the charm is still active (in charms or pinned-charms)
    const charmsEntryCell = manager.getActiveCharm({ "/": charmId });
    if (charmsEntryCell === undefined) {
      // Skip any charms that aren't still in one of the lists
      throw new Error(`No charms list entry found for charm: ${charmId}`);
    }

    // Check if we've already loaded this charm
    let runningCharm = loadedCharms.get(charmId);

    if (!runningCharm) {
      // If not loaded yet, get it from the manager
      console.log(`Loading charm ${charmId} for the first time`);
      runningCharm = await manager.get(charmsEntryCell, true, { type: "object", properties: { bgUpdater: { asStream: true } }, required: ["bgUpdater"] });

      if (!runningCharm) {
        throw new Error(`Charm not found: ${charmId}`);
      }

      // Store for future use
      loadedCharms.set(charmId, runningCharm);
    } else {
      console.log(`Using previously loaded charm ${charmId}`);
    }

    // Find the updater stream
    const updater = runningCharm.key("bgUpdater") as Stream<unknown>;
    if (!updater || !isStream(updater)) {
      throw new Error(`No updater stream found for charm: ${charmId}`);
    }

    // Execute the background updater
    const tx = updater.runtime.edit();
    updater.withTx(tx).send({});
    tx.commit(); // No retry, since events already do that

    // Wait for any pending operations to complete
    if (runtime) {
      await runtime.idle();
    }

    if (latestError) {
      throw latestError;
    }

    console.log(`Successfully executed charm ${spaceId}/${charmId}`);
    return;
  } catch (error) {
    // Check if error has context properties
    const errorMessage =
      (error instanceof Error && "space" in error && "charmId" in error &&
          "recipeId" in error)
        ? `${error.message} @ ${error.space}:${error.charmId} running ${error.recipeId}`
        : String(error);
    console.error(
      `Error executing charm ${spaceId}/${charmId}: ${errorMessage}`,
    );

    // FIXME(ja): this isn't enough to ensure we reload/stop the charm
    loadedCharms.delete(charmId);

    throw new Error(errorMessage, { cause: error });
  }
}

// Logs here are often viewed through observability dashboards
// that don't render objects well. Attempt to stringify any objects
// here.
function safeFormat(value: unknown): unknown {
  if (value && typeof value === "object") {
    try {
      // While we use this formatter for runtime code, we also use
      // this for formatting worker errors within the scope, where
      // key material may be in use. Filter it out here until
      // we properly handle sensitive logging.
      return JSON.stringify(
        value,
        (key, value) => key === "rawIdentity" ? "<REDACTED>" : value,
      );
    } catch (_e) {
      // satisfy typescript's empty block
    }
  }
  return value;
}

self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  // Throw this so that `WorkerController`'s `error` handler can handle
  // unhandled rejections the same way unhandled errors are handled.
  throw e.reason;
});

self.addEventListener("message", async (event: MessageEvent) => {
  const message = event.data;
  try {
    if (!isWorkerIPCRequest(message)) {
      throw new Error(`Invalid IPC request: ${safeFormat(message)}`);
    }
    switch (message.type) {
      case WorkerIPCMessageType.Initialize: {
        await initialize(message.data);
        break;
      }
      case WorkerIPCMessageType.Run: {
        await runCharm(message.data);
        break;
      }
      case WorkerIPCMessageType.Cleanup: {
        await cleanup();
        break;
      }
      default:
        throw new Error("Unknown message type.");
    }
    self.postMessage({ msgId: message.msgId });
  } catch (error) {
    console.error(`Worker error:`, error);
    self.postMessage({
      msgId: message.msgId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Signal to the controller that the worker is ready to receive messages.
// This handshake prevents race conditions where the controller might send
// the initialization message before the worker has set up its message listener.
if (typeof self !== "undefined" && self.postMessage) {
  self.postMessage({ type: "ready", msgId: -1 });
}
