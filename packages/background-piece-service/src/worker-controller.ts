import { Identity, realmValueFromKeyPair } from "@commonfabric/identity";
import { Cell } from "@commonfabric/runner";
import { defer, type Deferred } from "@commonfabric/utils/defer";

import { BGPieceEntry } from "./schema.ts";
import {
  isWorkerIPCRequest,
  isWorkerIPCResponse,
  WorkerIPCMessageType,
} from "./worker-ipc.ts";

const DEFAULT_TASK_TIMEOUT = 60_000;

export enum WorkerState {
  Uninitialized = "uninitialized",
  Initializing = "initializing",
  Ready = "ready",
  Terminating = "terminating",
  Terminated = "terminated",
  Error = "error",
}

export interface WorkerOptions {
  did: string;
  toolshedUrl: string;
  identity: Identity;
  timeoutMs?: number;
  experimental?: {
    modernCellRep?: boolean;
  };
}

export class WorkerControllerErrorEvent extends Event {
  error?: ErrorEvent;
  constructor(cause?: ErrorEvent) {
    super("error");
    this.error = cause;
  }
}

interface Task {
  msgId: number;
  startTime: number;
  type: WorkerIPCMessageType;
  deferred: Deferred;
}

/**
 * @event error A terminal error occurred in the worker.
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

  /** Promise that resolves when the worker is fully initialized. */
  public initializeResolve = this.#initializeDeferred.promise;

  #state = WorkerState.Uninitialized;

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

  isReady(): boolean {
    return this.#state === WorkerState.Ready;
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

  #onWorkerError = (err: ErrorEvent) => {
    console.error(`${this.#did}: Worker error:`, err);
    // If not prevented, error is rethrown in this context.
    err.preventDefault();

    // Set state to `Error`, terminating the worker immediately
    this.#state = WorkerState.Error;
    this.#worker.terminate();

    this.dispatchEvent(new WorkerControllerErrorEvent(err));
  };

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
