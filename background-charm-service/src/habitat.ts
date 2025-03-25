import { BGCharmEntry, sleep } from "@commontools/utils";
import { Cell } from "@commontools/runner";
import { defer } from "@commontools/utils";
import { log } from "./utils.ts";

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
    log(`Creating habitat ${did}`);
    this.did = did;

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
      log(`${this.did}: Worker error:`, err, {
        error: true,
      });
    };
  }

  public setupWorker(toolshedUrl: string, operatorPass: string) {
    return this.call("setup", {
      did: this.did,
      toolshed_url: toolshedUrl,
      operator_pass: operatorPass,
    }).catch((err) => {
      log(`Habitat ${this.did} worker setup failed:`, err, {
        error: true,
      });
    }).then(() => {
      this.ready = true;
      log(`Habitat ${this.did} ready for work`);
    });
  }

  // send a message and return a promise that resolves with the response
  private call(type: string, data?: any): Promise<any> {
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

  public runCharm(
    bg: Cell<BGCharmEntry>,
  ): Promise<{ success: boolean; data?: any; charmId: string }> {
    return this.call("runCharm", { charmId: bg.get().charmId });
  }

  public shutdown() {
    return this.call("shutdown").catch(() => {
      log(
        "Failed to shutdown habitat gracefully, terminating with unknown status.",
      );
    }).finally(() => {
      this.worker?.terminate();
    });
  }
}
