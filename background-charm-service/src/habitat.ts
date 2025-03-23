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

  constructor(did: string) {
    this.did = did;

    console.log(`Creating habitat ${did}`);
    // Create a dedicated worker for this habitat.
    this.worker = new Worker(
      new URL("./worker.ts", import.meta.url).href,
      {
        type: "module",
        name: `habitat-${did}`,
      },
    );
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
    this.send("init", { did: this.did });
  }

  send(type: string, data?: any) {
    const id = this.msgId++;
    this.worker.postMessage({ id, type, data });
    return id;
  }

  runCharm(
    charm: Cell<BGCharmEntry>,
  ): Promise<{ success: boolean; data?: any }> {
    console.log(`Running charm ${charm.get().charmId}`);
    const id = this.send("runCharm", { charm: charm.get() });
    return new Promise((resolve, reject) => {
      // Set up a timeout in case the worker doesn't respond.
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker timed out executing charm ${charm.charmId}`));
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

  shutdown(timeoutMs: number = 5000): Promise<void> {
    const id = this.send("shutdown");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // If the worker doesn't respond in time, force terminate.
        this.worker.terminate();
        reject(
          new Error(
            `Worker did not shutdown gracefully within ${timeoutMs}ms, force terminated.`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timeout);
          // After graceful shutdown, terminate the worker.
          this.worker.terminate();
          resolve();
        },
        reject: (err: any) => {
          clearTimeout(timeout);
          this.worker.terminate();
          reject(err);
        },
      });
    });
  }
}
