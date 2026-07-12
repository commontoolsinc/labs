import * as Engine from "../../v2/engine.ts";

type LeaseWorkerCommand =
  | {
    type: "init";
    store: string;
    space: string;
    hostId: string;
    onBehalfOf: string;
    nowMs: number;
    ttlMs: number;
  }
  | { type: "go" }
  | { type: "close" };

let engine: Engine.Engine | undefined;
let acquisition:
  | Omit<
    Extract<LeaseWorkerCommand, { type: "init" }>,
    "type" | "store"
  >
  | undefined;

self.onmessage = async (event: MessageEvent<LeaseWorkerCommand>) => {
  try {
    switch (event.data.type) {
      case "init": {
        if (engine !== undefined) {
          throw new Error("lease Worker already opened");
        }
        const { store, ...options } = event.data;
        engine = await Engine.open({ url: new URL(store) });
        acquisition = options;
        self.postMessage({ type: "ready" });
        break;
      }
      case "go": {
        if (engine === undefined || acquisition === undefined) {
          throw new Error(
            "lease Worker must be initialized before acquisition",
          );
        }
        const lease = Engine.acquireExecutionLease(engine, {
          ...acquisition,
          branch: "",
          authorizeWrite: () => true,
        });
        self.postMessage({ type: "result", lease });
        break;
      }
      case "close": {
        if (engine !== undefined) {
          Engine.close(engine);
          engine = undefined;
        }
        self.postMessage({ type: "closed" });
        break;
      }
    }
  } catch (cause) {
    self.postMessage({
      type: "error",
      message: cause instanceof Error ? cause.message : String(cause),
      stack: cause instanceof Error ? cause.stack : undefined,
    });
  }
};

self.postMessage({ type: "booted" });
