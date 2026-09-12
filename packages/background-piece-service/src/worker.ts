/**
 * The worker side of a space: a dedicated thread holding a session and a
 * runtime for one space, which loads the pieces it is asked to run and fires
 * each one's `bgUpdater` stream. It answers the requests in `worker-ipc.ts`
 * over `postMessage`, and announces itself ready once its listener is
 * installed.
 */

import {
  createSession,
  type DID,
  Identity,
  keyPairFromRealmValue,
  Session,
} from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
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
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { attachRuntimeTelemetryOtelBridge } from "@commonfabric/runner/telemetry-otel-bridge";

import { env } from "./env.ts";
import {
  getMeter,
  getTracer,
  initOpenTelemetry,
  shutdownOpenTelemetry,
} from "./otel.ts";
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
let pieces: PiecesController | null = null;
let runtime: Runtime | null = null;
// Detaches the OpenTelemetry bridge from the runtime's telemetry EventTarget.
// Set when the runtime is created in initialize(), called on cleanup() so the
// listener and any in-flight spans are torn down with the runtime.
let detachOtelBridge: (() => void) | null = null;
const loadedPieces = new Map<string, Cell<{ bgUpdater: Stream<unknown> }>>();
let streamValidator = isStream;

/**
 * Error handler of the worker's runtime, which keeps the latest error so that
 * `runPiece()` can report it once the run settles.
 */
export function recordLatestError(e: ErrorWithContext): void {
  latestError = e;
}

const errorHandler: ErrorHandler = recordLatestError;

const trueConsole = globalThis.console;

/** Returns the prefix the worker's own log lines carry, naming its space. */
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

/**
 * Console handler of the worker's runtime, which prefixes a piece's console
 * output with the piece's id, or a placeholder when the message names none,
 * and renders each argument through `safeFormat()`.
 *
 * @throws If the worker has no space, or the message names a different one.
 */
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

/** Sets whichever parts of the worker's module state `state` names. */
export function setWorkerStateForTesting(
  state: {
    initialized?: boolean;
    spaceId?: DID;
    latestError?: Error | null;
    currentSession?: Session | null;
    pieces?: PiecesController | null;
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
  if ("pieces" in state) pieces = state.pieces ?? null;
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

/** Resets the worker's module state to its initial values. */
export function resetWorkerStateForTesting(): void {
  initialized = false;
  spaceId = undefined;
  latestError = null;
  currentSession = null;
  pieces = null;
  runtime = null;
  detachOtelBridge = null;
  loadedPieces.clear();
  streamValidator = isStream;
}

/**
 * Sets the worker up for its space: derives its identity from the encoded
 * key pair, opens a session, builds the runtime with telemetry bridged in,
 * and readies the pieces controller. A call while already initialized does
 * nothing.
 */
export async function initialize(
  data: InitializationData,
): Promise<void> {
  if (initialized) {
    console.log(`Already initialized, skipping initialize`);
    return;
  }

  const { did, toolshedUrl, experimental } = data;
  const identity = await Identity.fromKeyPair(
    keyPairFromRealmValue(
      data.encodedIdentity,
      "Initialization `encodedIdentity`",
    ),
  );
  const apiUrl = new URL(toolshedUrl);

  // Initialize session
  spaceId = did as DID;
  currentSession = await createSession({
    identity,
    spaceDid: spaceId,
  });

  // Initialize runtime and the pieces controller. Shared first-party posture:
  // `experimental` arrives as data from the main process so the service has
  // one flag decision point (see main.ts createRuntime). The preset pins
  // patternEnvironment to `apiUrl`.
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

  pieces = new PiecesController(currentSession, runtime);
  await pieces.ready;

  console.log(`Initialized`);
  initialized = true;
}

/**
 * Tears the worker down: forgets its loaded pieces and session, syncs and
 * disposes the runtime, detaches the telemetry bridge, and flushes
 * telemetry. Does nothing when the worker is not initialized.
 */
export async function cleanup(): Promise<void> {
  // FIXME(ja) should we make sure we kill the worker?
  if (!initialized) {
    console.log(`Not initialized, skipping cleanup`);
    return;
  }
  console.log(`Shutting down execution environment`);

  loadedPieces.clear();
  currentSession = null;
  pieces = null;

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

/**
 * Runs the piece `data` names: loads it on first use, sends `{}` to its
 * `bgUpdater` stream, and waits for the runtime to go idle.
 *
 * @throws If the worker is not initialized; if the piece is not registered,
 *   not found, or has no updater stream; or if the run raised an error. A
 *   piece whose run failed is dropped from the loaded set, so its next run
 *   reloads it.
 */
export async function runPiece(data: RunData): Promise<void> {
  if (!pieces) {
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
    const pieceCell = pieces.runtime.getCellFromEntityId(
      spaceId,
      pieceEntityId,
    );

    // Check whether the piece is still in the active piece list.
    const piecesEntryCell = await pieces.getActivePiece(pieceCell);
    if (piecesEntryCell === undefined) {
      // Skip any pieces that aren't still in one of the lists
      throw new Error(`No pieces list entry found for piece: ${pieceId}`);
    }

    // Check if we've already loaded this piece
    let runningPiece = loadedPieces.get(pieceId);

    if (!runningPiece) {
      // If not loaded yet, get it from the pieces controller
      console.log(`Loading piece ${pieceId} for the first time`);
      runningPiece = await pieces.getPieceCell(piecesEntryCell, true, {
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

/**
 * Renders `value` for a log line: an object is stringified, with
 * `encodedIdentity` redacted, because the observability dashboards these
 * logs reach render objects poorly. Anything else, and an object that will
 * not stringify, is returned as is.
 */
export function safeFormat(value: unknown): unknown {
  // TODO(danfuzz): this is an unsafe use of `stringify()` for piece console
  // arguments, which arrive live and in-process (the runtime's console capture
  // dispatches them without serialization): a logged `FabricSpecialObject`
  // renders as `{}`, silently. Wants a `FabricSpecialObject` test rendering
  // via `toCompactDebugString()` from `@commonfabric/data-model`.
  if (value && typeof value === "object") {
    try {
      // While we use this formatter for runtime code, we also use
      // this for formatting worker errors within the scope, where
      // key material may be in use. Filter it out here until
      // we properly handle sensitive logging.
      return JSON.stringify(
        value,
        (key, value) => key === "encodedIdentity" ? "<REDACTED>" : value,
      );
    } catch (_e) {
      // satisfy typescript's empty block
    }
  }
  return value;
}

/**
 * Handler for the worker's `unhandledrejection` event, which rethrows the
 * reason so that the rejection surfaces as a worker error.
 */
export function throwUnhandledRejectionReason(
  e: PromiseRejectionEvent,
): never {
  throw e.reason;
}

self.addEventListener("unhandledrejection", throwUnhandledRejectionReason);

/** What `handleWorkerMessage()` dispatches to, each part replaceable. */
type WorkerMessageHandlers = {
  /** Handles an `Initialize` request. */
  initialize: typeof initialize;

  /** Handles a `Run` request. */
  runPiece: typeof runPiece;

  /** Handles a `Cleanup` request. */
  cleanup: typeof cleanup;

  /** Posts a response to the controller. */
  postMessage: (message: unknown) => void;

  /** Logs a failed request. */
  error: typeof console.error;
};

/** Returns the handlers wired to this module's own functions and to `self`. */
function defaultWorkerMessageHandlers(): WorkerMessageHandlers {
  return {
    initialize,
    runPiece,
    cleanup,
    postMessage: (message) => self.postMessage(message),
    error: console.error.bind(console),
  };
}

/**
 * Dispatches `message` to the handler for its kind.
 *
 * @throws If the kind is unknown, or whatever the handler throws.
 */
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

/**
 * Handles one message posted to the worker: validates it, executes it, and
 * posts the response, which reports the error when anything failed.
 */
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
