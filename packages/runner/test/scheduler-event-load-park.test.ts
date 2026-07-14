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

  function observeNextLoadPark(): Promise<void> {
    const manager = env.storageManager as unknown as {
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    const original = manager.loadsSettled.bind(manager);
    const observed = Promise.withResolvers<void>();
    manager.loadsSettled = (keys) => {
      observed.resolve();
      return original(keys);
    };
    return observed.promise;
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
    const loadParkObserved = observeNextLoadPark();

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);

    // The preflight runs the never-ran computation first. On the following
    // pass it registers the load park; observe that explicit barrier instead
    // of assuming a fixed amount of wall-clock time is enough.
    await Promise.race([
      loadParkObserved,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `load park was not reached (computations=${computationRuns}, handlers=${handlerRuns})`,
              ),
            ),
          2_000,
        )
      ),
    ]);
    expect(computationRuns).toBeGreaterThanOrEqual(1);
    expect(handlerRuns, "handler must not dispatch while the load is in flight")
      .toBe(0);

    // An unrelated scheduler wake while the load is still pending must observe
    // the parked head rather than re-running its dependency preflight or
    // dispatching through it.
    const schedulerHarness = runtime.scheduler as unknown as {
      execute(): Promise<void>;
    };
    const originalExecute = schedulerHarness.execute.bind(runtime.scheduler);
    const rerunCompleted = Promise.withResolvers<void>();
    schedulerHarness.execute = async () => {
      try {
        await originalExecute();
      } finally {
        rerunCompleted.resolve();
      }
    };
    try {
      runtime.scheduler.queueExecution();
      await rerunCompleted.promise;
    } finally {
      schedulerHarness.execute = originalExecute;
    }
    expect(handlerRuns, "a scheduler re-tick must keep the parked head blocked")
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

  it("drops once when a required load fails instead of dispatching fail-open", async () => {
    const { runtime, tx } = env;
    const coldDoc = runtime.getCell<string>(
      space,
      "load-park-failure-cold",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "load-park-failure-event",
      undefined,
    );
    await tx.commit();
    env.tx = runtime.edit();

    let handlerRuns = 0;
    let callbackRuns = 0;
    let callbackStatus: string | undefined;
    const handler: EventHandler = () => {
      handlerRuns++;
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => coldDoc.withTx(depTx).get(),
    );

    const link = coldDoc.getAsNormalizedFullLink();
    const key = `${link.space}/${link.scope}/${link.id}`;
    const load = Promise.withResolvers<void>();
    const parkObserved = Promise.withResolvers<void>();
    const manager = runtime.storageManager as unknown as {
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
      pendingLoadGeneration(key: string): number | undefined;
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    manager.pendingLoadAddresses = () => [{
      space: link.space,
      scope: link.scope,
      id: link.id,
    }];
    manager.pendingLoadGeneration = (candidate) =>
      candidate === key ? 1 : undefined;
    manager.loadsSettled = () => {
      parkObserved.resolve();
      return load.promise;
    };

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      true,
      (commitTx) => {
        callbackRuns++;
        callbackStatus = commitTx.status().status;
      },
    );
    await parkObserved.promise;
    expect(handlerRuns).toBe(0);

    load.reject(new Error("replica unavailable"));
    await runtime.idle();
    expect(handlerRuns).toBe(0);
    expect(callbackRuns).toBe(1);
    expect(callbackStatus).toBe("error");
    await runtime.idle();
    expect(callbackRuns).toBe(1);
  });

  it("re-parks the same event for a fresh load generation", async () => {
    const { runtime, tx } = env;
    const coldDoc = runtime.getCell<string>(
      space,
      "load-park-generation-cold",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "load-park-generation-event",
      undefined,
    );
    await tx.commit();
    env.tx = runtime.edit();

    let handlerRuns = 0;
    const handler: EventHandler = () => {
      handlerRuns++;
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => coldDoc.withTx(depTx).get(),
    );

    const link = coldDoc.getAsNormalizedFullLink();
    const key = `${link.space}/${link.scope}/${link.id}`;
    let generation = 1;
    let pending = true;
    const waits = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const parks = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    let parkCount = 0;
    const manager = runtime.storageManager as unknown as {
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
      pendingLoadGeneration(key: string): number | undefined;
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    manager.pendingLoadAddresses = () =>
      pending ? [{ space: link.space, scope: link.scope, id: link.id }] : [];
    manager.pendingLoadGeneration = (candidate) =>
      pending && candidate === key ? generation : undefined;
    manager.loadsSettled = () => {
      const index = parkCount++;
      parks[index]?.resolve();
      return waits[index]!.promise;
    };

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await parks[0].promise;
    expect(handlerRuns).toBe(0);

    // A distinct generation begins before the first park releases. The event
    // history must compare generations, not permanently whitelist this key.
    generation = 2;
    waits[0].resolve();
    await parks[1].promise;
    expect(handlerRuns).toBe(0);
    expect(parkCount).toBe(2);

    pending = false;
    waits[1].resolve();
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

  // F4d: loadsSettled counts remaining by keys.length but adds a single shared
  // onSettled callback to each entry's waiter Set, which fires once per settled
  // entry. A duplicated key inflates the count without adding a matching
  // callback, so remaining never reaches zero and the promise hangs.
  it("loadsSettled resolves when keys contains a duplicate", async () => {
    const { runtime, tx } = env;
    const coldDoc = runtime.getCell<string>(
      space,
      "loads-settled-dupe",
      undefined,
    );
    await tx.commit();
    env.tx = runtime.edit();

    const storage = runtime.storageManager as unknown as {
      loadsSettled(keys: readonly string[]): Promise<void>;
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
    };

    // Pin one in-flight load for the cold doc so a pending-load entry exists.
    const release = holdSyncFor(coldDoc.getAsNormalizedFullLink().id);
    const loadInFlight = runtime.storageManager.syncCell(coldDoc).catch(
      () => {},
    );
    // Let the synchronous pending-load registration settle onto the map.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const addresses = storage.pendingLoadAddresses();
    expect(addresses.length).toBe(1);
    const { space: s, scope, id } = addresses[0];
    const key = `${s}/${scope}/${id}`;

    // Wait on the same key twice; a correct loadsSettled dedupes and resolves.
    const settled = storage.loadsSettled([key, key]);

    release();
    await loadInFlight;

    const timedOut = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), 500);
    });
    const outcome = await Promise.race([
      settled.then(() => "settled" as const),
      timeout,
    ]);
    clearTimeout(timer!);
    expect(outcome).toBe("settled");
  });
});
