// Dependency tracking tests: effect/computation classification, reverse
// dependency graph, backfill, and dependency metadata (ignoreReadForScheduling,
// potentialWrites).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Action,
  ignoreReadForScheduling,
  txToReactivityLog,
} from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("effect/computation tracking", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should track actions as computations by default", async () => {
    const a = runtime.getCell<number>(
      space,
      "track-computations-1",
      undefined,
      tx,
    );
    a.set(1);
    await tx.commit();
    tx = runtime.edit();

    const stats1 = runtime.scheduler.getStats();
    expect(stats1.computations).toBe(0);
    expect(stats1.effects).toBe(0);

    const action: Action = () => {};
    runtime.scheduler.subscribe(action, { reads: [], writes: [] }, {});
    runtime.scheduler.queueExecution();
    await runtime.idle();

    const stats2 = runtime.scheduler.getStats();
    expect(stats2.computations).toBe(1);
    expect(stats2.effects).toBe(0);
    expect(runtime.scheduler.isComputation(action)).toBe(true);
    expect(runtime.scheduler.isEffect(action)).toBe(false);
  });

  it("should track actions as effects when isEffect is true", async () => {
    const a = runtime.getCell<number>(
      space,
      "track-effects-1",
      undefined,
      tx,
    );
    a.set(1);
    await tx.commit();
    tx = runtime.edit();

    const stats1 = runtime.scheduler.getStats();
    expect(stats1.effects).toBe(0);

    const action: Action = () => {};
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    const stats2 = runtime.scheduler.getStats();
    expect(stats2.effects).toBe(1);
    expect(stats2.computations).toBe(0);
    expect(runtime.scheduler.isEffect(action)).toBe(true);
    expect(runtime.scheduler.isComputation(action)).toBe(false);
  });

  it("should remove from correct set on unsubscribe", async () => {
    const a = runtime.getCell<number>(
      space,
      "unsubscribe-tracking-1",
      undefined,
      tx,
    );
    a.set(1);
    await tx.commit();
    tx = runtime.edit();

    const computation: Action = () => {};
    const effect: Action = () => {};

    runtime.scheduler.subscribe(
      computation,
      { reads: [], writes: [] },
      { isEffect: false },
    );
    runtime.scheduler.subscribe(
      effect,
      { reads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    const stats1 = runtime.scheduler.getStats();
    expect(stats1.computations).toBe(1);
    expect(stats1.effects).toBe(1);

    // Unsubscribe computation
    runtime.scheduler.unsubscribe(computation);
    const stats2 = runtime.scheduler.getStats();
    expect(stats2.computations).toBe(0);
    expect(stats2.effects).toBe(1);
    expect(runtime.scheduler.isComputation(computation)).toBe(false);

    // Unsubscribe effect
    runtime.scheduler.unsubscribe(effect);
    const stats3 = runtime.scheduler.getStats();
    expect(stats3.computations).toBe(0);
    expect(stats3.effects).toBe(0);
    expect(runtime.scheduler.isEffect(effect)).toBe(false);
  });

  it("should track sink() calls as effects", async () => {
    const a = runtime.getCell<number>(
      space,
      "sink-as-effect-1",
      undefined,
      tx,
    );
    a.set(42);
    await tx.commit();
    tx = runtime.edit();

    const stats1 = runtime.scheduler.getStats();
    const initialEffects = stats1.effects;

    let sinkValue: number | undefined;
    const cancel = a.sink((value) => {
      sinkValue = value;
    });
    await runtime.idle();

    const stats2 = runtime.scheduler.getStats();
    // sink() should add an effect
    expect(stats2.effects).toBe(initialEffects + 1);
    expect(sinkValue).toBe(42);

    cancel();
    await runtime.idle();

    // After cancel, effect count should decrease (but may not be immediate due to GC)
  });

  it("should track sink() parent-child relationship when called inside an action", async () => {
    const sourceCell = runtime.getCell<number>(
      space,
      "sink-parent-source",
      undefined,
      tx,
    );
    sourceCell.set(1);

    const observedCell = runtime.getCell<number>(
      space,
      "sink-parent-observed",
      undefined,
      tx,
    );
    observedCell.set(42);

    await tx.commit();
    tx = runtime.edit();

    let sinkCalled = false;
    let parentCalled = false;
    let sinkCancel: (() => void) | undefined;

    // Parent action that creates a sink during its execution
    const parentAction: Action = (actionTx) => {
      parentCalled = true;
      sourceCell.withTx(actionTx).get();

      // Create a sink inside the action - this should track parent relationship
      if (!sinkCancel) {
        sinkCancel = observedCell.sink((_value) => {
          sinkCalled = true;
        });
      }
    };

    runtime.scheduler.subscribe(parentAction, {
      reads: [sourceCell.getAsNormalizedFullLink()],
      writes: [],
    }, { isEffect: true }); // Mark as effect so it runs in pull mode

    await runtime.idle();

    // Verify the parent action was called
    expect(parentCalled).toBe(true);

    // Verify the sink was called (sink() always calls callback immediately on creation)
    expect(sinkCalled).toBe(true);

    // Get the graph snapshot and verify parent-child relationship
    const graph = runtime.scheduler.getGraphSnapshot();

    // Find the sink action node (named sink:space/...)
    const sinkNodes = graph.nodes.filter((n) => n.id.startsWith("sink:"));
    expect(sinkNodes.length).toBe(1);
    const sinkNode = sinkNodes[0];

    // Verify the sink has a parent (the parent action)
    expect(sinkNode.parentId).toBeDefined();

    // Verify the parent node exists and has childCount
    const parentNode = graph.nodes.find((n) => n.id === sinkNode.parentId);
    expect(parentNode).toBeDefined();
    expect(parentNode!.childCount).toBeGreaterThanOrEqual(1);

    sinkCancel!();
    await runtime.idle();
  });

  it("should track dependents for reverse dependency graph", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "dependents-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate = runtime.getCell<number>(
      space,
      "dependents-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const output = runtime.getCell<number>(
      space,
      "dependents-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Action 1: reads source, writes intermediate
    const action1: Action = (actionTx) => {
      const val = source.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(val * 10);
    };

    // Action 2: reads intermediate, writes output
    const action2: Action = (actionTx) => {
      const val = intermediate.withTx(actionTx).get();
      output.withTx(actionTx).send(val + 5);
    };

    // Subscribe action1 first (writes to intermediate)
    runtime.scheduler.subscribe(
      action1,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [intermediate.getAsNormalizedFullLink()],
      },
      {},
    );
    await output.pull();

    // Subscribe action2 (reads intermediate)
    runtime.scheduler.subscribe(
      action2,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        writes: [output.getAsNormalizedFullLink()],
      },
      {},
    );
    await output.pull();

    // action2 should be a dependent of action1 (action1 writes what action2 reads)
    const dependents = runtime.scheduler.getDependents(action1);
    expect(dependents.has(action2)).toBe(true);
  });

  it("should backfill dependents when writer is added after effect subscribes", async () => {
    runtime.scheduler.enablePullMode();

    const data = runtime.getCell<{ foo: number; bar: number }>(
      space,
      "backfill-writer-after-effect",
      undefined,
      tx,
    );
    data.set({ foo: 1, bar: 2 });
    await tx.commit();
    tx = runtime.edit();

    const effect: Action = (actionTx) => {
      data.withTx(actionTx).key("foo").get();
    };

    runtime.scheduler.subscribe(effect, effect, { isEffect: true });
    await runtime.scheduler.idle();

    const computation: Action = (actionTx) => {
      data.withTx(actionTx).key("foo").set(2);
    };
    runtime.scheduler.subscribe(
      computation,
      { reads: [], writes: [data.key("foo").getAsNormalizedFullLink()] },
      {},
    );

    const dependents = runtime.scheduler.getDependents(computation);
    expect(dependents.has(effect)).toBe(true);
  });

  it("should backfill only when new writer paths overlap existing reads", async () => {
    runtime.scheduler.enablePullMode();

    const data = runtime.getCell<{ foo: number; bar: number }>(
      space,
      "backfill-writer-paths",
      undefined,
      tx,
    );
    data.set({ foo: 1, bar: 2 });
    await tx.commit();
    tx = runtime.edit();

    const effect: Action = (actionTx) => {
      data.withTx(actionTx).key("bar").get();
    };

    runtime.scheduler.subscribe(effect, effect, { isEffect: true });
    await runtime.scheduler.idle();

    const computation: Action = (actionTx) => {
      data.withTx(actionTx).key("foo").set(2);
    };
    runtime.scheduler.subscribe(
      computation,
      { reads: [], writes: [data.key("foo").getAsNormalizedFullLink()] },
      {},
    );

    const initialDependents = runtime.scheduler.getDependents(computation);
    expect(initialDependents.has(effect)).toBe(false);

    runtime.scheduler.resubscribe(computation, {
      reads: [],
      writes: [
        data.key("foo").getAsNormalizedFullLink(),
        data.key("bar").getAsNormalizedFullLink(),
      ],
    });

    const updatedDependents = runtime.scheduler.getDependents(computation);
    expect(updatedDependents.has(effect)).toBe(true);
  });
});

describe("dependency metadata", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for dependency metadata tests
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
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
      { reads: [], writes: [] },
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
});
