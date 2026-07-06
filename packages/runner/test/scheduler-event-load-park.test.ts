import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { Action, EventHandler } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

// CT-1795: a handler must not dispatch against a provisional snapshot while a
// replica load for an address in its read closure is still in flight.
//
// The wish shape: a computation reads a cold document (the wish kicks a
// fire-and-forget pull and settles CLEAN on a provisional value), and a
// handler's closure reads through that computation's output. The graph is
// eventually correct — the load's arrival re-invalidates the computation
// through the one channel — but the handler is at-most-once (D7), so its
// dispatch must park until the closure's in-flight loads complete (a
// definitively absent doc counts as complete). The wake source is load
// completion, mirroring the lineage park's callback wake.
describe("event dispatch parks on in-flight closure loads", () => {
  let env: SchedulerTestRuntime;
  let releaseHeldSync: (() => void) | undefined;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    releaseHeldSync?.();
    await disposeSchedulerTestRuntime(env);
  });

  // Delay provider.sync for one document id until the returned release fires;
  // every other sync passes through untouched. This pins the in-flight-load
  // window deterministically instead of racing a real network.
  function holdSyncFor(id: string): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    const manager = env.storageManager as unknown as {
      open: (space: string) => {
        sync: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const originalOpen = manager.open.bind(manager);
    manager.open = (openSpace: string) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, prop, receiver) {
          if (prop === "sync") {
            return async (syncId: unknown, ...rest: unknown[]) => {
              if (syncId === id) await promise;
              return (target.sync as (...a: unknown[]) => Promise<unknown>)(
                syncId,
                ...rest,
              );
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    releaseHeldSync = resolve;
    return resolve;
  }

  it("parks the head event until the closure's load completes, then dispatches once", async () => {
    const { runtime, tx } = env;
    // The cold document (never written — the load completes "absent"), the
    // wish-like computation's output, and the event stream link.
    const coldDoc = runtime.getCell<string>(space, "load-park-cold", undefined);
    const result = runtime.getCell<string>(
      space,
      "load-park-result",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "load-park-events",
      undefined,
    );
    await tx.commit();
    env.tx = runtime.edit();

    // Wish-like computation: reads the cold doc, settles clean on a
    // provisional value while the load is still in flight.
    let computationRuns = 0;
    const wishLike: Action = (actionTx: IExtendedStorageTransaction) => {
      computationRuns++;
      const value = coldDoc.withTx(actionTx).get();
      result.withTx(actionTx).send(value ?? "");
    };
    runtime.scheduler.subscribe(wishLike, {
      reads: [toMemorySpaceAddress(coldDoc.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
    }, {});

    // Handler whose closure reads the computation's output.
    let handlerRuns = 0;
    const handler: EventHandler = (actionTx) => {
      handlerRuns++;
      result.withTx(actionTx).get();
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => {
        result.withTx(depTx).get();
      },
    );

    // The load is in flight before the event arrives (the wish's
    // fire-and-forget pull); hold it open.
    const release = holdSyncFor(coldDoc.getAsNormalizedFullLink().id);
    const loadInFlight = runtime.storageManager.syncCell(coldDoc)
      .catch(() => {});

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);

    // Let several settle passes drain. The preflight runs the (never-ran)
    // computation as an invalid upstream dep; once it settles clean the ONLY
    // thing standing between the event and dispatch is the in-flight load.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(computationRuns).toBeGreaterThanOrEqual(1);
    expect(handlerRuns, "handler must not dispatch while the load is in flight")
      .toBe(0);

    // Load completes (absent counts as complete) → the park wakes and the
    // handler dispatches exactly once.
    release();
    await loadInFlight;
    await runtime.idle();
    expect(handlerRuns).toBe(1);

    // No residual re-dispatch.
    await runtime.idle();
    expect(handlerRuns).toBe(1);
  });

  it("dispatches immediately when no closure load is in flight", async () => {
    const { runtime, tx } = env;
    const doc = runtime.getCell<string>(space, "no-load-doc", undefined);
    const eventCell = runtime.getCell<number>(
      space,
      "no-load-events",
      undefined,
    );
    await tx.commit();
    env.tx = runtime.edit();

    let handlerRuns = 0;
    const handler: EventHandler = (actionTx) => {
      handlerRuns++;
      doc.withTx(actionTx).get();
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => {
        doc.withTx(depTx).get();
      },
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await runtime.idle();
    expect(handlerRuns).toBe(1);
  });
});
