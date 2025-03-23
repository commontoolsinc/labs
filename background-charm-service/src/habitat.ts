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
  public ready: boolean = false;

  constructor(did: string) {
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

  public setupWorker(toolshedUrl: string, operatorPass: string) {
    return this.call("setup", {
      did: this.did,
      toolshed_url: toolshedUrl,
      operator_pass: operatorPass,
    }).catch((err) => {
      console.error(`Habitat ${this.did} worker setup failed:`, err);
    }).then(() => {
      this.ready = true;
      console.log(`Habitat ${this.did} ready for work`);
    });
  }

  // send a message and return a promise that resolves with the response
  private call(type: string, data?: any): Promise<any> {
    // Only allow "setup" calls when not ready
    if (type !== "setup" && !this.ready) {
      return Promise.reject(new Error("Worker not initialized"));
    }
    const id = this.msgId++;

    this.worker.postMessage({ id, type, data });

    return new Promise((resolve, reject) => {
      // Set up a timeout in case the worker doesn't respond
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker timed out while calling ${type}`));
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

  public runCharm(
    charm: Cell<BGCharmEntry>,
  ): Promise<{ success: boolean; data?: any }> {
    return this.call("runCharm", { charm: charm.get().charmId });
  }

  public shutdown() {
    return this.call("shutdown").catch(() => {
      console.log(
        "Failed to shutdown habitat gracefully, terminating with unknown status.",
      );
    }).finally(() => {
      this.worker?.terminate();
    });
  }
}
