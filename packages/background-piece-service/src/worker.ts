import { PieceManager } from "@commonfabric/piece";
import {
  Cell,
  type ConsoleHandler,
  type ConsoleMessage,
  entityIdFrom,
  type ErrorHandler,
  type ErrorWithContext,
  isStream,
  Runtime,
  runtimePresets,
  Stream,
} from "@commonfabric/runner";
import { attachRuntimeTelemetryOtelBridge } from "@commonfabric/runner/telemetry-otel-bridge";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { env } from "./env.ts";
import {
  getMeter,
  getTracer,
  initOpenTelemetry,
  shutdownOpenTelemetry,
} from "./otel.ts";

import {
  createSession,
  type DID,
  Identity,
  Session,
} from "@commonfabric/identity";
import {
  InitializationData,
  isWorkerIPCRequest,
  RunData,
  WorkerIPCMessageType,
  WorkerIPCRequest,
} from "./worker-ipc.ts";

let initialized = false;
let spaceId: DID | undefined;
let latestError: Error | null = null;
let currentSession: Session | null = null;
let manager: PieceManager | null = null;
let runtime: Runtime | null = null;
// Detaches the OpenTelemetry bridge from the runtime's telemetry EventTarget.
// Set when the runtime is created in initialize(), called on cleanup() so the
// listener and any in-flight spans are torn down with the runtime.
let detachOtelBridge: (() => void) | null = null;
const loadedPieces = new Map<string, Cell<{ bgUpdater: Stream<unknown> }>>();
let streamValidator = isStream;

export function recordLatestError(e: ErrorWithContext): void {
  latestError = e;
}

const errorHandler: ErrorHandler = recordLatestError;

const trueConsole = globalThis.console;
export function workerConsoleContext(currentSpaceId = spaceId): string {
  return `Worker(${currentSpaceId ?? "NO_SPACE"})`;
}

// Console for "worker" messages
const console = {
  log(...args: unknown[]) {
    trueConsole.log(this.context(), ...args);
  },
  error(...args: unknown[]) {
    trueConsole.error(this.context(), ...args);
  },
  context() {
    return workerConsoleContext();
  },
};

export function formatConsoleMessage(
  {
    metadata,
    args,
  }: ConsoleMessage,
  currentSpaceId = spaceId,
): unknown[] {
  if (!currentSpaceId) {
    throw new Error(
      "FatalError: Piece executing but worker has no space ID.",
    );
  }
  let ctx;
  if (metadata) {
    if (metadata.space) {
      if (metadata.space !== currentSpaceId) {
        throw new Error("FatalError: Mismatched space ids in worker.");
      }
    }
    if (metadata.pieceId) {
      ctx = `Piece(${metadata.pieceId})`;
    }
  }
  ctx = ctx ?? "Piece(NO_PIECE)";
  return [ctx, ...args.map((arg) => safeFormat(arg))];
}

const consoleHandler: ConsoleHandler = (message) =>
  formatConsoleMessage(message);

export function setWorkerStateForTesting(
  state: {
    initialized?: boolean;
    spaceId?: DID;
    latestError?: Error | null;
    currentSession?: Session | null;
    manager?: PieceManager | null;
    runtime?: Runtime | null;
    loadedPieces?: Iterable<
      [string, Cell<{ bgUpdater: Stream<unknown> }>]
    >;
    streamValidator?: typeof isStream;
  },
): void {
  if ("initialized" in state) initialized = state.initialized ?? false;
  if ("spaceId" in state) spaceId = state.spaceId;
  if ("latestError" in state) latestError = state.latestError ?? null;
  if ("currentSession" in state) currentSession = state.currentSession ?? null;
  if ("manager" in state) manager = state.manager ?? null;
  if ("runtime" in state) runtime = state.runtime ?? null;
  if ("loadedPieces" in state) {
    loadedPieces.clear();
    for (const [pieceId, piece] of state.loadedPieces ?? []) {
      loadedPieces.set(pieceId, piece);
    }
  }
  if ("streamValidator" in state) {
    streamValidator = state.streamValidator ?? isStream;
  }
}

export function resetWorkerStateForTesting(): void {
  initialized = false;
  spaceId = undefined;
  latestError = null;
  currentSession = null;
  manager = null;
  runtime = null;
  detachOtelBridge = null;
  loadedPieces.clear();
  streamValidator = isStream;
}

export async function initialize(
  data: InitializationData,
): Promise<void> {
  if (initialized) {
    console.log(`Already initialized, skipping initialize`);
    return;
  }

  const { did, toolshedUrl, rawIdentity, experimental, clientVersion } = data;
  const identity = await Identity.deserialize(rawIdentity);
  const apiUrl = new URL(toolshedUrl);

  // Initialize session
  spaceId = did as DID;
  currentSession = await createSession({
    identity,
    spaceDid: spaceId,
  });

  // Initialize runtime and piece manager. Shared first-party posture
  // (CT-1814); `experimental` arrives as data from the main process so the
  // service has one flag decision point (see main.ts createRuntime). The
  // preset pins patternEnvironment to `apiUrl`, matching the explicit pin
  // this site previously carried.
  runtime = new Runtime(runtimePresets.productionServer({
    apiUrl,
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(toolshedUrl),
    }),
    // The IPC type allows absence, but the service always forwards the main
    // runtime's resolved flags; `{}` (constructor defaults) covers a bare
    // caller.
    experimental: experimental ?? {},
    clientVersion,
    consoleHandler: consoleHandler,
    errorHandlers: [errorHandler],
  }));
  // Each worker is its own isolate: the provider main.ts registers doesn't
  // exist here, so initialize OTel in-worker (idempotent, fail-open) or the
  // bridge below would attach to no-op instruments.
  await initOpenTelemetry();

  // Bridge the runtime's existing telemetry stream to OpenTelemetry. This is a
  // second, passive consumer of the same event bus the debug tooling uses; it
  // emits no-op instruments unless a provider is registered (see otel.ts).
  detachOtelBridge = attachRuntimeTelemetryOtelBridge(runtime.telemetry, {
    tracer: getTracer(),
    meter: getMeter(),
    attributes: {
      "ct.runtime": "bg-piece",
      "space.did": spaceId,
      "user.did": identity.did(),
    },
    // Metric datapoints don't inherit resource attributes in SigNoz, so stamp
    // the scoping labels explicitly (metrics only — on spans these live on the
    // resource, and duplicating them as span attributes makes the bare key
    // ambiguous in queries).
    metricAttributes: {
      "service.name": env.OTEL_SERVICE_NAME,
      "deployment.environment": env.ENV,
    },
  });

  manager = new PieceManager(currentSession, runtime);
  await manager.ready;

  console.log(`Initialized`);
  initialized = true;
}

// FIXME(ja) should we make sure we kill the worker?
export async function cleanup(): Promise<void> {
  if (!initialized) {
    console.log(`Not initialized, skipping cleanup`);
    return;
  }
  console.log(`Shutting down execution environment`);

  loadedPieces.clear();
  currentSession = null;
  manager = null;

  // Ensure storage is synced before cleanup
  if (runtime) {
    await runtime.storageManager.synced();
    await runtime.dispose();
    runtime = null;
  }

  // Detach the OTel bridge only after the runtime is fully torn down, so the
  // final sync/dispose telemetry (storage completions, subscription removals)
  // is still observed; detaching closes any spans left in flight.
  if (detachOtelBridge) {
    detachOtelBridge();
    detachOtelBridge = null;
  }

  // Flush buffered spans/metrics before the controller terminates this worker;
  // fail-open — telemetry teardown must never block cleanup.
  try {
    await shutdownOpenTelemetry();
  } catch (error) {
    console.error("Failed to shut down OpenTelemetry:", error);
  }

  initialized = false;
}

export async function runPiece(data: RunData): Promise<void> {
  if (!manager) {
    throw new Error("Worker session not initialized");
  }
  if (!spaceId) {
    throw new Error("Worker space not initialized");
  }

  const { pieceId } = data;

  console.log(`Running piece ${spaceId}/${pieceId}`);
  try {
    // Reset error tracking
    latestError = null;

    // Get the piece cell from the pieceId
    let pieceEntityId;
    try {
      pieceEntityId = entityIdFrom(pieceId);
    } catch {
      throw new Error(`Piece ID is not a valid entity id: ${pieceId}`);
    }
    const pieceCell = manager.runtime.getCellFromEntityId(
      spaceId,
      pieceEntityId,
    );

    // Check whether the piece is still in the active piece list.
    const piecesEntryCell = await manager.getActivePiece(pieceCell);
    if (piecesEntryCell === undefined) {
      // Skip any pieces that aren't still in one of the lists
      throw new Error(`No pieces list entry found for piece: ${pieceId}`);
    }

    // Check if we've already loaded this piece
    let runningPiece = loadedPieces.get(pieceId);

    if (!runningPiece) {
      // If not loaded yet, get it from the manager
      console.log(`Loading piece ${pieceId} for the first time`);
      runningPiece = await manager.get(piecesEntryCell, true, {
        type: "object",
        properties: { bgUpdater: { asCell: ["stream"] } },
        required: ["bgUpdater"],
      });

      if (!runningPiece) {
        throw new Error(`Piece not found: ${pieceId}`);
      }

      // Store for future use
      loadedPieces.set(pieceId, runningPiece);
    } else {
      console.log(`Using previously loaded piece ${pieceId}`);
    }

    // Find the updater stream
    const updater = runningPiece.key("bgUpdater") as unknown as Stream<unknown>;
    if (!updater || !streamValidator(updater)) {
      throw new Error(`No updater stream found for piece: ${pieceId}`);
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

    console.log(`Successfully executed piece ${spaceId}/${pieceId}`);
    return;
  } catch (error) {
    // Check if error has context properties
    const errorMessage =
      (error instanceof Error && "space" in error && "pieceId" in error &&
          "patternId" in error)
        ? `${error.message} @ ${error.space}:${error.pieceId} running ${error.patternId}`
        : String(error);
    console.error(
      `Error executing piece ${spaceId}/${pieceId}: ${errorMessage}`,
    );

    // FIXME(ja): this isn't enough to ensure we reload/stop the piece
    loadedPieces.delete(pieceId);

    throw new Error(errorMessage, { cause: error });
  }
}

// Logs here are often viewed through observability dashboards
// that don't render objects well. Attempt to stringify any objects
// here.
export function safeFormat(value: unknown): unknown {
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

export function throwUnhandledRejectionReason(
  e: PromiseRejectionEvent,
): never {
  throw e.reason;
}

self.addEventListener("unhandledrejection", throwUnhandledRejectionReason);

type WorkerMessageHandlers = {
  initialize: typeof initialize;
  runPiece: typeof runPiece;
  cleanup: typeof cleanup;
  postMessage: (message: unknown) => void;
  error: typeof console.error;
};

function defaultWorkerMessageHandlers(): WorkerMessageHandlers {
  return {
    initialize,
    runPiece,
    cleanup,
    postMessage: (message) => self.postMessage(message),
    error: console.error.bind(console),
  };
}

export async function executeWorkerRequest(
  message: WorkerIPCRequest,
  handlers: WorkerMessageHandlers = defaultWorkerMessageHandlers(),
): Promise<void> {
  switch (message.type) {
    case WorkerIPCMessageType.Initialize: {
      await handlers.initialize(message.data);
      break;
    }
    case WorkerIPCMessageType.Run: {
      await handlers.runPiece(message.data);
      break;
    }
    case WorkerIPCMessageType.Cleanup: {
      await handlers.cleanup();
      break;
    }
    default:
      throw new Error("Unknown message type.");
  }
}

export async function handleWorkerMessage(
  message: unknown,
  handlers: WorkerMessageHandlers = defaultWorkerMessageHandlers(),
): Promise<void> {
  try {
    if (!isWorkerIPCRequest(message)) {
      throw new Error(`Invalid IPC request: ${safeFormat(message)}`);
    }
    await executeWorkerRequest(message, handlers);
    handlers.postMessage({ msgId: message.msgId });
  } catch (error) {
    handlers.error(`Worker error:`, error);
    const msgId = typeof message === "object" && message !== null &&
        "msgId" in message
      ? (message as { msgId: unknown }).msgId
      : undefined;
    handlers.postMessage({
      msgId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

self.addEventListener("message", async (event: MessageEvent) => {
  await handleWorkerMessage(event.data);
});

// Signal to the controller that the worker is ready to receive messages.
// This handshake prevents race conditions where the controller might send
// the initialization message before the worker has set up its message listener.
if (typeof self !== "undefined" && self.postMessage) {
  self.postMessage({ type: "ready", msgId: -1 });
}
