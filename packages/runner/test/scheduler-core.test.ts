// Core scheduler tests: basic scheduling, event handling, reactive retries,
// and stream event success callbacks.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Action,
  type EventHandler,
  ignoreReadForScheduling,
  txToReactivityLog,
} from "../src/scheduler.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Entity } from "@commonfabric/memory/interface";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("scheduler", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for basic scheduler tests (tests push-mode behavior)
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should run actions when cells change", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should run actions when cells change 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should run actions when cells change 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should run actions when cells change 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);
    a.withTx(tx).send(2); // Simulate external change
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("schedule shouldn't run immediately", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, {
      reads: [
        a.getAsNormalizedFullLink(),
        b.getAsNormalizedFullLink(),
      ],
      shallowReads: [],
      writes: [c.getAsNormalizedFullLink()],
    }, {});
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2); // No log, simulate external change
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should re-run an async read-only effect when invalidated while paused", async () => {
    const source = runtime.getCell<number>(
      space,
      "paused-read-only-effect-source",
      undefined,
      tx,
    );
    source.set(0);
    await tx.commit();
    tx = runtime.edit();

    const seen: number[] = [];
    let runCount = 0;
    let startedResolve = () => {};
    let started = Promise.resolve();
    let allowResolve = () => {};
    let allowFinish = Promise.resolve();

    const effect: Action = async (actionTx) => {
      runCount++;
      const value = source.withTx(actionTx).get();
      if (runCount === 2) {
        startedResolve();
        await allowFinish;
      }
      seen.push(value);
    };

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [source.getAsNormalizedFullLink()],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    expect(seen).toEqual([0]);

    started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    allowFinish = new Promise((resolve) => {
      allowResolve = resolve;
    });

    source.withTx(tx).send(1);
    await tx.commit();
    tx = runtime.edit();

    await started;

    const conflictingTx = runtime.edit();
    source.withTx(conflictingTx).send(2);
    await conflictingTx.commit();

    allowResolve();

    await runtime.scheduler.idle();

    expect(seen).toEqual([0, 1, 2]);
  });

  it("captures trigger trace for a change and downstream scheduled effects", async () => {
    runtime.scheduler.enablePullMode();

    const a = runtime.getCell<number>(
      space,
      "captures trigger trace source",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "captures trigger trace intermediate",
      undefined,
      tx,
    );
    b.set(0);
    const c = runtime.getCell<number>(
      space,
      "captures trigger trace sink",
      undefined,
      tx,
    );
    c.set(0);
    await tx.commit();
    tx = runtime.edit();

    function computeIntermediate(tx: IExtendedStorageTransaction) {
      b.withTx(tx).send(
        (a.withTx(tx).get() ?? 0) + 1,
      );
    }

    function effectSink(tx: IExtendedStorageTransaction) {
      c.withTx(tx).send(
        b.withTx(tx).get() ?? 0,
      );
    }

    runtime.scheduler.subscribe(
      computeIntermediate,
      {
        reads: [a.getAsNormalizedFullLink()],
        shallowReads: [],
        writes: [b.getAsNormalizedFullLink()],
      },
      { changeGroup: "compute-intermediate-change-group" },
    );
    runtime.scheduler.subscribe(
      effectSink,
      {
        reads: [b.getAsNormalizedFullLink()],
        shallowReads: [],
        writes: [c.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );

    await c.pull();
    expect(c.get()).toBe(2);

    runtime.scheduler.setTriggerTraceEnabled(false);
    runtime.scheduler.setTriggerTraceEnabled(true);

    a.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await c.pull();

    const trace = runtime.scheduler.getTriggerTrace();
    const matchingEntry = trace.find((entry) =>
      entry.triggered.some((record) =>
        record.actionId === "computeIntermediate" &&
        record.decision === "mark-dirty" &&
        record.scheduledEffects.some((effect) =>
          effect.actionId === "effectSink"
        )
      )
    );

    expect(trace.length).toBeGreaterThan(0);
    expect(matchingEntry).toBeDefined();
    const intermediateEntityId = b.getAsNormalizedFullLink().id;
    expect(
      trace.some((entry) =>
        entry.entityId === intermediateEntityId &&
        entry.writerActionId === "computeIntermediate"
      ),
      "captures writer action IDs outside diagnosis mode",
    ).toBe(true);
  });

  it("captures exact action runs for one reactive update", async () => {
    runtime.scheduler.enablePullMode();

    const a = runtime.getCell<number>(
      space,
      "captures action run trace source",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "captures action run trace intermediate",
      undefined,
      tx,
    );
    b.set(0);
    const c = runtime.getCell<number>(
      space,
      "captures action run trace sink",
      undefined,
      tx,
    );
    c.set(0);
    await tx.commit();
    tx = runtime.edit();

    function computeIntermediate(tx: IExtendedStorageTransaction) {
      b.withTx(tx).send(
        (a.withTx(tx).get() ?? 0) + 1,
      );
    }

    function effectSink(tx: IExtendedStorageTransaction) {
      c.withTx(tx).send(
        b.withTx(tx).get() ?? 0,
      );
    }

    runtime.scheduler.subscribe(
      computeIntermediate,
      {
        reads: [a.getAsNormalizedFullLink()],
        shallowReads: [],
        writes: [b.getAsNormalizedFullLink()],
      },
    );
    runtime.scheduler.subscribe(
      effectSink,
      {
        reads: [b.getAsNormalizedFullLink()],
        shallowReads: [],
        writes: [c.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );

    await c.pull();
    expect(c.get()).toBe(2);

    runtime.scheduler.setActionRunTraceEnabled(false);
    runtime.scheduler.setActionRunTraceEnabled(true);

    a.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await c.pull();

    const trace = runtime.scheduler.getActionRunTrace();
    const computeRuns = trace.filter((entry) =>
      entry.actionId === "computeIntermediate"
    );
    const effectRuns = trace.filter((entry) => entry.actionId === "effectSink");

    expect(trace.length).toBeGreaterThanOrEqual(2);
    expect(computeRuns.length).toBeGreaterThanOrEqual(1);
    expect(effectRuns.length).toBeGreaterThanOrEqual(1);
    expect(computeRuns.at(-1)?.actionType).toBe("computation");
    expect(effectRuns.at(-1)?.actionType).toBe("effect");
    expect(computeRuns.at(-1)?.declaredWrites.length).toBe(1);
    expect(effectRuns.at(-1)?.declaredWrites.length).toBe(1);
    expect(computeRuns.at(-1)?.actualWrites).toEqual(
      computeRuns.at(-1)?.declaredWrites,
    );
    expect(effectRuns.at(-1)?.actualWrites).toEqual(
      effectRuns.at(-1)?.declaredWrites,
    );
    expect(computeRuns.at(-1)?.declaredWrites[0]).toMatchObject({
      space,
      entityId: expect.stringMatching(/^of:/),
      path: [],
    });
    expect(effectRuns.at(-1)?.declaredWrites[0]).toMatchObject({
      space,
      entityId: expect.stringMatching(/^of:/),
      path: [],
    });
  });

  it("falls back to value-path write details for non-JSON diagnostics", () => {
    const scheduler = runtime.scheduler as any;
    const write = {
      space,
      id: "scheduler-non-json-value-fallback",
      type: "text/plain",
      path: ["body"],
    };
    const details = new Map<string, unknown>([[
      scheduler.makeAddressKey({
        ...write,
        path: ["value", "body"],
      }),
      "hello",
    ]]);

    expect(scheduler.lookupComparableWriteValue(details, write)).toBe("hello");
  });

  it("should remove actions", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should remove actions 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should remove actions 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should remove actions 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);

    runtime.scheduler.unsubscribe(adder);
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("scheduler should return a cancel function", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const cancel = runtime.scheduler.subscribe(adder, {
      reads: [
        a.getAsNormalizedFullLink(),
        b.getAsNormalizedFullLink(),
      ],
      shallowReads: [],
      writes: [c.getAsNormalizedFullLink()],
    }, {});
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
    cancel();
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should run actions in topological order", async () => {
    const runs: string[] = [];
    const a = runtime.getCell<number>(
      space,
      "should run actions in topological order 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should run actions in topological order 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should run actions in topological order 3",
      undefined,
      tx,
    );
    c.set(0);
    const d = runtime.getCell<number>(
      space,
      "should run actions in topological order 4",
      undefined,
      tx,
    );
    d.set(1);
    const e = runtime.getCell<number>(
      space,
      "should run actions in topological order 5",
      undefined,
      tx,
    );
    e.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder1: Action = (tx) => {
      runs.push("adder1");
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const adder2: Action = (tx) => {
      runs.push("adder2");
      e.withTx(tx).send(
        c.withTx(tx).get() + d.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder1, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await e.pull();
    runtime.scheduler.subscribe(adder2, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await e.pull();
    expect(runs.join(",")).toBe("adder1,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(4);

    d.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await e.pull();
    expect(runs.join(",")).toBe("adder1,adder2,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(5);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await e.pull();
    expect(runs.join(",")).toBe("adder1,adder2,adder2,adder1,adder2");
    expect(c.get()).toBe(4);
    expect(e.get()).toBe(6);
  });

  it("should stop eventually when encountering infinite loops", async () => {
    let maxRuns = 120; // More than the limit in scheduler
    const a = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 3",
      undefined,
      tx,
    );
    c.set(0);
    const d = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 4",
      undefined,
      tx,
    );
    d.set(1);
    const e = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 5",
      undefined,
      tx,
    );
    e.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder1: Action = (tx) => {
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const adder2: Action = (tx) => {
      e.withTx(tx).send(
        c.withTx(tx).get() + d.withTx(tx).get(),
      );
    };
    const adder3: Action = (tx) => {
      if (--maxRuns <= 0) return;
      c.withTx(tx).send(
        e.withTx(tx).get() + b.withTx(tx).get(),
      );
    };

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    runtime.scheduler.subscribe(adder1, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await e.pull();
    runtime.scheduler.subscribe(adder2, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await e.pull();
    runtime.scheduler.subscribe(adder3, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await e.pull();

    await e.pull();

    expect(maxRuns).toBeGreaterThan(10);
    assertSpyCall(stopped, 0, undefined);
  });

  it("should not loop on r/w changes on its own output", async () => {
    const counter = runtime.getCell<number>(
      space,
      "should not loop on r/w changes on its own output 1",
      undefined,
      tx,
    );
    counter.set(0);
    const by = runtime.getCell<number>(
      space,
      "should not loop on r/w changes on its own output 2",
      undefined,
      tx,
    );
    by.set(1);
    tx.commit();
    tx = runtime.edit();
    const inc: Action = (tx) =>
      counter
        .withTx(tx)
        .send(counter.withTx(tx).get() + by.withTx(tx).get());

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    runtime.scheduler.subscribe(inc, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await counter.pull();
    expect(counter.get()).toBe(1);
    await counter.pull();
    expect(counter.get()).toBe(1);

    by.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await counter.pull();
    expect(counter.get()).toBe(3);

    assertSpyCalls(stopped, 0);
  });

  it("should ignore its own optimistic commit notifications but react to external commits", async () => {
    let runCount = 0;
    const counter = runtime.getCell<number>(
      space,
      "self-commit-ignore-counter",
      undefined,
      tx,
    );
    counter.set(0);
    const step = runtime.getCell<number>(
      space,
      "self-commit-ignore-step",
      undefined,
      tx,
    );
    step.set(1);
    await tx.commit();
    tx = runtime.edit();

    const increment: Action = (actionTx) => {
      runCount++;
      counter.withTx(actionTx).send(
        counter.withTx(actionTx).get() + step.withTx(actionTx).get(),
      );
    };

    runtime.scheduler.subscribe(
      increment,
      {
        reads: [
          counter.getAsNormalizedFullLink(),
          step.getAsNormalizedFullLink(),
        ],
        shallowReads: [],
        writes: [counter.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();
    expect(runCount).toBe(1);
    expect(counter.get()).toBe(1);

    counter.withTx(tx).send(10);
    await tx.commit();
    tx = runtime.edit();

    await runtime.scheduler.idle();
    expect(runCount).toBe(2);
    expect(counter.get()).toBe(11);
  });

  it("should immediately run actions that have no dependencies", async () => {
    let runs = 0;
    const inc: Action = () => runs++;
    runtime.scheduler.subscribe(inc, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {
      isEffect: true,
    });
    await runtime.idle();
    expect(runs).toBe(1);
  });

  it("should not create dependencies when using getRaw with ignoreReadForScheduling", async () => {
    // Create a source cell that will be read with ignored metadata
    const sourceCell = runtime.getCell<{ value: number }>(
      space,
      "source-cell-for-ignore-test",
      undefined,
      tx,
    );
    sourceCell.set({ value: 1 });

    // Create a result cell to track action runs (avoiding self-dependencies)
    const resultCell = runtime.getCell<{ count: number; lastValue: any }>(
      space,
      "result-cell-for-ignore-test",
      undefined,
      tx,
    );
    resultCell.set({ count: 0, lastValue: null });
    tx.commit();
    tx = runtime.edit();

    let actionRunCount = 0;
    let lastReadValue: any;

    // Action that ONLY uses ignored reads
    const ignoredReadAction: Action = (actionTx) => {
      actionRunCount++;

      // Read with ignoreReadForScheduling - should NOT create dependency
      lastReadValue = sourceCell.withTx(actionTx).getRaw({
        meta: ignoreReadForScheduling,
      });

      // Write to result cell to track that the action ran
      resultCell.withTx(actionTx).set({
        count: actionRunCount,
        lastValue: lastReadValue,
      });
    };

    // Run the action initially
    runtime.scheduler.subscribe(
      ignoredReadAction,
      { reads: [], shallowReads: [], writes: [] },
      {},
    );
    await resultCell.pull();
    expect(actionRunCount).toBe(1);
    expect(lastReadValue).toEqual({ value: 1 });
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });

    // Change the source cell
    sourceCell.withTx(tx).set({ value: 5 });
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    // Action should NOT run again because the read was ignored
    expect(actionRunCount).toBe(1); // Still 1!
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } }); // Unchanged

    // Change the source cell again to be extra sure
    sourceCell.withTx(tx).set({ value: 10 });
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    // Still should not have run
    expect(actionRunCount).toBe(1);
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });
  });

  it("should track potentialWrites via Cell.set on nested path", async () => {
    // Create a cell with nested structure
    const testCell = runtime.getCell<{ nested: { a: number; b: string } }>(
      space,
      "potential-writes-cell-set-test",
      undefined,
      tx,
    );
    testCell.set({ nested: { a: 1, b: "hello" } });
    tx.commit();
    tx = runtime.edit();

    // In a new transaction, set nested values where `a` stays the same but `b` changes
    const setTx = runtime.edit();
    testCell.withTx(setTx).key("nested").set({ a: 1, b: "world" });

    const log = txToReactivityLog(setTx);

    // key("nested").set() reads the nested object to compare
    // The "nested" path should appear in potentialWrites
    expect(log.potentialWrites).toBeDefined();
    expect(
      log.potentialWrites!.some((addr) => addr.path[0] === "nested"),
    ).toBe(true);

    // Only `b` changed within nested, so nested.b should be in writes
    expect(
      log.writes.some((w) => w.path[0] === "nested" && w.path[1] === "b"),
    ).toBe(true);
    // nested.a should NOT be in writes (value didn't change)
    expect(
      log.writes.some((w) => w.path[0] === "nested" && w.path[1] === "a"),
    ).toBe(false);

    await setTx.commit();
  });

  it("should include nested path in potentialWrites when using key().set()", async () => {
    // Create a cell with nested structure
    const testCell = runtime.getCell<{
      data: { unchanged: number; changed: number };
    }>(
      space,
      "diff-update-potential-writes-cell",
      undefined,
      tx,
    );
    testCell.set({ data: { unchanged: 42, changed: 1 } });
    tx.commit();
    tx = runtime.edit();

    // In a new transaction, set nested values where only one property changes
    const setTx = runtime.edit();
    testCell.withTx(setTx).key("data").set({ unchanged: 42, changed: 999 });

    const log = txToReactivityLog(setTx);

    // The "data" path should be in potentialWrites because diffAndUpdate
    // reads the nested object to compare
    expect(log.potentialWrites).toBeDefined();
    expect(log.potentialWrites!.some((addr) => addr.path[0] === "data")).toBe(
      true,
    );

    // Only changed property within data should be in writes
    expect(
      log.writes.some((w) => w.path[0] === "data" && w.path[1] === "changed"),
    ).toBe(true);
    // unchanged property should NOT be in writes (value didn't change)
    expect(
      log.writes.some((w) => w.path[0] === "data" && w.path[1] === "unchanged"),
    ).toBe(false);

    await setTx.commit();
  });

  it("should not have potentialWrites when using getRaw without metadata", async () => {
    const testCell = runtime.getCell<{ value: number }>(
      space,
      "no-potential-writes-cell",
      undefined,
      tx,
    );
    testCell.set({ value: 1 });
    tx.commit();
    tx = runtime.edit();

    // getRaw without metadata should not create potentialWrites
    const readTx = runtime.edit();
    testCell.withTx(readTx).key("value").getRaw();

    const log = txToReactivityLog(readTx);

    // Should have reads but no potentialWrites
    expect(log.reads.length).toBeGreaterThanOrEqual(1);
    expect(log.potentialWrites).toBeUndefined();

    await readTx.commit();
  });

  it("should track non-recursive reads separately in reactivity logs", async () => {
    const testCell = runtime.getCell<{ value: { nested: number } }>(
      space,
      "non-recursive-log-cell",
      undefined,
      tx,
    );
    testCell.set({ value: { nested: 1 } });
    tx.commit();
    tx = runtime.edit();

    const readTx = runtime.edit();
    testCell.withTx(readTx).key("value").getRaw({ nonRecursive: true });

    const log = txToReactivityLog(readTx);
    expect(log.shallowReads.length).toBeGreaterThanOrEqual(1);
    expect(log.shallowReads.some((addr) => addr.path[0] === "value"))
      .toBe(true);

    await readTx.commit();
  });

  it("should track read without load for scheduling and still trigger on writes", async () => {
    const sourceCell = runtime.getCell<number>(
      space,
      "source-cell-for-track-without-load",
      undefined,
      tx,
    );
    sourceCell.set(1);

    const resultCell = runtime.getCell<{ count: number; lastRead: unknown }>(
      space,
      "result-cell-for-track-without-load",
      undefined,
      tx,
    );
    resultCell.set({ count: 0, lastRead: null });
    tx.commit();
    tx = runtime.edit();

    const sourceLink = sourceCell.getAsNormalizedFullLink();
    const sourceAddress = {
      space: sourceLink.space,
      id: sourceLink.id,
      type: sourceLink.type,
      path: ["value", ...sourceLink.path],
    };

    let actionRunCount = 0;
    const action: Action = (actionTx) => {
      actionRunCount++;
      const readResult = actionTx.read(sourceAddress, {
        trackReadWithoutLoad: true,
      });
      // sourceCell has a value, but trackReadWithoutLoad should not fetch it.
      expect(readResult.error).toBeUndefined();
      expect(readResult.ok?.value).toBeUndefined();
      resultCell.withTx(actionTx).set({
        count: actionRunCount,
        lastRead: readResult.ok?.value,
      });
    };

    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await resultCell.pull();
    expect(actionRunCount).toBe(1);
    expect(resultCell.get()).toEqual({ count: 1, lastRead: undefined });

    // Write to the same address: tracked read should still invalidate.
    sourceCell.withTx(tx).set(2);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    expect(actionRunCount).toBe(2);
    expect(resultCell.get()).toEqual({ count: 2, lastRead: undefined });
  });

  it("non-recursive read through link chain does not re-trigger on value update", async () => {
    // docA holds a link to docB at path ["foo", "bar"]
    // docB's root value is itself a link to docC
    // docC holds { baz: 1 }
    // Reading docA traverses docA → docB → docC and registers non-recursive
    // reads at each link target.  Updating an existing key in docC must not
    // trigger because the reads are non-recursive (only new keys trigger).
    const docA = runtime.getCell<unknown>(
      space,
      "link-chain-docA",
      undefined,
      tx,
    );
    const docB = runtime.getCell<unknown>(
      space,
      "link-chain-docB",
      undefined,
      tx,
    );
    const docC = runtime.getCell<{ baz: number; newKey?: string }>(
      space,
      "link-chain-docC",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<number>(
      space,
      "link-chain-result",
      undefined,
      tx,
    );

    // docA links to docB at ["foo","bar"]
    // docB.foo links to docC at []
    // A read of docA will not cause us to react to a write of docC.baz
    const docBDeepLink = docB.key("foo").key("bar").cellLink;
    docA.withTx(tx).setRaw(docBDeepLink); // points to B.foo.bar (or C.bar)
    docB.withTx(tx).setRaw({ foo: docC.cellLink }); // B.foo points to C
    docC.withTx(tx).setRaw({ baz: 1, bar: 2 });
    resultCell.withTx(tx).set(0);
    tx.commit();
    tx = runtime.edit();

    const docALink = docA.getAsNormalizedFullLink();
    const docBLink = docB.getAsNormalizedFullLink();
    const docCLink = docC.getAsNormalizedFullLink();
    const type = "application/json" as const;

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      // Mirror the non-recursive reads that followPointer (traverse.ts) registers
      // when traversing docA → docB → docC through the link chain.
      actionTx.read(
        {
          space: docALink.space,
          id: docALink.id,
          type,
          path: ["value"],
        },
        { nonRecursive: true },
      );
      actionTx.read(
        { space: docBLink.space, id: docBLink.id, type, path: ["value"] },
        { nonRecursive: true },
      );
      // docC root: non-recursive and scheduling-only (value already loaded via
      // the reads above; we just need to track the dependency).
      actionTx.read(
        { space: docCLink.space, id: docCLink.id, type, path: ["value"] },
        { nonRecursive: true, trackReadWithoutLoad: true },
      );
      resultCell.withTx(actionTx).set(runCount);
    };

    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await resultCell.pull();
    expect(runCount).toBe(1);

    // Update docC.baz (existing key, value change only) — must NOT trigger.
    docC.withTx(tx).key("baz").set(2);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();
    expect(runCount).toBe(1);

    // Add a new direct key to docC — MUST trigger (non-recursive reads fire on key add).
    docC.withTx(tx).key("fiz").set(2);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();
    expect(runCount).toBe(2);
  });

  it("cell.get on docA inside action does not add recursive scheduling deps for docC", async () => {
    // Same link chain: docA → docB.foo.bar → docC
    // The action only calls docA.get() — no manual actionTx.read calls.
    // docA.get() should internally register only the reads it needs (non-recursive
    // through the link chain) and must not add recursive deps on docC, so
    // updating an existing key in docC must NOT re-trigger.
    const docA = runtime.getCell<unknown>(
      space,
      "link-chain-get-docA",
      undefined,
      tx,
    );
    const docB = runtime.getCell<unknown>(
      space,
      "link-chain-get-docB",
      undefined,
      tx,
    );
    const docC = runtime.getCell<{ baz: number; newKey?: string }>(
      space,
      "link-chain-get-docC",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<number>(
      space,
      "link-chain-get-result",
      undefined,
      tx,
    );

    const docBDeepLink = docB.key("foo").key("bar").cellLink;
    docA.withTx(tx).setRaw(docBDeepLink);
    docB.withTx(tx).setRaw({ foo: docC.cellLink });
    docC.withTx(tx).setRaw({ baz: 1, bar: 2 });
    resultCell.withTx(tx).set(0);
    tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      // Only cell.get — all scheduling deps come from this single call.
      docA.withTx(actionTx).get();
      resultCell.withTx(actionTx).set(runCount);
    };

    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await resultCell.pull();
    expect(runCount).toBe(1);

    // Update docC.baz (existing key, value change only) — must NOT trigger.
    docC.withTx(tx).key("baz").set(2);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();
    expect(runCount).toBe(1);

    // Update docC.bar (existing key, value change only) — must trigger.
    docC.withTx(tx).key("bar").set(3);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();
    expect(runCount).toBe(2);
  });
});

describe("event handling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for event handling tests
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should queue and process events", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should queue and process events 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "should queue and process events 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventResultCell.withTx(tx).send(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);

    await eventResultCell.pull();

    expect(eventCount).toBe(2);
    expect(eventCell.get()).toBe(0); // Events are _not_ written to cell
    expect(eventResultCell.get()).toBe(2);
  });

  it("should remove event handlers", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should remove event handlers 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventCell.withTx(tx).send(event);
    };

    const removeHandler = runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await eventCell.pull();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);

    removeHandler();

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await eventCell.pull();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);
  });

  it("should handle events with nested paths", async () => {
    const parentCell = runtime.getCell<{ child: { value: number } }>(
      space,
      "should handle events with nested paths 1",
      undefined,
      tx,
    );
    parentCell.set({ child: { value: 0 } });
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = () => {
      eventCount++;
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      parentCell.key("child").key("value").getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      parentCell.key("child").key("value").getAsNormalizedFullLink(),
      42,
    );
    await runtime.idle();

    expect(eventCount).toBe(1);
  });

  it("should process events in order", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should process events in order 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    const events: number[] = [];

    const eventHandler: EventHandler = (_tx, event) => {
      events.push(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 3);

    await runtime.idle();

    expect(events).toEqual([1, 2, 3]);
  });

  it("should trigger recomputation of dependent cells", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should trigger recomputation of dependent cells 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "should trigger recomputation of dependent cells 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    let eventCount = 0;
    let actionCount = 0;
    let lastEventSeen = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventResultCell.withTx(tx).send(event);
    };

    const action = (tx: IExtendedStorageTransaction) => {
      actionCount++;
      lastEventSeen = eventResultCell.withTx(tx).get();
    };
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await eventResultCell.pull();

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    expect(actionCount).toBe(1);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await eventResultCell.pull();

    expect(eventCount).toBe(1);
    expect(eventResultCell.get()).toBe(1);

    expect(actionCount).toBe(2);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await eventResultCell.pull();

    expect(eventCount).toBe(2);
    expect(eventResultCell.get()).toBe(2);
    expect(actionCount).toBe(3);
    expect(lastEventSeen).toBe(2);
  });

  it(
    "should retry event handler when the handler transaction aborts, up to retries count",
    async () => {
      const entityId = `test:retry-conflict-${Date.now()}` as Entity;

      // Set up an event cell and commit initial state
      const eventCell = runtime.getCell<number>(
        space,
        "should retry event handler on conflict",
        undefined,
        tx,
      );
      eventCell.set(0);
      await tx.commit();

      // Event handler that writes a conflicting value to the same entity
      let attempts = 0;
      const handler: EventHandler = (tx, _event) => {
        attempts++;
        // Force commit failure for the first 5 attempts to exercise retries.
        if (attempts <= 5) {
          tx.abort("force-abort-for-retry");
          return;
        }
        // On the final attempt, perform a regular write.
        tx.write({
          space,
          id: entityId,
          type: "application/json",
          path: [],
        }, { version: 2 });
      };

      runtime.scheduler.addEventHandler(
        handler,
        eventCell.getAsNormalizedFullLink(),
      );

      // Queue event (uses default retries configured in scheduler)
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
      );

      // First idle may return before the commit callback schedules retries.
      await runtime.idle();
      // Wait for any re-queued events to process.
      await runtime.idle();

      // Should attempt initial + default retries times (DEFAULT_RETRIES=5)
      expect(attempts).toBe(6);

      // No further assertions needed; this verifies retry behavior only.
    },
  );
});

describe("reactive retries", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for reactive retry tests
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it(
    "should retry reactive actions when commit fails, up to limit",
    async () => {
      // Establish a source cell to create a read dependency
      const source = runtime.getCell<number>(
        space,
        "should retry reactive actions when commit fails, up to limit 1",
        undefined,
        tx,
      );
      source.set(1);
      await tx.commit();
      tx = runtime.edit();

      // Count runs; force commit failure each time
      let attempts = 0;
      const reactiveAction: Action = (actionTx) => {
        attempts++;
        // Read to establish dependency so later changes re-trigger
        source.withTx(actionTx).get();
        // Force commit to fail so scheduler retries
        actionTx.abort("force-abort-for-reactive-retry");
      };

      // Subscribe and run immediately
      runtime.scheduler.subscribe(
        reactiveAction,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );

      // Allow retries to process. Idle may resolve before re-queue occurs,
      // so loop a few times until attempts reach the expected amount.
      for (let i = 0; i < 20 && attempts < 10; i++) {
        await runtime.idle();
      }

      // MAX_RETRIES_FOR_REACTIVE is 10; expect initial + retries == 10 attempts
      expect(attempts).toBe(10);

      // After reaching retry limit, a subsequent input change should re-trigger
      source.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();

      // Wait for the follow-up run
      await runtime.idle();

      expect(attempts).toBe(11);
    },
  );

  it(
    "should preserve dependencies when retrying failed commits",
    async () => {
      // This test documents expected behavior for the conflict storm fix:
      // When a reactive action's commit fails and it retries, it should
      // preserve its dependency information (not overwrite with empty deps).
      // This ensures topological sorting works correctly during retries.
      //
      // NOTE: This test passes with both buggy and fixed code because line 274
      // immediately re-learns dependencies after each action run, masking the
      // bug in simple scenarios. The real bug manifests only in high-concurrency
      // scenarios (30+ reactive cells) where async commit callbacks race with
      // scheduler execution. See budget-planner integration test for evidence
      // of the fix (conflict storm: 65k errors → 1 error after fix).

      const source = runtime.getCell<number>(
        space,
        "should preserve dependencies source",
        undefined,
        tx,
      );
      source.set(1);

      const intermediate = runtime.getCell<number>(
        space,
        "should preserve dependencies intermediate",
        undefined,
        tx,
      );
      intermediate.set(0);

      const output = runtime.getCell<number>(
        space,
        "should preserve dependencies output",
        undefined,
        tx,
      );
      output.set(0);

      await tx.commit();
      tx = runtime.edit();

      let action1Attempts = 0;
      let action2Attempts = 0;
      const action2Values: number[] = [];

      // Action 1: reads source, writes intermediate (will fail first 2 times)
      const action1: Action = (actionTx) => {
        action1Attempts++;
        const val = source.withTx(actionTx).get();
        intermediate.withTx(actionTx).send(val * 10);

        // Force abort for first 2 attempts to trigger retry logic
        if (action1Attempts <= 2) {
          actionTx.abort("force-abort-action1");
        }
      };

      // Action 2: reads intermediate, writes output (depends on action1)
      const action2: Action = (actionTx) => {
        action2Attempts++;
        const val = intermediate.withTx(actionTx).get();
        action2Values.push(val);
        output.withTx(actionTx).send(val + 5);
      };

      // Subscribe both actions with correct dependencies
      runtime.scheduler.subscribe(
        action1,
        {
          reads: [source.getAsNormalizedFullLink()],
          shallowReads: [],
          writes: [intermediate.getAsNormalizedFullLink()],
        },
        {},
      );
      runtime.scheduler.subscribe(
        action2,
        {
          reads: [intermediate.getAsNormalizedFullLink()],
          shallowReads: [],
          writes: [output.getAsNormalizedFullLink()],
        },
        {},
      );

      // Allow all actions to complete (action1 will retry twice)
      for (let i = 0; i < 20 && action1Attempts < 3; i++) {
        await output.pull();
      }

      // Verify action1 ran 3 times (2 aborts + 1 success)
      expect(action1Attempts).toBe(3);

      // Action2 should run twice in reactive system:
      // 1. Initially when both actions run (sees intermediate=0 since action1 aborts)
      // 2. After action1 succeeds and updates intermediate (sees intermediate=10)
      expect(action2Attempts).toBe(2);
      expect(action2Values).toEqual([0, 10]);

      // Critical assertion: The final state must be correct, proving that
      // dependencies were preserved during retries and topological sort worked.
      expect(intermediate.get()).toBe(10); // 1 * 10
      expect(output.get()).toBe(15); // 10 + 5
    },
  );
});
