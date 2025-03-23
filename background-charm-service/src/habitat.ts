import { BGCharmEntry, sleep } from "@commontools/utils";
import { Cell } from "@commontools/runner";

type PendingResponse = {
  resolve: (result: any) => void;
  reject: (error: any) => void;
};

export class Habitat {
  private did: string;
  private worker: Worker;
  private msgId: number = 0;
  private pending = new Map<number, PendingResponse>();
  private timeoutMs: number = 10000;
  private ready: boolean = false;

  constructor(did: string, toolshedUrl: string, operatorPass: string) {
    console.log(`Creating habitat ${did}`);
    this.did = did;

    this.worker = new Worker(
      new URL("./worker.ts", import.meta.url).href,
      {
        type: "module",
        name: `habitat-${this.did}`,
      },
    );
    this.connectWorker();
    this.setupWorker(toolshedUrl, operatorPass);
  }

  private connectWorker() {
    this.worker.onmessage = (event: MessageEvent) => {
      const { id, result, error } = event.data || {};
      if (typeof id !== "number") return;
      const pending = this.pending.get(id);
      if (!pending) return;
      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(result);
      }
      this.pending.delete(id);
    };

    this.worker.onerror = (err) => {
      console.error(`Worker error in habitat ${this.did}:`, err);
      // Reject all pending promises.
      this.pending.forEach(({ reject }, id) => {
        reject(err);
        this.pending.delete(id);
      });
    };
  }

  private setupWorker(toolshedUrl: string, operatorPass: string) {
    this.call("setup", {
      did: this.did,
      toolshed_url: toolshedUrl,
      operator_pass: operatorPass,
    }).catch((err) => {
      console.error(`Failed to setup habitat ${this.did}:`, err);
    }).then(() => {
      this.ready = true;
    });
  }

  // send a message and return a promise that resolves with the response
  call(type: string, data?: any): Promise<any> {
    if (type !== "setup" && !this.ready) {
      return Promise.reject(new Error("Worker not initialized"));
    }
    const id = this.msgId++;

    this.worker.postMessage({ id, type, data });

    return new Promise((resolve, reject) => {
      // Set up a timeout in case the worker doesn't respond
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker timed out executing ${type}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (result: any) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error: any) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  runCharm(
    charm: Cell<BGCharmEntry>,
  ): Promise<{ success: boolean; data?: any }> {
    return this.call("runCharm", { charm: charm.get() });
  }

  shutdown() {
    return this.call("shutdown").catch(() => {
      console.log(
        "Failed to shutdown habitat gracefully, terminating with unknown status.",
      );
    }).finally(() => {
      this.worker?.terminate();
    });
  }
}
