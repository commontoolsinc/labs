import { BGCharmEntry } from "./schema.ts";
import { Cell } from "@commontools/runner";
import { Identity } from "@commontools/identity";
import { defer, type Deferred } from "@commontools/utils/defer";
import {
  isWorkerIPCResponse,
  WorkerIPCMessageType,
  WorkerIPCRequest,
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
}

export class WorkerControllerErrorEvent extends Event {
  error?: ErrorEvent;
  constructor(cause?: ErrorEvent) {
    super("error");
    this.error = cause;
  }
}

/**
 * @event error A terminal error occurred in the worker.
 */
export class WorkerController extends EventTarget {
  private worker: Worker;
  private did: string;
  private toolshedUrl: string;
  private identity: Identity;
  private timeoutMs: number;
  private msgId: number = 0;
  private pending = new Map<number, Deferred<void>>();
  private state = WorkerState.Uninitialized;

  constructor(options: WorkerOptions) {
    super();
    this.did = options.did;
    this.identity = options.identity;
    this.toolshedUrl = options.toolshedUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TASK_TIMEOUT;

    console.log(`${this.did}: Creating worker controller`);

    this.worker = new Worker(
      new URL("./worker.ts", import.meta.url).href,
      {
        type: "module",
        name: `worker-${this.did}`,
      },
    );
    this.worker.addEventListener("message", this.onWorkerMessage);
    this.worker.addEventListener("error", this.onWorkerError);
  }

  async initialize() {
    if (this.state !== WorkerState.Uninitialized) {
      throw new Error("Worker is not uninitialized.");
    }
    this.state = WorkerState.Initializing;
    try {
      console.log(`WORKER INITIALIZATION MESSAGE FOR ${this.did}`);
      await this.exec(WorkerIPCMessageType.Initialize, {
        did: this.did,
        toolshedUrl: this.toolshedUrl,
        rawIdentity: this.identity.serialize(),
      });
      this.state = WorkerState.Ready;
    } catch (e) {
      this.state = WorkerState.Error;
      throw e;
    }
  }

  async runCharm(
    bg: Cell<BGCharmEntry>,
  ): Promise<void> {
    if (this.state !== WorkerState.Ready) {
      throw new Error("Worker not ready.");
    }
    return await this.exec(WorkerIPCMessageType.Run, {
      charmId: bg.get().charmId,
    });
  }

  async shutdown() {
    if (
      this.state === WorkerState.Terminating ||
      this.state === WorkerState.Terminated
    ) {
      throw new Error(`Worker is already ${this.state}.`);
    }
    this.state = WorkerState.Terminating;

    for (const [_, deferred] of this.pending.entries()) {
      deferred.reject(new Error("Worker shutting down."));
    }
    this.pending.clear();

    try {
      await this.exec(WorkerIPCMessageType.Cleanup);
    } catch (err) {
      console.warn(
        `Failed to shutdown worker gracefully: ${err}`,
      );
    }
    this.worker.terminate();
    this.state = WorkerState.Terminated;
  }

  isReady(): boolean {
    return this.state === WorkerState.Ready;
  }

  // send a message and return a promise that resolves with the response
  private exec(type: WorkerIPCMessageType, data?: any): Promise<void> {
    const msgId = this.msgId++;
    const message: WorkerIPCRequest = {
      msgId,
      type,
      data,
    };

    const deferred = defer<void, Error>();

    const timeout = setTimeout(() => {
      // The request has timed out. This is most likely unexpected.
      // Whatever processing is occurring in the worker graph should be
      // terminated and recreated in the future.
      deferred.reject(new Error(`Worker timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    this.pending.set(msgId, deferred);

    this.worker.postMessage(message);

    return deferred.promise.finally(() => {
      clearTimeout(timeout);
      this.pending.delete(msgId);
    });
  }

  private onWorkerMessage = (event: MessageEvent) => {
    const response = event.data;
    if (!isWorkerIPCResponse(response)) {
      console.error(
        `${this.did}: Received malformed WorkerIPCResponse: ${response}`,
      );
      return;
    }
    const pending = this.pending.get(response.msgId);
    if (!pending) {
      console.error(
        `${this.did}: WorkerIPCResponse does not match a request: ${response.msgId}`,
      );
      return;
    }
    if ("error" in response) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve();
    }
    this.pending.delete(response.msgId);
  };

  private onWorkerError = (err: ErrorEvent) => {
    console.error(`${this.did}: Worker error:`, err);
    // If not prevented, error is rethrown in this context.
    err.preventDefault();

    // Set state to `Error`, terminating the worker immediately
    this.state = WorkerState.Error;
    this.worker.terminate();

    this.dispatchEvent(new WorkerControllerErrorEvent(err));
  };
}
