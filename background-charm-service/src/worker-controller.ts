import { BGCharmEntry } from "@commontools/utils";
import { Cell } from "@commontools/runner";
import { log } from "./utils.ts";
import { Identity } from "@commontools/identity";
import { defer, type Deferred } from "@commontools/utils/defer";

const DEFAULT_TASK_TIMEOUT = 60_000;

type PendingResponse = {
  resolve: (result: any) => void;
  reject: (error: any) => void;
};

export interface WorkerOptions {
  did: string;
  toolshedUrl: string;
  identity: Identity;
  timeoutMs?: number;
}

export class WorkerController {
  private worker: Worker;
  private did: string;
  private toolshedUrl: string;
  private identity: Identity;
  private timeoutMs: number;
  private msgId: number = 0;
  private pending = new Map<number, PendingResponse>();
  private ready: boolean = false;
  private initDeferred?: Deferred<void>;

  constructor(options: WorkerOptions) {
    this.did = options.did;
    this.identity = options.identity;
    this.toolshedUrl = options.toolshedUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TASK_TIMEOUT;

    log(`${this.did} Creating worker controller`);

    this.worker = new Worker(
      new URL("./worker.ts", import.meta.url).href,
      {
        type: "module",
        name: `worker-${this.did}`,
      },
    );
    this.connectWorker();
  }

  private connectWorker() {
    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { msgId: number; result: any } | {
        msgId: number;
        error: string;
      } | undefined;
      if (!data) {
        log(`${this.did}: Received response with no data`, {
          error: true,
        });
        return;
      }
      if (typeof data.msgId !== "number") {
        log(
          `${this.did}: Received response with no msgId ${
            JSON.stringify(data)
          }`,
          {
            error: true,
          },
        );
        return;
      }
      const pending = this.pending.get(data.msgId);
      if (!pending) {
        log(
          `${this.did}: Received response with missing pending promise ${data.msgId}`,
          {
            error: true,
          },
        );
        return;
      }
      if ("error" in data) {
        pending.reject(new Error(data.error));
      } else {
        pending.resolve(data.result);
      }
      this.pending.delete(data.msgId);
    };

    // FIXME(ja): what should we do if the worker is erroring?
    // perhaps restart the worker?
    this.worker.onerror = (err) => {
      log(`${this.did}: Worker error:`, { error: true }, err);
      // If not prevented, error is rethrown in this context.
      err.preventDefault();
    };
  }

  async initialize() {
    if (this.initDeferred) {
      return this.initDeferred.promise;
    }
    this.initDeferred = defer();
    try {
      await this.exec("setup", {
        did: this.did,
        toolshedUrl: this.toolshedUrl,
        rawIdentity: this.identity.serialize(),
      });
      this.initDeferred.resolve();
      this.ready = true;
    } catch (e) {
      this.initDeferred.reject(
        new Error(`Failed to initialize Worker: ${e ? e.toString() : e}`),
      );
    }
    return this.initDeferred;
  }

  runCharm(
    bg: Cell<BGCharmEntry>,
  ): Promise<{ success: boolean; data?: any; charmId: string }> {
    return this.exec("runCharm", { charmId: bg.get().charmId });
  }

  async shutdown() {
    try {
      await this.exec("shutdown");
    } catch (err) {
      log(
        "Failed to shutdown worker gracefully, terminating with unknown status.",
      );
      this.worker?.terminate();
    }
  }

  // send a message and return a promise that resolves with the response
  private exec(type: string, data?: any): Promise<any> {
    // Only allow "setup" calls when not ready
    if (type !== "setup" && !this.ready) {
      return Promise.reject(new Error("Worker not initialized"));
    }
    const msgId = this.msgId++;

    const deferred = defer<any, Error>();

    const timeout = setTimeout(() => {
      deferred.reject(new Error(`Worker timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    this.pending.set(msgId, deferred);

    this.worker.postMessage({ msgId, type, data });

    return deferred.promise.finally(() => {
      clearTimeout(timeout);
      this.pending.delete(msgId);
    });
  }
}
