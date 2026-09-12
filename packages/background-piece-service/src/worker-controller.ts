/**
 * The main-thread side of a space's worker: spawns it, hands it requests over
 * the protocol in `worker-ipc.ts`, matches its responses to them, and reports
 * its terminal errors as events.
 */

import { Identity, realmValueFromKeyPair } from "@commonfabric/identity";
import { Cell } from "@commonfabric/runner";
import { defer, type Deferred } from "@commonfabric/utils/defer";

import { BGPieceEntry } from "./schema.ts";
import {
  isWorkerIPCRequest,
  isWorkerIPCResponse,
  WorkerIPCMessageType,
} from "./worker-ipc.ts";

/**
 * How long a request may run before it fails, absent a `timeoutMs` option: a
 * minute.
 */
const DEFAULT_TASK_TIMEOUT = 60_000;

/** Lifecycle states of a worker controller. */
export enum WorkerState {
  /** Constructed; the worker has not yet announced itself ready. */
  Uninitialized = "uninitialized",

  /** The `Initialize` request is in flight. */
  Initializing = "initializing",

  /** Initialized; `runPiece()` may be called. */
  Ready = "ready",

  /** `shutdown()` is in progress. */
  Terminating = "terminating",

  /** Shut down; the worker is terminated. */
  Terminated = "terminated",

  /**
   * Initialization failed, or the worker reported an error and was
   * terminated.
   */
  Error = "error",
}

/** Options for constructing a `WorkerController`. */
export interface WorkerOptions {
  /** DID of the space the worker serves. */
  did: string;

  /** URL of the toolshed the worker's runtime talks to. */
  toolshedUrl: string;

  /** Identity the worker runs as. */
  identity: Identity;

  /**
   * How long a request may run before it fails, in milliseconds; a minute by
   * default.
   */
  timeoutMs?: number;

  /** Experimental runtime options to forward to the worker. */
  experimental?: {
    /** Whether the runtime uses the modern cell representation. */
    modernCellRep?: boolean;
  };
}

/** The `error` event a worker controller dispatches on a terminal failure. */
export class WorkerControllerErrorEvent extends Event {
  #error: ErrorEvent | undefined;

  /** Constructs an instance carrying `cause`, the worker's own error event. */
  constructor(cause?: ErrorEvent) {
    super("error");
    this.#error = cause;
  }

  /** The worker's own error event, if the worker reported one. */
  get error(): ErrorEvent | undefined {
    return this.#error;
  }
}

/** A request in flight. */
interface Task {
  /** The request's message id. */
  msgId: number;

  /** When the request was sent, as a `performance.now()` value. */
  startTime: number;

  /** Kind of the request. */
  type: WorkerIPCMessageType;

  /** Settled by the worker's response, or by timeout or shutdown. */
  deferred: Deferred;
}

/**
 * Controller of one space's worker. Constructing one spawns the worker;
 * initialization starts on its own once the worker announces itself ready,
 * and `ready` settles when that finishes. Each request carries a message id,
 * and fails on its own timeout when the worker does not answer in time.
 *
 * @event error A terminal error occurred in the worker, which has been
 *   terminated; the event is a `WorkerControllerErrorEvent`.
 */
export class WorkerController extends EventTarget {
  #worker: Worker;
  #did: string;
  #toolshedUrl: string;
  #identity: Identity;
  #timeoutMs: number;
  #experimental?: WorkerOptions["experimental"];
  #msgId: number = 0;
  #pending = new Map<
    number,
    Task
  >();

  /**
   * Settled when `startInitialize()` finishes: resolved once the worker is
   * ready, rejected with the error that stopped it.
   */
  #initializeDeferred = defer();

  #state = WorkerState.Uninitialized;

  /**
   * Constructs an instance and spawns the worker for the space `options`
   * names.
   */
  constructor(options: WorkerOptions) {
    super();
    this.#did = options.did;
    this.#identity = options.identity;
    this.#toolshedUrl = options.toolshedUrl;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TASK_TIMEOUT;
    this.#experimental = options.experimental;

    console.log(`${this.#did}: Creating worker controller`);

    this.#worker = new Worker(
      new URL("./worker.ts", import.meta.url).href,
      {
        type: "module",
        name: `worker-${this.#did}`,
      },
    );
    this.#worker.addEventListener("message", this.#onWorkerMessage);
    this.#worker.addEventListener("error", this.#onWorkerError);
  }

  /**
   * The two steps of this instance that a test drives directly: sending a
   * request to the worker, and receiving a message from it.
   */
  get accessForTestingOnly(): {
    exec(type: WorkerIPCMessageType, data?: unknown): Promise<void>;
    onWorkerMessage(event: MessageEvent): void;
  } {
    return {
      exec: (type, data) => this.#exec(type, data),
      onWorkerMessage: (event) => this.#onWorkerMessage(event),
    };
  }

  /**
   * Settles when the worker is initialized: resolved once it is ready,
   * rejected with the error that stopped it.
   */
  get ready(): Promise<void> {
    return this.#initializeDeferred.promise;
  }

  /**
   * Sends the worker its `Initialize` request, carrying this controller's
   * space, toolshed, identity, and experimental options. Called once the
   * worker announces itself ready.
   *
   * @throws If the controller is not uninitialized. Also if the request
   *   fails, which leaves the controller in the `Error` state.
   */
  async startInitialize() {
    if (this.#state !== WorkerState.Uninitialized) {
      throw new Error("Worker is not uninitialized.");
    }
    this.#state = WorkerState.Initializing;
    try {
      await this.#exec(WorkerIPCMessageType.Initialize, {
        did: this.#did,
        toolshedUrl: this.#toolshedUrl,
        encodedIdentity: realmValueFromKeyPair(this.#identity.keyPair),
        experimental: this.#experimental,
      });
      this.#state = WorkerState.Ready;
    } catch (e) {
      this.#state = WorkerState.Error;
      throw e;
    }
  }

  /**
   * Runs the piece `bg` names in the worker, resolving when the run finishes.
   *
   * @throws If the worker is not ready, or if the run fails, times out, or
   *   is cut off by `shutdown()`.
   */
  async runPiece(
    bg: Cell<BGPieceEntry>,
  ): Promise<void> {
    if (this.#state !== WorkerState.Ready) {
      throw new Error("Worker not ready.");
    }
    return await this.#exec(WorkerIPCMessageType.Run, {
      pieceId: bg.get().pieceId,
    });
  }

  /**
   * Shuts the worker down: rejects every request in flight, asks the worker
   * to clean up, and terminates it, terminating even when the cleanup fails.
   *
   * @throws If a shutdown is already under way or done.
   */
  async shutdown() {
    if (
      this.#state === WorkerState.Terminating ||
      this.#state === WorkerState.Terminated
    ) {
      throw new Error(`Worker is already ${this.#state}.`);
    }
    this.#state = WorkerState.Terminating;

    for (const [_, task] of this.#pending.entries()) {
      task.deferred.reject(new Error("Worker shutting down."));
    }
    this.#pending.clear();

    try {
      await this.#exec(WorkerIPCMessageType.Cleanup);
    } catch (err) {
      console.warn(
        `Failed to shutdown worker gracefully: ${err}`,
      );
    }
    this.#worker.terminate();
    this.#state = WorkerState.Terminated;
  }

  /** Returns whether the worker is initialized and accepting runs. */
  isReady(): boolean {
    return this.#state === WorkerState.Ready;
  }

  /** Sends a message and returns a promise that resolves with the response. */
  #exec(type: WorkerIPCMessageType, data?: unknown): Promise<void> {
    const msgId = this.#msgId++;

    const message: Record<string, unknown> = {
      msgId,
      type,
    };
    if (data) {
      message.data = data;
    }
    if (!isWorkerIPCRequest(message)) {
      throw new Error("invalid IPC request.");
    }

    const deferred = defer();

    const timeout = setTimeout(() => {
      // The request has timed out. This is most likely unexpected.
      // Whatever processing is occurring in the worker graph should be
      // terminated and recreated in the future.
      deferred.reject(new Error(`Worker timed out.`));
    }, this.#timeoutMs);

    const task = {
      startTime: performance.now(),
      msgId,
      type,
      deferred,
    };
    this.#pending.set(msgId, task);

    this.#worker.postMessage(message);

    return deferred.promise.then(() => {
      this.#logTaskResults(task);
    }, (error: Error) => {
      this.#logTaskResults(task, error.message);
      throw new Error(error.message);
    }).finally(() => {
      clearTimeout(timeout);
      this.#pending.delete(msgId);
    });
  }

  /**
   * Handles one message from the worker: a `ready` starts initialization,
   * and anything else settles the pending request it answers.
   */
  #onWorkerMessage = (event: MessageEvent) => {
    const response = event.data;
    if (!isWorkerIPCResponse(response)) {
      console.error(
        `${this.#did}: Received malformed WorkerIPCResponse: ${response}`,
      );
      return;
    }

    if (response.type === "ready") {
      this.startInitialize().then(
        () => this.#initializeDeferred.resolve(),
        (error) => this.#initializeDeferred.reject(error),
      );
      return;
    }
    const pending = this.#pending.get(response.msgId);
    if (!pending) {
      console.error(
        `${this.#did}: WorkerIPCResponse does not match a request: ${response.msgId}`,
      );
      return;
    }
    if ("error" in response) {
      pending.deferred.reject(new Error(response.error));
    } else {
      pending.deferred.resolve();
    }
    this.#pending.delete(response.msgId);
  };

  /**
   * Handler for the worker's `error` event, which terminates the worker and
   * re-dispatches the error as this controller's own `error` event.
   */
  #onWorkerError = (err: ErrorEvent) => {
    console.error(`${this.#did}: Worker error:`, err);
    // If not prevented, error is rethrown in this context.
    err.preventDefault();

    // Set state to `Error`, terminating the worker immediately
    this.#state = WorkerState.Error;
    this.#worker.terminate();

    this.dispatchEvent(new WorkerControllerErrorEvent(err));
  };

  /** Logs how `task` ended, at warning level when it failed with `error`. */
  #logTaskResults(task: Task, error?: string) {
    const errorMessage = error ? `: ${error}` : "";
    const state = error ? "failed" : "completed";
    const id = `"${task.type}/${task.msgId}"`;
    const duration = (performance.now() - task.startTime).toFixed(0);
    const message =
      `${this.#did}: Worker task ${state}: ${id} (${duration}ms)${errorMessage}`;
    if (error) {
      console.warn(message);
    } else {
      console.log(message);
    }
  }
}
