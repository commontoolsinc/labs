// Pull-based scheduling tests: pull mode, references, handler dependency
// pulling, array reactivity, push-triggered filtering, and cycle convergence.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { type Action, type EventHandler } from "../src/scheduler.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("pull-based scheduling", () => {
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

  it("should have unchanged behavior with pullMode = false", async () => {
    // Explicitly set push mode for this test
    runtime.scheduler.disablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(false);

    const source = runtime.getCell<number>(
      space,
      "push-mode-unchanged-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "push-mode-unchanged-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    const computation: Action = (actionTx) => {
      computationRuns++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      { reads: [], writes: [] },
      {},
    );
    await result.pull();

    expect(computationRuns).toBe(1);
    expect(result.get()).toBe(10);

    // Change source - should trigger computation in push mode
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();

    expect(computationRuns).toBe(2);
    expect(result.get()).toBe(20);
  });

  it("should mark computations as dirty in pull mode when source changes", async () => {
    // This test verifies that in pull mode, computations are marked dirty
    // rather than scheduled when their inputs change.
    runtime.scheduler.enablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);

    const source = runtime.getCell<number>(
      space,
      "pull-mode-dirty-marking-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "pull-mode-dirty-marking-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;

    // Computation: reads source, writes result
    const computation: Action = (actionTx) => {
      computationRuns++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 10);
    };

    // Subscribe computation
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [result.getAsNormalizedFullLink()],
      },
      {},
    );
    await result.pull();

    // After computation runs, result should be 10
    expect(result.get()).toBe(10);
    expect(computationRuns).toBe(1);

    // Verify computation is clean after running
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    // Change source - in pull mode, computation should be marked dirty
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    // Give time for the storage notification to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    // In pull mode with no effect depending on this computation,
    // the computation should be marked dirty but not run
    // (since there's no effect to pull it)
    expect(runtime.scheduler.isDirty(computation)).toBe(true);

    // The computation should NOT have run again (pull mode doesn't schedule computations)
    expect(computationRuns).toBe(1);
  });

  it("should preserve writes when collecting dependencies from ReactivityLog", async () => {
    runtime.scheduler.enablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);

    const target = runtime.getCell<number>(
      space,
      "reactivity-log-writes-target",
      undefined,
      tx,
    );
    target.set(0);
    await tx.commit();
    tx = runtime.edit();

    let writerRuns = 0;
    const writer: Action = (actionTx) => {
      writerRuns++;
      target.withTx(actionTx).send(1);
    };

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [],
        writes: [target.getAsNormalizedFullLink()],
      },
      {},
    );

    await runtime.scheduler.idle();
    expect(writerRuns).toBe(0);

    // Force dependency collection to run against the stored ReactivityLog entry.
    const schedulerInternal = runtime.scheduler as unknown as {
      pendingDependencyCollection: Set<Action>;
    };
    schedulerInternal.pendingDependencyCollection.add(writer);
    runtime.scheduler.queueExecution();
    await runtime.scheduler.idle();

    expect(writerRuns).toBe(0);
  });

  it("should schedule effects when affected by dirty computations", async () => {
    // This test verifies that scheduleAffectedEffects correctly finds and
    // schedules effects that depend on a dirty computation.
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "schedule-effects-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate = runtime.getCell<number>(
      space,
      "schedule-effects-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "schedule-effects-result",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;

    // Computation: reads source, writes intermediate
    const computation: Action = (actionTx) => {
      const val = source.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(val * 10);
    };

    // Effect: reads intermediate
    const effect: Action = (actionTx) => {
      effectRuns++;
      const val = intermediate.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(val + 5);
    };

    // Subscribe computation first
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [intermediate.getAsNormalizedFullLink()],
      },
      {},
    );
    await effectResult.pull();

    // Subscribe effect with isEffect: true
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    // Verify dependency tracking is set up correctly
    const dependents = runtime.scheduler.getDependents(computation);
    expect(dependents.has(effect)).toBe(true);

    // Track initial effect runs
    const initialEffectRuns = effectRuns;

    // Change source - computation should be marked dirty, effect should be scheduled
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await effectResult.pull();

    // Effect should have run (triggered via scheduleAffectedEffects)
    expect(effectRuns).toBeGreaterThan(initialEffectRuns);
  });

  it("should recompute multi-hop chains before running effects in pull mode", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "pull-multihop-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate1 = runtime.getCell<number>(
      space,
      "pull-multihop-mid-1",
      undefined,
      tx,
    );
    intermediate1.set(0);
    const intermediate2 = runtime.getCell<number>(
      space,
      "pull-multihop-mid-2",
      undefined,
      tx,
    );
    intermediate2.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-multihop-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let comp1Runs = 0;
    let comp2Runs = 0;
    let effectRuns = 0;

    const computation1: Action = (actionTx) => {
      comp1Runs++;
      const val = source.withTx(actionTx).get();
      intermediate1.withTx(actionTx).send(val + 1);
    };

    const computation2: Action = (actionTx) => {
      comp2Runs++;
      const val = intermediate1.withTx(actionTx).get();
      intermediate2.withTx(actionTx).send(val * 2);
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      const val = intermediate2.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(val - 3);
    };

    runtime.scheduler.subscribe(
      computation1,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [intermediate1.getAsNormalizedFullLink()],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      computation2,
      {
        reads: [intermediate1.getAsNormalizedFullLink()],
        writes: [intermediate2.getAsNormalizedFullLink()],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate2.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    expect(effectResult.get()).toBe((1 + 1) * 2 - 3);
    expect(comp2Runs).toBe(1);
    expect(effectRuns).toBe(1);

    const tx2 = runtime.edit();
    source.withTx(tx2).send(5);
    await tx2.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(comp1Runs).toBe(2);
    expect(comp2Runs).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe((5 + 1) * 2 - 3);
  });

  it("should drop stale dependents when computation changes inputs", async () => {
    runtime.scheduler.enablePullMode();

    const sourceA = runtime.getCell<number>(
      space,
      "pull-deps-source-a",
      undefined,
      tx,
    );
    sourceA.set(2);
    const sourceB = runtime.getCell<number>(
      space,
      "pull-deps-source-b",
      undefined,
      tx,
    );
    sourceB.set(7);
    const selector = runtime.getCell<boolean>(
      space,
      "pull-deps-selector",
      undefined,
      tx,
    );
    selector.set(false);
    const intermediate = runtime.getCell<number>(
      space,
      "pull-deps-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-deps-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;

    const computation: Action = (actionTx) => {
      const useB = selector.withTx(actionTx).get();
      const value = useB
        ? sourceB.withTx(actionTx).get()
        : sourceA.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(value * 10);
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      const value = intermediate.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(value);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [
          selector.getAsNormalizedFullLink(),
          sourceA.getAsNormalizedFullLink(),
        ],
        writes: [intermediate.getAsNormalizedFullLink()],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(20);

    // Switch computation to sourceB
    const toggleTx = runtime.edit();
    selector.withTx(toggleTx).send(true);
    await toggleTx.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(70);

    // Updating sourceA should not dirty the computation any more
    const tx3 = runtime.edit();
    sourceA.withTx(tx3).send(999);
    await tx3.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(70);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    // Updating sourceB should still run the computation
    const tx4 = runtime.edit();
    sourceB.withTx(tx4).send(6);
    await tx4.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(effectRuns).toBe(3);
    expect(effectResult.get()).toBe(60);
  });

  it("should track getStats with dirty count", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "stats-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    const computation: Action = () => {};

    runtime.scheduler.subscribe(
      computation,
      { reads: [source.getAsNormalizedFullLink()], writes: [] },
      {},
    );
    runtime.scheduler.queueExecution();
    await runtime.idle();

    // In pull mode, computation stays dirty since no effect pulled it
    // (computations are lazily evaluated only when needed by effects)
    expect(runtime.scheduler.isDirty(computation)).toBe(true);

    // Stats should show correct counts
    const stats = runtime.scheduler.getStats();
    expect(stats.computations).toBeGreaterThanOrEqual(1);
    expect(stats.effects).toBe(0);
  });

  it("should allow disabling pull mode", () => {
    runtime.scheduler.enablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);

    runtime.scheduler.disablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(false);
  });
});

describe("pull mode with references", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.enablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should propagate dirtiness through references (nested lift scenario)", async () => {
    // This test reproduces the nested lift pattern where:
    // - Inner lift reads source, writes to innerOutput
    // - outerInput cell contains a REFERENCE to innerOutput
    // - Outer lift reads outerInput (following ref to innerOutput), writes to outerOutput
    // - Effect reads outerOutput
    //
    // When source changes:
    // 1. Inner lift is marked dirty
    // 2. Outer lift should be marked dirty because it reads (via reference) what inner writes
    // 3. Effect should run and see updated value

    const source = runtime.getCell<string[]>(
      space,
      "nested-ref-source",
      undefined,
      tx,
    );
    source.set([]);

    const innerOutput = runtime.getCell<string | undefined>(
      space,
      "nested-ref-inner-output",
      undefined,
      tx,
    );
    innerOutput.set(undefined);

    // This cell holds a REFERENCE to innerOutput (simulating how lift passes results)
    const outerInput = runtime.getCell<string | undefined>(
      space,
      "nested-ref-outer-input",
      undefined,
      tx,
    );
    // Set it to be a reference pointing to innerOutput
    outerInput.set(undefined);

    const outerOutput = runtime.getCell<string>(
      space,
      "nested-ref-outer-output",
      undefined,
      tx,
    );
    outerOutput.set("default");

    const effectResult = runtime.getCell<string>(
      space,
      "nested-ref-effect-result",
      undefined,
      tx,
    );
    effectResult.set("");

    await tx.commit();
    tx = runtime.edit();

    let innerRuns = 0;
    let outerRuns = 0;
    let effectRuns = 0;

    // Inner lift: arr => arr[0] (returns undefined when array is empty)
    const innerLift: Action = (actionTx) => {
      innerRuns++;
      const arr = source.withTx(actionTx).get() ?? [];
      const firstItem = arr[0]; // Returns undefined when empty!
      innerOutput.withTx(actionTx).send(firstItem);
    };

    // Outer lift: (name, firstItem) => name || firstItem || "default"
    // For this test, we'll read innerOutput directly to simulate following the reference
    const outerLift: Action = (actionTx) => {
      outerRuns++;
      const firstItem = innerOutput.withTx(actionTx).get();
      const result = firstItem || "default";
      outerOutput.withTx(actionTx).send(result);
    };

    // Effect: sink that captures the output
    const effect: Action = (actionTx) => {
      effectRuns++;
      const val = outerOutput.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(val ?? "");
    };

    // Subscribe in order: inner, outer, effect
    runtime.scheduler.subscribe(
      innerLift,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [innerOutput.getAsNormalizedFullLink()],
      },
      {},
    );
    await innerOutput.pull();

    runtime.scheduler.subscribe(
      outerLift,
      {
        reads: [innerOutput.getAsNormalizedFullLink()],
        writes: [outerOutput.getAsNormalizedFullLink()],
      },
      {},
    );
    await outerOutput.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [outerOutput.getAsNormalizedFullLink()],
        writes: [effectResult.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    // Initial state: source is [], innerOutput is undefined, outerOutput is "default"
    expect(innerRuns).toBe(1);
    expect(outerRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe("default");

    // Now change source to ["apple"]
    source.withTx(tx).send(["apple"]);
    await tx.commit();
    tx = runtime.edit();
    await effectResult.pull();

    // With fix: All should run because dependency chain is now properly built
    // (mightWrite preserves declared writes, enabling correct topological ordering)
    expect(innerRuns).toBe(2);
    expect(outerRuns).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe("apple");
  });
});

describe("handler dependency pulling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.enablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should pull computed dependencies before running handler (handler is only reader)", async () => {
    // This test validates that when a handler's populateDependencies callback
    // reads a computed cell that has no other readers, the scheduler will
    // pull (compute) that value before running the handler.
    //
    // Setup:
    // - source cell: initial value
    // - computed action: reads source, writes to computedOutput
    // - event handler: reads computedOutput (via populateDependencies), writes to result
    // - The handler is the ONLY reader of computedOutput

    const source = runtime.getCell<number>(
      space,
      "handler-pull-source",
      undefined,
      tx,
    );
    source.set(10);

    const computedOutput = runtime.getCell<number>(
      space,
      "handler-pull-computed",
      undefined,
      tx,
    );

    const eventStream = runtime.getCell<number>(
      space,
      "handler-pull-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-pull-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;
    const executionOrder: string[] = [];

    // Computed action: reads source, writes doubled value to computedOutput
    const computedAction: Action = (actionTx) => {
      computedRuns++;
      executionOrder.push("computed");
      const val = source.withTx(actionTx).get();
      computedOutput.withTx(actionTx).send(val * 2);
    };

    // Subscribe the computed action
    runtime.scheduler.subscribe(
      computedAction,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [computedOutput.getAsNormalizedFullLink()],
      },
      {},
    );
    await computedOutput.pull();

    expect(computedRuns).toBe(1);
    expect(computedOutput.get()).toBe(20); // 10 * 2

    // Event handler: reads computedOutput and adds the event value
    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      executionOrder.push("handler");
      const computed = computedOutput.withTx(handlerTx).get();
      result.withTx(handlerTx).send(computed + event);
    };

    // populateDependencies callback - this tells the scheduler what the handler reads
    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      computedOutput.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    // Reset execution order tracking
    executionOrder.length = 0;
    computedRuns = 0;
    handlerRuns = 0;

    // Change source value - this marks computedAction as dirty
    source.withTx(tx).send(20);
    await tx.commit();
    tx = runtime.edit();

    // The computed action should NOT run yet (pull mode, no reader)
    expect(computedRuns).toBe(0);

    // Now queue an event - this should trigger:
    // 1. Scheduler sees handler depends on computedOutput (via populateDependencies)
    // 2. computedOutput's producer (computedAction) is dirty
    // 3. Scheduler pulls computedAction first
    // 4. Then runs the handler
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 5);
    await result.pull();

    // Computed should have run (pulled by handler dependency)
    expect(computedRuns).toBe(1);
    expect(computedOutput.get()).toBe(40); // 20 * 2

    // Handler should have run with the fresh computed value
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(45); // 40 + 5

    // Execution order should be: computed first, then handler
    expect(executionOrder).toEqual(["computed", "handler"]);
  });

  it("should not pull dirty computations when handler reads a different path", async () => {
    const source = runtime.getCell<number>(
      space,
      "handler-path-source",
      undefined,
      tx,
    );
    source.set(1);

    const data = runtime.getCell<{ foo: number; bar: number }>(
      space,
      "handler-path-data",
      undefined,
      tx,
    );
    data.set({ foo: 0, bar: 5 });

    const eventStream = runtime.getCell<number>(
      space,
      "handler-path-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-path-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;

    const computedAction: Action = (actionTx) => {
      computedRuns++;
      const val = source.withTx(actionTx).get();
      data.withTx(actionTx).key("foo").send(val * 2);
    };

    runtime.scheduler.subscribe(
      computedAction,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [data.key("foo").getAsNormalizedFullLink()],
      },
      {},
    );

    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      const barValue = data.withTx(handlerTx).key("bar").get();
      result.withTx(handlerTx).send(barValue + event);
    };

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      data.withTx(depTx).key("bar").get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    await runtime.scheduler.idle();

    computedRuns = 0;
    handlerRuns = 0;

    // Mark the computation dirty by changing its source.
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);
    await result.pull();

    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(8); // bar (5) + event (3)
    expect(computedRuns).toBe(0);
  });

  it("should handle multiple dirty dependencies before running handler", async () => {
    // Test that multiple dirty computed dependencies are all pulled before handler runs

    const source1 = runtime.getCell<number>(
      space,
      "handler-multi-source1",
      undefined,
      tx,
    );
    source1.set(10);

    const source2 = runtime.getCell<number>(
      space,
      "handler-multi-source2",
      undefined,
      tx,
    );
    source2.set(100);

    const computed1 = runtime.getCell<number>(
      space,
      "handler-multi-computed1",
      undefined,
      tx,
    );
    const computed2 = runtime.getCell<number>(
      space,
      "handler-multi-computed2",
      undefined,
      tx,
    );

    const eventStream = runtime.getCell<number>(
      space,
      "handler-multi-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-multi-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computed1Runs = 0;
    let computed2Runs = 0;
    let handlerRuns = 0;

    // First computed action
    const computedAction1: Action = (actionTx) => {
      computed1Runs++;
      const val = source1.withTx(actionTx).get();
      computed1.withTx(actionTx).send(val * 2);
    };

    // Second computed action
    const computedAction2: Action = (actionTx) => {
      computed2Runs++;
      const val = source2.withTx(actionTx).get();
      computed2.withTx(actionTx).send(val * 3);
    };

    runtime.scheduler.subscribe(
      computedAction1,
      {
        reads: [source1.getAsNormalizedFullLink()],
        writes: [computed1.getAsNormalizedFullLink()],
      },
      {},
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [source2.getAsNormalizedFullLink()],
        writes: [computed2.getAsNormalizedFullLink()],
      },
      {},
    );

    await computed1.pull();
    await computed2.pull();

    expect(computed1.get()).toBe(20);
    expect(computed2.get()).toBe(300);

    // Handler reads both computed values
    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      const c1 = computed1.withTx(handlerTx).get();
      const c2 = computed2.withTx(handlerTx).get();
      result.withTx(handlerTx).send(c1 + c2 + event);
    };

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      computed1.withTx(depTx).get();
      computed2.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    // Reset counters
    computed1Runs = 0;
    computed2Runs = 0;
    handlerRuns = 0;

    // Change both sources
    source1.withTx(tx).send(20);
    source2.withTx(tx).send(200);
    await tx.commit();
    tx = runtime.edit();

    // Neither should run yet (pull mode)
    expect(computed1Runs).toBe(0);
    expect(computed2Runs).toBe(0);

    // Queue event
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
    await result.pull();

    // Both computed should have run
    expect(computed1Runs).toBe(1);
    expect(computed2Runs).toBe(1);
    expect(computed1.get()).toBe(40); // 20 * 2
    expect(computed2.get()).toBe(600); // 200 * 3

    // Handler should have run with fresh values
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(641); // 40 + 600 + 1
  });

  it("should re-queue event if dependencies change during pull", async () => {
    // Test the scenario where pulling one dependency causes another to become dirty
    // (e.g., a chain: source -> computed1 -> computed2 -> handler)
    // The handler should wait until the full chain is computed

    const source = runtime.getCell<number>(
      space,
      "handler-chain-source",
      undefined,
      tx,
    );
    source.set(5);

    const computed1 = runtime.getCell<number>(
      space,
      "handler-chain-computed1",
      undefined,
      tx,
    );
    const computed2 = runtime.getCell<number>(
      space,
      "handler-chain-computed2",
      undefined,
      tx,
    );

    const eventStream = runtime.getCell<number>(
      space,
      "handler-chain-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-chain-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computed1Runs = 0;
    let computed2Runs = 0;
    let handlerRuns = 0;

    // computed1 reads source
    const computedAction1: Action = (actionTx) => {
      computed1Runs++;
      const val = source.withTx(actionTx).get();
      computed1.withTx(actionTx).send(val * 2);
    };

    // computed2 reads computed1
    const computedAction2: Action = (actionTx) => {
      computed2Runs++;
      const val = computed1.withTx(actionTx).get();
      computed2.withTx(actionTx).send(val + 10);
    };

    runtime.scheduler.subscribe(
      computedAction1,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [computed1.getAsNormalizedFullLink()],
      },
      {},
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [computed1.getAsNormalizedFullLink()],
        writes: [computed2.getAsNormalizedFullLink()],
      },
      {},
    );

    await computed2.pull();

    expect(computed1.get()).toBe(10); // 5 * 2
    expect(computed2.get()).toBe(20); // 10 + 10

    // Handler reads computed2 (end of chain)
    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      const c2 = computed2.withTx(handlerTx).get();
      result.withTx(handlerTx).send(c2 + event);
    };

    // populateDependencies reads computed2, but computed2 depends on computed1
    // which depends on source. When source changes, both computed actions are dirty.
    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      computed2.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    // Reset counters
    computed1Runs = 0;
    computed2Runs = 0;
    handlerRuns = 0;

    // Change source - this makes computed1 dirty, and when computed1 runs,
    // it will make computed2 dirty
    source.withTx(tx).send(10);
    await tx.commit();
    tx = runtime.edit();

    // Queue event
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);
    await result.pull();

    // Both computed should have run in order
    expect(computed1Runs).toBe(1);
    expect(computed2Runs).toBe(1);
    expect(computed1.get()).toBe(20); // 10 * 2
    expect(computed2.get()).toBe(30); // 20 + 10

    // Handler should see the final computed value
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(33); // 30 + 3
  });

  it("should wait for dynamically created lift before dispatching to downstream handler", async () => {
    // This test validates that when handler A triggers a lift and handler B
    // depends on that lift's output, the scheduler waits for the lift to
    // compute before running handler B.
    //
    // Setup:
    // - Stream B: handler B reads liftOutput (via populateDependencies)
    // - Stream A: handler A writes to liftInput (triggering lift) and queues event to B
    // - Lift: reads liftInput, writes to liftOutput
    // - Send event to A's stream
    //
    // Expected: A runs -> lift runs -> B runs (with fresh lift output)

    // Stream B - the downstream handler
    const streamB = runtime.getCell<number>(
      space,
      "dynamic-lift-streamB",
      undefined,
      tx,
    );
    streamB.set(0);

    // Cell to store what handler B sees from the lift output
    const handlerBSawLiftOutput = runtime.getCell<number[]>(
      space,
      "dynamic-lift-B-saw",
      undefined,
      tx,
    );
    handlerBSawLiftOutput.set([]);

    // Stream A - the upstream handler
    const streamA = runtime.getCell<number>(
      space,
      "dynamic-lift-streamA",
      undefined,
      tx,
    );
    streamA.set(0);

    // Lift input/output cells
    const liftInput = runtime.getCell<number>(
      space,
      "dynamic-lift-input",
      undefined,
      tx,
    );
    liftInput.set(0);

    const liftOutput = runtime.getCell<number>(
      space,
      "dynamic-lift-output",
      undefined,
      tx,
    );
    liftOutput.set(0);

    await tx.commit();
    tx = runtime.edit();

    let handlerARuns = 0;
    let handlerBRuns = 0;
    let liftRuns = 0;
    const executionOrder: string[] = [];

    // Lift action: transforms input by doubling it
    const liftAction: Action = (actionTx) => {
      liftRuns++;
      executionOrder.push("lift");
      const input = liftInput.withTx(actionTx).get();
      liftOutput.withTx(actionTx).send(input * 2);
    };

    // Resubscribe the lift - NOT scheduled immediately
    // This tests that the lift is pulled when handler B needs it
    // Use resubscribe to set up triggers without scheduling immediate execution
    runtime.scheduler.resubscribe(liftAction, {
      reads: [liftInput.getAsNormalizedFullLink()],
      writes: [liftOutput.getAsNormalizedFullLink()],
    });

    await runtime.idle();
    expect(liftRuns).toBe(0); // NOT run yet - using rescheduling mode
    expect(liftOutput.get()).toBe(0); // Still initial value

    // Handler B: receives a LINK to liftOutput as the event, reads from it
    const handlerB: EventHandler = (handlerTx, _event: { "/": string }) => {
      handlerBRuns++;
      // The event IS a link to liftOutput - read from it
      // This simulates a handler receiving a reference to computed data
      const liftVal = liftOutput.withTx(handlerTx).get();
      executionOrder.push(`handlerB:lift=${liftVal}`);
      const saw = handlerBSawLiftOutput.withTx(handlerTx).get();
      handlerBSawLiftOutput.withTx(handlerTx).send([...saw, liftVal]);
    };

    // Handler B's populateDependencies - resolves the event link to capture dependency
    // The event IS a link to liftOutput, so we create a cell from it and read
    const handlerBPopulateDeps = (
      depTx: IExtendedStorageTransaction,
      eventValue: { "/": string },
    ) => {
      // Create a cell from the event (which is a link) and read it
      // This registers the dependency on whatever the link points to
      const eventCell = runtime.getImmutableCell(
        space,
        eventValue,
        undefined,
        depTx,
      );
      eventCell.get();
    };

    // Handler A: writes to liftInput and queues a LINK to liftOutput as event to B
    const handlerA: EventHandler = (handlerTx, event: number) => {
      handlerARuns++;
      executionOrder.push(`handlerA:${event}`);

      // Write to lift input - this will make the lift dirty
      liftInput.withTx(handlerTx).send(event);

      // Queue an event to stream B where the event VALUE is a link to liftOutput
      // This simulates: "hey B, go read from this computed cell"
      // The scheduler should see that B depends on liftOutput and pull the lift first
      const liftOutputLink = liftOutput.getAsLink();
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        liftOutputLink,
      );
    };

    // Register handlers
    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
      handlerBPopulateDeps,
    );

    await runtime.idle();

    // Reset tracking
    executionOrder.length = 0;
    handlerARuns = 0;
    handlerBRuns = 0;
    liftRuns = 0;

    // Send event to stream A with value 5
    runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), 5);
    await handlerBSawLiftOutput.pull();

    // Handler A should have run
    expect(handlerARuns).toBe(1);

    // Lift should have run (its input changed from 0 to 5)
    expect(liftRuns).toBe(1);
    expect(liftOutput.get()).toBe(10); // 5 * 2

    // Handler B should have run and seen the FRESH lift output (10, not stale 0)
    expect(handlerBRuns).toBe(1);
    expect(handlerBSawLiftOutput.get()).toEqual([10]);

    // Verify execution order
    expect(executionOrder).toContain("handlerA:5");
    expect(executionOrder).toContain("lift");

    // The lift should run before handler B sees the fresh value
    const liftIndex = executionOrder.indexOf("lift");
    const handlerBIndex = executionOrder.findIndex((s) =>
      s.startsWith("handlerB:")
    );
    expect(liftIndex).toBeLessThan(handlerBIndex);

    // Handler B should have seen lift=10 (the fresh value, not stale 0)
    expect(executionOrder.find((s) => s.startsWith("handlerB:"))).toBe(
      "handlerB:lift=10",
    );
  });
});

describe("pull mode array reactivity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.enablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should trigger sink when array element is pushed", async () => {
    // Create a cell with an array
    const arrayCell = runtime.getCell<string[]>(
      space,
      "array-push-test",
      undefined,
      tx,
    );
    arrayCell.set(["a", "b"]);
    await tx.commit();
    tx = runtime.edit();

    // Track sink calls
    const sinkValues: string[][] = [];
    const cancel = arrayCell.withTx(tx).sink((value) => {
      sinkValues.push([...value]);
    });

    // Wait for initial sink call
    await runtime.scheduler.idle();
    expect(sinkValues.length).toBe(1);
    expect(sinkValues[0]).toEqual(["a", "b"]);

    // Push a new element using the current transaction
    arrayCell.withTx(tx).push("c");
    await tx.commit();
    tx = runtime.edit();

    // Wait for scheduler to process
    await runtime.scheduler.idle();

    // Verify sink was called with updated array
    expect(sinkValues.length).toBe(2);
    expect(sinkValues[1]).toEqual(["a", "b", "c"]);

    cancel();
  });

  it("should trigger sink when array length changes via set", async () => {
    // Create a cell with an array
    const arrayCell = runtime.getCell<number[]>(
      space,
      "array-length-test",
      undefined,
      tx,
    );
    arrayCell.set([1, 2, 3]);
    await tx.commit();
    tx = runtime.edit();

    // Track sink calls
    const sinkLengths: number[] = [];
    const cancel = arrayCell.withTx(tx).sink((value) => {
      sinkLengths.push(value.length);
    });

    // Wait for initial sink call
    await runtime.scheduler.idle();
    expect(sinkLengths).toEqual([3]);

    // Set a new array with different length using the current transaction
    arrayCell.withTx(tx).set([1, 2, 3, 4, 5]);
    await tx.commit();
    tx = runtime.edit();

    // Wait for scheduler to process
    await runtime.scheduler.idle();

    // Verify sink was called with new length
    expect(sinkLengths).toEqual([3, 5]);

    cancel();
  });

  it("should trigger computation when array source changes via push", async () => {
    // This tests: when a source array has an element pushed, a computation
    // that reads it should be marked dirty and re-run on pull.
    // This simulates: visiblePieces = computed(() => allPieces.filter(...))

    const sourceArray = runtime.getCell<{ name: string; hidden: boolean }[]>(
      space,
      "source-array-map-test",
      undefined,
      tx,
    );
    sourceArray.set([
      { name: "item1", hidden: false },
      { name: "item2", hidden: true },
    ]);

    const filteredCell = runtime.getCell<string[]>(
      space,
      "filtered-array-map-test",
      undefined,
      tx,
    );
    filteredCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track how many times the computation runs
    let computationRunCount = 0;

    // Create a computation that filters the source
    const filterAction: Action = (actionTx) => {
      computationRunCount++;
      const source = sourceArray.withTx(actionTx).get();
      const filtered = source
        .filter((item) => !item.hidden)
        .map((item) => item.name);
      filteredCell.withTx(actionTx).send(filtered);
    };

    runtime.scheduler.subscribe(
      filterAction,
      {
        reads: [sourceArray.getAsNormalizedFullLink()],
        writes: [filteredCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // Pull to trigger initial computation
    await filteredCell.withTx(tx).pull();
    await runtime.scheduler.idle();
    expect(computationRunCount).toBe(1);
    expect(filteredCell.withTx(tx).get()).toEqual(["item1"]);

    // Now push a new item to the source array
    sourceArray.withTx(tx).push({ name: "item3", hidden: false });
    await tx.commit();
    tx = runtime.edit();

    // Pull again - the computation SHOULD run because its input changed
    await filteredCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    // BUG: If computationRunCount is still 1, the computation didn't re-run
    // when the source array changed via push
    expect(computationRunCount).toBe(2);
    expect(filteredCell.withTx(tx).get()).toEqual(["item1", "item3"]);
  });

  it("should notify sink on computed result when source array grows (no explicit pull)", async () => {
    // This tests the renderer pattern: sink observes computed result,
    // and should be notified when source array (which feeds the computation)
    // has elements added. This is the pattern used in the Notes UI.
    //
    // Expected behavior:
    // 1. Source array changes (push)
    // 2. Computation that reads source is marked dirty
    // 3. scheduleAffectedEffects finds sink as a dependent and schedules it
    // 4. Computation runs, then sink is notified with new value

    const sourceArray = runtime.getCell<string[]>(
      space,
      "renderer-source-array",
      undefined,
      tx,
    );
    sourceArray.set(["a", "b"]);

    const computedCell = runtime.getCell<string[]>(
      space,
      "renderer-computed",
      undefined,
      tx,
    );
    computedCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track sink notifications
    const sinkValues: string[][] = [];

    // Create a computation that transforms the source
    const transformAction: Action = (actionTx) => {
      const source = sourceArray.withTx(actionTx).get();
      const transformed = source.map((s) => s.toUpperCase());
      computedCell.withTx(actionTx).send(transformed);
    };

    runtime.scheduler.subscribe(
      transformAction,
      {
        reads: [sourceArray.getAsNormalizedFullLink()],
        writes: [computedCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // Set up sink on computed result (simulating renderer effect)
    const cancel = computedCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        sinkValues.push([...value]);
      }
    });

    // Pull to trigger initial computation
    await computedCell.withTx(tx).pull();
    await runtime.scheduler.idle();
    expect(sinkValues.length).toBeGreaterThanOrEqual(1);
    expect(sinkValues[sinkValues.length - 1]).toEqual(["A", "B"]);

    // Push to source array - use a FRESH transaction to avoid consistency issues
    // (the previous tx was used by the sink which read computedCell)
    const pushTx = runtime.edit();
    sourceArray.withTx(pushTx).push("c");
    await pushTx.commit();

    // The sink SHOULD be notified with the updated computed value
    // Without explicit pull - just let the scheduler run
    runtime.scheduler.queueExecution();
    await runtime.scheduler.idle();

    // Verify sink was notified with updated value
    expect(sinkValues.length).toBeGreaterThanOrEqual(2);
    expect(sinkValues[sinkValues.length - 1]).toEqual(["A", "B", "C"]);

    cancel();
  });

  it("should notify renderer when allPieces array is pushed (Notes UI simulation)", async () => {
    // This simulates the actual Notes UI flow:
    // - Space has allPieces Cell (array of pieces)
    // - visiblePieces computation filters allPieces
    // - Renderer effect observes visiblePieces and renders the list
    // - User creates a new note which pushes to allPieces
    // - Renderer should be notified and re-render with new note

    // Define schemas for realistic data
    const pieceSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        isHidden: { type: "boolean" },
      },
      required: ["name"],
    } as const satisfies JSONSchema;

    const allPiecesSchema = {
      type: "array",
      items: pieceSchema,
    } as const satisfies JSONSchema;

    const spaceSchema = {
      type: "object",
      properties: {
        // Not using asCell: true here - we want inline array data for simplicity
        allPieces: allPiecesSchema,
      },
    } as const satisfies JSONSchema;

    // Create space cell with allPieces
    const spaceCell = runtime.getCell(space, "notes-ui-space", spaceSchema, tx);
    spaceCell.set({
      allPieces: [
        { name: "Existing Note 1", isHidden: false },
        { name: "Hidden Note", isHidden: true },
      ],
    });
    await tx.commit();
    tx = runtime.edit();

    // Get the allPieces subcell
    const allPiecesCell = spaceCell.key("allPieces");

    // Create visiblePieces cell for computed output
    const visiblePiecesCell = runtime.getCell(
      space,
      "visible-pieces",
      { type: "array", items: pieceSchema },
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track renderer notifications
    const renderedValues: { name: string }[][] = [];

    // Create computation: visiblePieces = allPieces.filter(c => !c.isHidden)
    const computeVisiblePieces: Action = function computeVisiblePieces(
      actionTx,
    ) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      // Now pieces should be an array since we don't have asCell: true
      const visible = pieces.filter((c) => !c.isHidden);
      visiblePiecesCell.withTx(actionTx).send(visible);
    };

    // Subscribe computation with schema-aware reads/writes
    runtime.scheduler.subscribe(
      computeVisiblePieces,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // Create renderer effect (sink on visiblePieces)
    const cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Initial pull to trigger computation and renderer
    await visiblePiecesCell.withTx(tx).pull();

    // Verify initial render shows only visible pieces
    expect(renderedValues.length).toBeGreaterThanOrEqual(1);
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Existing Note 1", isHidden: false },
    ]);

    // Simulate creating a new note and pushing to allPieces
    // (This is what happens when user creates a note in notebook.tsx)
    const createNoteTx = runtime.edit();
    allPiecesCell.withTx(createNoteTx).push({
      name: "New Note",
      isHidden: false,
    });
    await createNoteTx.commit();

    // Let the scheduler process the change
    await runtime.scheduler.idle();

    // Renderer should have been notified with updated visible pieces
    expect(renderedValues.length).toBeGreaterThanOrEqual(2);
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Existing Note 1", isHidden: false },
      { name: "New Note", isHidden: false },
    ]);

    cancelRenderer();
    runtime.scheduler.unsubscribe(computeVisiblePieces);
  });

  it("should handle nested cell updates in allPieces pattern", async () => {
    // More complex test: allPieces contains cell references (like real usage)
    // When a new piece is pushed, the renderer should see it

    const spaceSchema = {
      type: "object",
      properties: {
        allPieces: {
          type: "array",
          items: { type: "object" },
          // Not using asCell: true - testing inline array data
        },
      },
    } as const satisfies JSONSchema;

    // Create space with allPieces - start with 1 item like the first test
    const spaceCell = runtime.getCell(
      space,
      "nested-allpieces-space",
      spaceSchema,
      tx,
    );
    spaceCell.set({ allPieces: [{ name: "Initial Piece" }] });
    await tx.commit();
    tx = runtime.edit();

    const allPiecesCell = spaceCell.key("allPieces");

    // Track what the "renderer" sees
    const renderedPieceCount: number[] = [];

    // Create a simple computation that counts pieces
    const countCell = runtime.getCell(
      space,
      "piece-count",
      { type: "number" },
      tx,
    );
    countCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const countPieces: Action = function countPieces(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      countCell.withTx(actionTx).send(pieces.length);
    };

    runtime.scheduler.subscribe(
      countPieces,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [countCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // Renderer effect
    const cancelRenderer = countCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedPieceCount.push(value);
      }
    });

    // Initial pull - we start with 1 item
    await countCell.withTx(tx).pull();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(1);

    // Push first new piece (total should be 2)
    const tx1 = runtime.edit();
    allPiecesCell.withTx(tx1).push({ name: "Piece 1" });
    await tx1.commit();

    await runtime.scheduler.idle();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(2);

    // Push second piece (total should be 3)
    const tx2 = runtime.edit();
    allPiecesCell.withTx(tx2).push({ name: "Piece 2" });
    await tx2.commit();

    await runtime.scheduler.idle();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(3);

    // Push third piece (total should be 4)
    const tx3 = runtime.edit();
    allPiecesCell.withTx(tx3).push({ name: "Piece 3" });
    await tx3.commit();

    await runtime.scheduler.idle();
    expect(renderedPieceCount[renderedPieceCount.length - 1]).toBe(4);

    cancelRenderer();
    runtime.scheduler.unsubscribe(countPieces);
  });

  it("should see updated data after unsubscribe/resubscribe (navigation flow)", async () => {
    // This simulates the ACTUAL bug flow:
    // 1. Default app is mounted (sink subscribed)
    // 2. Navigate to note editor (sink unsubscribed)
    // 3. Create note (push while unsubscribed)
    // 4. Navigate back (sink re-subscribed)
    // 5. Should see new data

    const arraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    } as const satisfies JSONSchema;

    // Create allPieces array with initial data
    const allPiecesCell = runtime.getCell(
      space,
      "nav-flow-allpieces",
      arraySchema,
      tx,
    );
    allPiecesCell.set([{ name: "Initial Note" }]);
    await tx.commit();
    tx = runtime.edit();

    // Create computed cell (visiblePieces)
    const visiblePiecesCell = runtime.getCell(
      space,
      "nav-flow-visible",
      arraySchema,
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track what renderer sees
    const renderedValues: { name: string }[][] = [];

    // Computation: copy allPieces to visiblePieces
    const computeVisible: Action = function computeVisible(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    runtime.scheduler.subscribe(
      computeVisible,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    // STEP 1: Mount default app (subscribe renderer)
    let cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Initial pull to see data
    await visiblePiecesCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
    ]);

    // STEP 2: Navigate away (unmount default app, unsubscribe renderer)
    cancelRenderer();

    // STEP 3: Create note while on another page (push while unsubscribed)
    const createTx = runtime.edit();
    allPiecesCell.withTx(createTx).push({ name: "New Note" });
    await createTx.commit();

    // STEP 4: Navigate back (remount default app, resubscribe renderer)
    const tx2 = runtime.edit();
    cancelRenderer = visiblePiecesCell.withTx(tx2).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Pull to get fresh data
    await visiblePiecesCell.withTx(tx2).pull();
    await runtime.scheduler.idle();

    // STEP 5: Should see both notes
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
      { name: "New Note" },
    ]);

    cancelRenderer();
    runtime.scheduler.unsubscribe(computeVisible);
  });

  it("should see updated data when computation is also unsubscribed (full navigation)", async () => {
    // Even more realistic: when navigating away, the WHOLE piece (including
    // its computation) might get stopped, not just the renderer sink.
    // This is what runner.stop() does.

    const arraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    } as const satisfies JSONSchema;

    // Create allPieces array with initial data
    const allPiecesCell = runtime.getCell(
      space,
      "full-nav-allpieces",
      arraySchema,
      tx,
    );
    allPiecesCell.set([{ name: "Initial Note" }]);
    await tx.commit();
    tx = runtime.edit();

    // Create computed cell (visiblePieces)
    const visiblePiecesCell = runtime.getCell(
      space,
      "full-nav-visible",
      arraySchema,
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track what renderer sees
    const renderedValues: { name: string }[][] = [];

    // Computation: copy allPieces to visiblePieces
    const computeVisible: Action = function computeVisible(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    // STEP 1: Mount default app piece
    let cancelComputation = runtime.scheduler.subscribe(
      computeVisible,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    let cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    await visiblePiecesCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
    ]);

    // STEP 2: Navigate away - unsubscribe BOTH renderer AND computation
    cancelRenderer();
    cancelComputation();

    // STEP 3: Create note while on another page
    const createTx = runtime.edit();
    allPiecesCell.withTx(createTx).push({ name: "New Note" });
    await createTx.commit();

    // STEP 4: Navigate back - resubscribe BOTH computation AND renderer
    cancelComputation = runtime.scheduler.subscribe(
      computeVisible,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    const tx2 = runtime.edit();
    cancelRenderer = visiblePiecesCell.withTx(tx2).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // Pull to get fresh data
    await visiblePiecesCell.withTx(tx2).pull();
    await runtime.scheduler.idle();

    // Should see both notes
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
      { name: "New Note" },
    ]);

    cancelRenderer();
    cancelComputation();
  });

  it("should see fresh data when a NEW computation is created (pattern remount)", async () => {
    // This simulates what happens when a pattern remounts:
    // - The computed value output cell is REUSED (same cause = same cell)
    // - But a NEW computation action is created each time
    // - The sink reads from the output cell which has CACHED old value
    // - The new computation should run and update the value

    const arraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    } as const satisfies JSONSchema;

    // Create allPieces array with initial data
    const allPiecesCell = runtime.getCell(
      space,
      "pattern-remount-allpieces",
      arraySchema,
      tx,
    );
    allPiecesCell.set([{ name: "Initial Note" }]);
    await tx.commit();
    tx = runtime.edit();

    // IMPORTANT: The computed output cell is created with a FIXED cause
    // so it will be the SAME cell when the pattern remounts
    const visiblePiecesCell = runtime.getCell(
      space,
      "pattern-remount-visible-FIXED-CAUSE", // This cause stays same across remounts
      arraySchema,
      tx,
    );
    visiblePiecesCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Track what renderer sees
    const renderedValues: { name: string }[][] = [];

    // FIRST MOUNT: Create computation #1
    const computeVisible1: Action = function computeVisible1(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    let cancelComputation = runtime.scheduler.subscribe(
      computeVisible1,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    let cancelRenderer = visiblePiecesCell.withTx(tx).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    await visiblePiecesCell.withTx(tx).pull();
    await runtime.scheduler.idle();

    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
    ]);

    // UNMOUNT: Stop pattern
    cancelRenderer();
    cancelComputation();

    // PUSH while unmounted
    const createTx = runtime.edit();
    allPiecesCell.withTx(createTx).push({ name: "New Note" });
    await createTx.commit();

    // REMOUNT: Create computation #2 (NEW action, but SAME output cell)
    const computeVisible2: Action = function computeVisible2(actionTx) {
      const pieces = allPiecesCell.withTx(actionTx).get() ?? [];
      visiblePiecesCell.withTx(actionTx).send([...pieces]);
    };

    cancelComputation = runtime.scheduler.subscribe(
      computeVisible2,
      {
        reads: [allPiecesCell.getAsNormalizedFullLink()],
        writes: [visiblePiecesCell.getAsNormalizedFullLink()],
      },
      {},
    );

    const tx2 = runtime.edit();
    cancelRenderer = visiblePiecesCell.withTx(tx2).sink((value) => {
      if (value !== undefined) {
        renderedValues.push([...value]);
      }
    });

    // DON'T call pull() - just let the scheduler work naturally like the UI does
    runtime.scheduler.queueExecution();
    await runtime.scheduler.idle();

    // Should eventually see both notes
    expect(renderedValues[renderedValues.length - 1]).toEqual([
      { name: "Initial Note" },
      { name: "New Note" },
    ]);

    cancelRenderer();
    cancelComputation();
  });

  describe("runIdempotencyCheck", () => {
    it("detects non-idempotent accumulator", async () => {
      // An accumulator: each run appends to the array
      const log = runtime.getCell<string[]>(
        space,
        "idempotency-accumulator-log",
        undefined,
        tx,
      );
      log.set([]);
      await tx.commit();
      tx = runtime.edit();

      const accumulator: Action = (tx) => {
        const current = log.withTx(tx).get() ?? [];
        log.withTx(tx).send([...current, "entry"]);
      };
      runtime.scheduler.subscribe(
        accumulator,
        { reads: [], writes: [] },
        {},
      );
      await runtime.scheduler.idle();

      const result = await runtime.scheduler.runIdempotencyCheck();
      expect(result.nonIdempotent.length).toBeGreaterThan(0);
    });

    it("passes idempotent computation", async () => {
      // Idempotent: always writes the same derived value
      const input = runtime.getCell<number>(
        space,
        "idempotency-idempotent-input",
        undefined,
        tx,
      );
      input.set(5);
      const output = runtime.getCell<number>(
        space,
        "idempotency-idempotent-output",
        undefined,
        tx,
      );
      output.set(0);
      await tx.commit();
      tx = runtime.edit();

      const doubler: Action = (tx) => {
        output.withTx(tx).send(input.withTx(tx).get() * 2);
      };
      runtime.scheduler.subscribe(doubler, { reads: [], writes: [] }, {});
      await runtime.scheduler.idle();

      const result = await runtime.scheduler.runIdempotencyCheck();
      // Filter for our specific action
      const ourResult = result.nonIdempotent.filter((r) =>
        r.runs.some((run) =>
          Object.keys(run.writes).some((k) =>
            k.includes("idempotency-idempotent")
          )
        )
      );
      expect(ourResult.length).toBe(0);
    });

    it("detects Math.random non-idempotency", async () => {
      const output = runtime.getCell<number>(
        space,
        "idempotency-random-output",
        undefined,
        tx,
      );
      output.set(0);
      await tx.commit();
      tx = runtime.edit();

      const randomWriter: Action = (tx) => {
        output.withTx(tx).send(Math.random());
      };
      runtime.scheduler.subscribe(
        randomWriter,
        { reads: [], writes: [] },
        {},
      );
      await runtime.scheduler.idle();

      const result = await runtime.scheduler.runIdempotencyCheck();
      expect(result.nonIdempotent.length).toBeGreaterThan(0);
    });
  });
});

describe("push-triggered filtering", () => {
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

  it("should track mightWrite from actual writes", async () => {
    const cell = runtime.getCell<number>(
      space,
      "mightwrite-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(42);
    };

    // Initially no mightWrite
    expect(runtime.scheduler.getMightWrite(action)).toBeUndefined();

    // Run action
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();

    // mightWrite should now include the cell
    const mightWrite = runtime.scheduler.getMightWrite(action);
    expect(mightWrite).toBeDefined();
    expect(mightWrite!.length).toBeGreaterThan(0);
  });

  it("should accumulate mightWrite over multiple runs", async () => {
    const cell1 = runtime.getCell<number>(space, "mw-accum-1", undefined, tx);
    const cell2 = runtime.getCell<number>(space, "mw-accum-2", undefined, tx);
    cell1.set(0);
    cell2.set(0);
    await tx.commit();
    tx = runtime.edit();

    let writeToCell2 = false;
    const action: Action = (actionTx) => {
      cell1.withTx(actionTx).send(1);
      if (writeToCell2) {
        cell2.withTx(actionTx).send(2);
      }
    };

    // First run - writes only to cell1
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell1.getAsNormalizedFullLink()] },
      {},
    );
    await cell1.pull();

    const mightWrite1 = runtime.scheduler.getMightWrite(action);
    const initialLength = mightWrite1?.length || 0;

    // Second run - writes to both cells
    writeToCell2 = true;
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        writes: [
          cell1.getAsNormalizedFullLink(),
          cell2.getAsNormalizedFullLink(),
        ],
      },
      {},
    );
    await cell2.pull();

    // mightWrite should have grown
    const mightWrite2 = runtime.scheduler.getMightWrite(action);
    expect(mightWrite2!.length).toBeGreaterThan(initialLength);
  });

  it("should track filter stats", async () => {
    runtime.scheduler.resetFilterStats();

    const cell = runtime.getCell<number>(space, "filter-stats", undefined, tx);
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      {},
    );
    await cell.pull();

    const stats = runtime.scheduler.getFilterStats();
    // Action should have executed (not filtered)
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should allow first run even without pushTriggered (default scheduling)", async () => {
    runtime.scheduler.enablePullMode();
    runtime.scheduler.resetFilterStats();

    const cell = runtime.getCell<number>(
      space,
      "first-run-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // First run with default scheduling should work
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();

    expect(runCount).toBe(1);
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBeGreaterThan(0);
    expect(stats.filtered).toBe(0);
  });

  it("should use pushTriggered to track storage-triggered actions", async () => {
    runtime.scheduler.enablePullMode();

    const cell = runtime.getCell<number>(
      space,
      "push-triggered-test",
      undefined,
      tx,
    );
    cell.set(1);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe as effect - first run
    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await cell.pull();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Change cell via external means (simulating storage change)
    cell.withTx(tx).send(100);
    await tx.commit();
    tx = runtime.edit();
    await cell.pull();

    // Action should have been triggered by storage change and run
    expect(runCount).toBe(2);

    // Verify it was tracked as push-triggered (executed, not filtered)
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should not filter actions scheduled with default scheduling", async () => {
    runtime.scheduler.enablePullMode();

    const cell = runtime.getCell<number>(
      space,
      "schedule-immed-filter",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Run once to establish mightWrite
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Run again with default scheduling - should bypass filter
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();

    expect(runCount).toBe(2);
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.filtered).toBe(0);
  });

  it("should reset filter stats", () => {
    runtime.scheduler.resetFilterStats();
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.filtered).toBe(0);
    expect(stats.executed).toBe(0);
  });
});

describe("cycle convergence", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for cycle-aware convergence tests
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should handle cycles implicitly via re-dirtying detection", async () => {
    // Test that cycles are detected implicitly when actions re-dirty processed actions
    runtime.scheduler.enablePullMode();

    // Create cells for a simple converging cycle: A → B → A
    const cellA = runtime.getCell<number>(
      space,
      "cycle-detect-A",
      undefined,
      tx,
    );
    cellA.set(1);
    const cellB = runtime.getCell<number>(
      space,
      "cycle-detect-B",
      undefined,
      tx,
    );
    cellB.set(0);
    const output = runtime.getCell<number>(
      space,
      "cycle-detect-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let actionARunCount = 0;
    let actionBRunCount = 0;
    let effectRunCount = 0;

    // Action A: reads A, writes B (computation)
    const actionA: Action = (actionTx) => {
      actionARunCount++;
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val + 1);
    };

    // Action B: reads B, writes A (creates cycle, but converges)
    const actionB: Action = (actionTx) => {
      actionBRunCount++;
      const val = cellB.withTx(actionTx).get();
      // Only update if we haven't converged (val < 5 means cycle continues)
      if (val < 5) {
        cellA.withTx(actionTx).send(val);
      }
    };

    // Effect: observes cycle output (required to drive pull-based scheduling)
    const effect: Action = (actionTx) => {
      effectRunCount++;
      const val = cellB.withTx(actionTx).get();
      output.withTx(actionTx).send(val);
    };

    // Subscribe both computations first
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      {},
    );

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellA.getAsNormalizedFullLink()],
      },
      {},
    );

    // Subscribe effect to drive the pull
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [output.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );

    // Wait for scheduler to settle
    await runtime.scheduler.idle();

    // All actions should have run (cycle was detected and handled)
    expect(actionARunCount).toBeGreaterThan(0);
    expect(actionBRunCount).toBeGreaterThan(0);
    expect(effectRunCount).toBeGreaterThan(0);
    // The cycle should make progress - cellB should have been updated from initial 0
    expect(cellB.get()).toBeGreaterThan(0);
  });

  it("should run fast cycle convergence method", async () => {
    // This test verifies the fast cycle convergence logic by directly
    // testing with default scheduling (which bypasses pull mode complexity)
    runtime.scheduler.enablePullMode();

    // Create a simple dependency chain
    const counter = runtime.getCell<number>(
      space,
      "fast-cycle-counter",
      undefined,
      tx,
    );
    counter.set(0);
    const doubled = runtime.getCell<number>(
      space,
      "fast-cycle-doubled",
      undefined,
      tx,
    );
    doubled.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Computation: doubles the counter
    const computation: Action = (actionTx) => {
      const val = counter.withTx(actionTx).get();
      doubled.withTx(actionTx).send(val * 2);
    };

    // Subscribe to ensure it runs immediately (default behavior)
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [counter.getAsNormalizedFullLink()],
        writes: [doubled.getAsNormalizedFullLink()],
      },
      {},
    );
    await doubled.pull();

    // After initial run, doubled should be 0 (0 * 2)
    expect(doubled.get()).toBe(0);

    // Update counter and run again
    counter.withTx(tx).send(5);
    await tx.commit();
    tx = runtime.edit();

    // Subscribe again to re-run
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [counter.getAsNormalizedFullLink()],
        writes: [doubled.getAsNormalizedFullLink()],
      },
      {},
    );
    await doubled.pull();

    // Now doubled should be 10 (5 * 2)
    expect(doubled.get()).toBe(10);
  });

  it("should enforce iteration limit for non-converging cycles", async () => {
    runtime.scheduler.enablePullMode();

    // Create a non-converging cycle (always increments)
    const cellA = runtime.getCell<number>(
      space,
      "non-converge-A",
      undefined,
      tx,
    );
    cellA.set(0);
    const cellB = runtime.getCell<number>(
      space,
      "non-converge-B",
      undefined,
      tx,
    );
    cellB.set(0);
    const output = runtime.getCell<number>(
      space,
      "non-converge-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCountA = 0;
    let runCountB = 0;

    // Action A: increments based on B
    const actionA: Action = (actionTx) => {
      runCountA++;
      const val = cellB.withTx(actionTx).get();
      cellA.withTx(actionTx).send(val + 1);
    };

    // Action B: increments based on A (infinite loop)
    const actionB: Action = (actionTx) => {
      runCountB++;
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val + 1);
    };

    // Effect to observe the cycle and drive pull-based scheduling
    const effect: Action = (actionTx) => {
      const val = cellB.withTx(actionTx).get();
      output.withTx(actionTx).send(val);
    };

    // Subscribe both computations
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellA.getAsNormalizedFullLink()],
      },
      {},
    );

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      {},
    );

    // Subscribe effect to drive the pull
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [output.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );

    // Let the cycle run - it should stop after hitting the limit
    // Multiple idle() calls allow async storage notifications to trigger re-runs
    for (let i = 0; i < 30; i++) {
      await runtime.scheduler.idle();
      // Small delay to let async storage notifications fire
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The cycle should have stopped due to iteration limit
    // (either via MAX_ITERATIONS_PER_RUN or MAX_CYCLE_ITERATIONS)
    // Total runs should be bounded, not infinite
    expect(runCountA + runCountB).toBeLessThan(500);

    // The cycle ran and should have been bounded
    // Note: With implicit cycle detection, errors may or may not be thrown
    // depending on timing. The key invariant is that runs are bounded.
    expect(runCountA + runCountB).toBeGreaterThan(0);
  });

  it("should not create infinite loops in collectDirtyDependencies", async () => {
    runtime.scheduler.enablePullMode();

    // Create a simple dependency structure
    const source = runtime.getCell<number>(
      space,
      "collect-deps-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "collect-deps-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    const computation: Action = (actionTx) => {
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [result.getAsNormalizedFullLink()],
      },
      {},
    );
    await result.pull();

    // Initial result should be 2 (1 * 2)
    expect(result.get()).toBe(2);

    // Change source
    source.withTx(tx).send(9);
    await tx.commit();
    tx = runtime.edit();

    // Re-subscribe to force a re-run (simulating what happens in real usage)
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [result.getAsNormalizedFullLink()],
      },
      {},
    );

    // Wait for updates
    await result.pull();

    // Final result should be based on last value
    expect(result.get()).toBe(18); // 9 * 2
  });

  it("should handle cycles during dependency collection without infinite recursion", async () => {
    runtime.scheduler.enablePullMode();

    // Create cells that form a cycle
    const cellA = runtime.getCell<number>(
      space,
      "collect-cycle-A",
      undefined,
      tx,
    );
    cellA.set(0);
    const cellB = runtime.getCell<number>(
      space,
      "collect-cycle-B",
      undefined,
      tx,
    );
    cellB.set(0);
    const cellC = runtime.getCell<number>(
      space,
      "collect-cycle-C",
      undefined,
      tx,
    );
    cellC.set(0);
    await tx.commit();
    tx = runtime.edit();

    // A → B → C → A cycle
    const actionA: Action = (actionTx) => {
      const val = cellC.withTx(actionTx).get();
      if (val < 3) {
        cellA.withTx(actionTx).send(val + 1);
      }
    };

    const actionB: Action = (actionTx) => {
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val);
    };

    const actionC: Action = (actionTx) => {
      const val = cellB.withTx(actionTx).get();
      cellC.withTx(actionTx).send(val);
    };

    // Subscribe all actions
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [cellC.getAsNormalizedFullLink()],
        writes: [cellA.getAsNormalizedFullLink()],
      },
      {},
    );
    await cellA.pull();

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [cellA.getAsNormalizedFullLink()],
        writes: [cellB.getAsNormalizedFullLink()],
      },
      {},
    );
    await cellB.pull();

    runtime.scheduler.subscribe(
      actionC,
      {
        reads: [cellB.getAsNormalizedFullLink()],
        writes: [cellC.getAsNormalizedFullLink()],
      },
      {},
    );
    await cellC.pull();

    // The cycle should converge (value reaches 3)
    // This tests that collectDirtyDependencies doesn't infinitely recurse
    expect(cellC.get()).toBeLessThanOrEqual(3);
  });

  it("should handle larger cycles without hanging", async () => {
    runtime.scheduler.enablePullMode();

    const cellA = runtime.getCell<number>(space, "4cycle-A", undefined, tx);
    cellA.set(1);
    const cellB = runtime.getCell<number>(space, "4cycle-B", undefined, tx);
    cellB.set(0);
    const cellC = runtime.getCell<number>(space, "4cycle-C", undefined, tx);
    cellC.set(0);
    const cellD = runtime.getCell<number>(space, "4cycle-D", undefined, tx);
    cellD.set(0);
    await tx.commit();
    tx = runtime.edit();

    let totalRuns = 0;

    // A → B → C → D → A (converges when D reaches 4)
    const actionA: Action = (actionTx) => {
      totalRuns++;
      const val = cellD.withTx(actionTx).get();
      if (val < 4) cellA.withTx(actionTx).send(val + 1);
    };
    const actionB: Action = (actionTx) => {
      totalRuns++;
      cellB.withTx(actionTx).send(cellA.withTx(actionTx).get());
    };
    const actionC: Action = (actionTx) => {
      totalRuns++;
      cellC.withTx(actionTx).send(cellB.withTx(actionTx).get());
    };
    const actionD: Action = (actionTx) => {
      totalRuns++;
      cellD.withTx(actionTx).send(cellC.withTx(actionTx).get());
    };

    // Subscribe all and let them run
    for (const action of [actionA, actionB, actionC, actionD]) {
      runtime.scheduler.subscribe(
        action,
        { reads: [], writes: [] },
        {},
      );
      await cellD.pull();
    }

    // Let the cycle run for a few iterations
    for (let i = 0; i < 10; i++) {
      await cellD.pull();
    }

    // Should converge without infinite loop
    expect(cellD.get()).toBeLessThanOrEqual(4);
    // Should be bounded, not infinite
    expect(totalRuns).toBeLessThan(500);
  });

  it("should handle self-referential action without infinite loop", async () => {
    runtime.scheduler.enablePullMode();

    const counter = runtime.getCell<number>(
      space,
      "self-ref-counter",
      undefined,
      tx,
    );
    counter.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    // Action reads and writes the same cell (converges after 5)
    const selfRefAction: Action = (actionTx) => {
      runCount++;
      const val = counter.withTx(actionTx).get();
      if (val < 5) {
        counter.withTx(actionTx).send(val + 1);
      }
    };

    runtime.scheduler.subscribe(
      selfRefAction,
      { reads: [], writes: [] },
      {},
    );

    // Let it run for a while
    for (let i = 0; i < 20; i++) {
      await counter.pull();
    }

    // Should have converged and stopped at some point
    // The exact value depends on how reactive updates propagate
    expect(counter.get()).toBeLessThanOrEqual(5);
    // Should not run infinitely
    expect(runCount).toBeLessThan(200);
  });

  it("should handle mixed cyclic and acyclic actions without hanging", async () => {
    runtime.scheduler.enablePullMode();

    // Acyclic: source → computed
    const source = runtime.getCell<number>(
      space,
      "mixed-source",
      undefined,
      tx,
    );
    source.set(1);
    const computed = runtime.getCell<number>(
      space,
      "mixed-computed",
      undefined,
      tx,
    );
    computed.set(0);

    // Cyclic: cycleA ↔ cycleB
    const cycleA = runtime.getCell<number>(
      space,
      "mixed-cycleA",
      undefined,
      tx,
    );
    cycleA.set(1);
    const cycleB = runtime.getCell<number>(
      space,
      "mixed-cycleB",
      undefined,
      tx,
    );
    cycleB.set(0);
    await tx.commit();
    tx = runtime.edit();

    let acyclicRuns = 0;
    let cycleRuns = 0;

    const acyclicAction: Action = (actionTx) => {
      acyclicRuns++;
      computed.withTx(actionTx).send(source.withTx(actionTx).get() * 2);
    };

    const cycleActionA: Action = (actionTx) => {
      cycleRuns++;
      cycleB.withTx(actionTx).send(cycleA.withTx(actionTx).get());
    };

    const cycleActionB: Action = (actionTx) => {
      cycleRuns++;
      const val = cycleB.withTx(actionTx).get();
      if (val < 5) cycleA.withTx(actionTx).send(val);
    };

    // Subscribe all with proper writes for pull mode to discover dependencies
    runtime.scheduler.subscribe(
      acyclicAction,
      {
        reads: [source.getAsNormalizedFullLink()],
        writes: [computed.getAsNormalizedFullLink()],
      },
      {},
    );
    await computed.pull();

    runtime.scheduler.subscribe(
      cycleActionA,
      {
        reads: [cycleA.getAsNormalizedFullLink()],
        writes: [cycleB.getAsNormalizedFullLink()],
      },
      {},
    );
    await cycleB.pull();

    runtime.scheduler.subscribe(
      cycleActionB,
      {
        reads: [cycleB.getAsNormalizedFullLink()],
        writes: [cycleA.getAsNormalizedFullLink()],
      },
      {},
    );
    await cycleA.pull();

    // Let them all run
    for (let i = 0; i < 10; i++) {
      await cycleB.pull();
    }

    // The acyclic action should have run at least once
    expect(acyclicRuns).toBeGreaterThanOrEqual(1);

    // The computed value should be correct
    expect(computed.get()).toBe(2); // 1 * 2

    // Cycle runs should be bounded
    expect(cycleRuns).toBeLessThan(500);
  });
});
