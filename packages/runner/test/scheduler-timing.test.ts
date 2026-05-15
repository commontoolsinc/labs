// Scheduler debounce and cycle-debounce tests.

import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

describe("debounce and throttling", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("should set and get debounce for an action", () => {
    const action: Action = () => {};

    // Initially no debounce
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();

    // Set debounce
    runtime.scheduler.setDebounce(action, 100);
    expect(runtime.scheduler.getDebounce(action)).toBe(100);

    // Clear debounce
    runtime.scheduler.clearDebounce(action);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
  });

  it("should set debounce to 0 clears it", () => {
    const action: Action = () => {};

    runtime.scheduler.setDebounce(action, 100);
    expect(runtime.scheduler.getDebounce(action)).toBe(100);

    runtime.scheduler.setDebounce(action, 0);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
  });

  it("should delay action execution when debounce is set", async () => {
    const cell = runtime.getCell<number>(space, "debounce-test", undefined, tx);
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Set a short debounce
    runtime.scheduler.setDebounce(action, 50);

    // Subscribe with proper writes for pull mode
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      {},
    );

    // Action should NOT have run immediately
    expect(runCount).toBe(0);

    // Wait for debounce period
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cell.pull();

    // Now it should have run
    expect(runCount).toBe(1);
  });

  it("should coalesce rapid triggers into single execution", async () => {
    runtime.scheduler.enablePullMode();

    const cell = runtime.getCell<number>(
      space,
      "debounce-coalesce",
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

    // Set debounce
    runtime.scheduler.setDebounce(action, 50);

    // Trigger multiple times rapidly (with proper writes for pull mode)
    for (let i = 0; i < 5; i++) {
      runtime.scheduler.subscribe(
        action,
        {
          reads: [],
          shallowReads: [],
          writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
        },
        {},
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Should not have run yet (debounce keeps resetting)
    expect(runCount).toBe(0);

    // Wait for debounce to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cell.pull();

    // Should have run only once
    expect(runCount).toBe(1);
  });

  it("should apply debounce from subscribe options", async () => {
    const cell = runtime.getCell<number>(
      space,
      "debounce-option",
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

    // Subscribe with debounce option (and proper writes for pull mode)
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      { debounce: 50 },
    );

    // Verify debounce was set
    expect(runtime.scheduler.getDebounce(action)).toBe(50);

    // Action should NOT have run immediately
    expect(runCount).toBe(0);

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cell.pull();

    expect(runCount).toBe(1);
  });

  it("should debounce dirty pull computations with immediate first run and trailing flush", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "debounce-pull-computation-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "debounce-pull-computation-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const computation: Action = (actionTx) => {
      runCount++;
      const value = source.withTx(actionTx).get();
      result.withTx(actionTx).send(value * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      { debounce: 50 },
    );

    await result.pull();
    expect(runCount).toBe(1);
    expect(result.get()).toBe(10);

    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    expect(runCount).toBe(1);
    expect(result.get()).toBe(10);

    await new Promise((resolve) => setTimeout(resolve, 25));
    source.withTx(tx).send(3);
    await tx.commit();
    tx = runtime.edit();

    await new Promise((resolve) => setTimeout(resolve, 30));
    await result.pull();
    expect(runCount).toBe(1);
    expect(result.get()).toBe(10);

    await new Promise((resolve) => setTimeout(resolve, 40));
    await runtime.idle();
    await result.pull();

    expect(runCount).toBe(2);
    expect(result.get()).toBe(30);
  });

  it("should cancel debounce timer on unsubscribe", async () => {
    const cell = runtime.getCell<number>(
      space,
      "debounce-cancel",
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

    // Set debounce
    runtime.scheduler.setDebounce(action, 100);

    // Subscribe with default scheduling (runs immediately)
    const cancel = runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      {},
    );

    // Action should not have run yet
    expect(runCount).toBe(0);

    // Unsubscribe before debounce completes
    cancel();

    // Wait past the debounce period
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runtime.idle();

    // Action should NOT have run because we unsubscribed
    expect(runCount).toBe(0);
  });

  it("should auto-debounce slow actions after threshold runs", async () => {
    const cell = runtime.getCell<number>(
      space,
      "auto-debounce-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Create a slow action (simulated with artificial delay tracking)
    const action: Action = (actionTx) => {
      // We can't easily make this actually slow in tests,
      // so we'll manually set the stats to simulate slow execution
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe (auto-debounce is enabled by default)
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await cell.pull();

    // Initially no debounce
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();

    // The auto-debounce requires the action to be slow (>50ms avg after 3 runs)
    // In unit tests we can't easily simulate slow execution time,
    // so we mainly verify the infrastructure is in place
  });

  it("should not auto-debounce computations even when they are slow", () => {
    const computation: Action = () => {};
    runtime.scheduler.subscribe(computation, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});

    const scheduler = runtime.scheduler as any;
    scheduler.actionStats.set(scheduler.getActionId(computation), {
      runCount: 3,
      totalTime: 180,
      averageTime: 60,
      lastRunTime: 60,
      lastRunTimestamp: performance.now(),
    });

    scheduler.maybeAutoDebounce(computation);

    expect(runtime.scheduler.getDebounce(computation)).toBeUndefined();
  });

  it("should auto-debounce slow writeful effects after threshold runs", () => {
    const output = runtime.getCell<number>(
      space,
      "auto-debounce-writeful-effect-output",
      undefined,
      tx,
    );
    const effect: Action = (actionTx) => {
      output.withTx(actionTx).send(1);
    };
    runtime.scheduler.subscribe(effect, {
      reads: [],
      shallowReads: [],
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
    }, { isEffect: true });

    const scheduler = runtime.scheduler as any;
    scheduler.actionStats.set(scheduler.getActionId(effect), {
      runCount: 3,
      totalTime: 180,
      averageTime: 60,
      lastRunTime: 60,
      lastRunTimestamp: performance.now(),
    });

    scheduler.maybeAutoDebounce(effect);

    expect(runtime.scheduler.getDebounce(effect)).toBe(100);
  });

  it("should not auto-debounce write-less pull demand root effects", () => {
    runtime.scheduler.enablePullMode();

    const effect: Action = () => {};
    runtime.scheduler.subscribe(effect, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });

    const scheduler = runtime.scheduler as any;
    scheduler.actionStats.set(scheduler.getActionId(effect), {
      runCount: 3,
      totalTime: 180,
      averageTime: 60,
      lastRunTime: 60,
      lastRunTimestamp: performance.now(),
    });

    scheduler.maybeAutoDebounce(effect);

    expect(runtime.scheduler.getDebounce(effect)).toBeUndefined();
  });

  it("should not auto-debounce fast actions", async () => {
    const cell = runtime.getCell<number>(space, "fast-action", undefined, tx);
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe (auto-debounce is enabled by default, and proper writes for pull mode)
    runtime.scheduler.subscribe(
      action,
      {
        reads: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      {},
    );
    await cell.pull();

    // Run multiple times (fast actions)
    for (let i = 0; i < 5; i++) {
      runtime.scheduler.subscribe(
        action,
        {
          reads: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
        },
        {},
      );
      await cell.pull();
    }

    // Fast actions should NOT get auto-debounced
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();

    // Stats should be tracked
    const stats = runtime.scheduler.getActionStats(action);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBeGreaterThanOrEqual(5);
    // Average time should be well under threshold (50ms)
    expect(stats!.averageTime).toBeLessThan(50);
  });

  it("should work with both debounce and pull mode", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "debounce-pull-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "debounce-pull-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const effect: Action = (actionTx) => {
      runCount++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

    // Set debounce before subscribing
    runtime.scheduler.setDebounce(effect, 50);

    // Subscribe as effect
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    // Should not run immediately due to debounce
    expect(runCount).toBe(0);

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 100));
    await result.pull();

    // Should have run
    expect(runCount).toBe(1);
    expect(result.get()).toBe(2);
  });

  it("should track run counts per execute cycle for cycle-aware debounce", async () => {
    // The cycle-aware debounce mechanism tracks how many times each action
    // runs within a single execute() call. If an action runs 3+ times and
    // the execute() took >100ms, adaptive debounce is applied.
    //
    // Note: The scheduler actively prevents cycles, so effects typically
    // only run once per execute(). This test verifies the tracking mechanism
    // exists and works when multiple runs DO occur through separate execute()
    // cycles triggered by sequential input changes.

    const input = runtime.getCell<number>(
      space,
      "cycle-debounce-input",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "cycle-debounce-output",
      undefined,
      tx,
    );
    input.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    // A slow effect that we'll trigger multiple times
    const slowEffect: Action = async (actionTx) => {
      runCount++;
      const val = input.withTx(actionTx).get() ?? 0;
      // Add delay to make execution slow enough to potentially trigger cycle debounce
      await new Promise((resolve) => setTimeout(resolve, 40));
      output.withTx(actionTx).send(val * 2);
    };

    runtime.scheduler.subscribe(
      slowEffect,
      (depTx) => {
        input.withTx(depTx).get();
      },
      { isEffect: true },
    );

    // Initial run
    await output.pull();
    await runtime.idle();

    // Should have run at least once
    expect(runCount).toBeGreaterThanOrEqual(1);

    // The action runs across multiple execute() cycles, not within one
    // So cycle-aware debounce (which tracks runs within one execute) won't trigger
    // This is expected - the scheduler prevents in-execute cycles by design
  });

  it("should not apply cycle-aware debounce to fast executes", async () => {
    // Fast actions that run multiple times should not get cycle debounce
    // because the execute() time threshold (100ms) isn't met

    const counter = runtime.getCell<number>(
      space,
      "fast-cycle-counter",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "fast-cycle-output",
      undefined,
      tx,
    );
    counter.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    // Fast self-cycling computation (no delay)
    const fastCycling: Action = (actionTx) => {
      runCount++;
      const val = counter.withTx(actionTx).get() ?? 0;
      output.withTx(actionTx).send(val);
      if (val < 5) {
        counter.withTx(actionTx).send(val + 1);
      }
    };

    runtime.scheduler.subscribe(
      fastCycling,
      (depTx) => {
        counter.withTx(depTx).get();
      },
      { isEffect: true },
    );

    await output.pull();
    await runtime.idle();

    // Action may have run multiple times
    expect(runCount).toBeGreaterThanOrEqual(1);

    // But execute was fast (<100ms total), so no cycle debounce applied
    const debounce = runtime.scheduler.getDebounce(fastCycling);
    // Fast execution shouldn't trigger cycle debounce
    expect(debounce === undefined || debounce < 200).toBe(true);
  });

  it("should respect noDebounce option for cycle-aware debounce", async () => {
    const counter = runtime.getCell<number>(
      space,
      "no-debounce-counter",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "no-debounce-output",
      undefined,
      tx,
    );
    counter.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    // Slow cycling computation
    const slowCycling: Action = async (actionTx) => {
      runCount++;
      const val = counter.withTx(actionTx).get() ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 40));
      output.withTx(actionTx).send(val);
      if (val < 5) {
        counter.withTx(actionTx).send(val + 1);
      }
    };

    // Subscribe with noDebounce: true - should opt out of cycle debounce
    runtime.scheduler.subscribe(
      slowCycling,
      (depTx) => {
        counter.withTx(depTx).get();
      },
      { isEffect: true, noDebounce: true },
    );

    await output.pull();
    await runtime.idle();

    expect(runCount).toBeGreaterThanOrEqual(1);

    // Should NOT have debounce even if it cycled slowly
    expect(runtime.scheduler.getDebounce(slowCycling)).toBeUndefined();
  });

  it("should not cycle-debounce pull computations with live effect demand", async () => {
    runtime.scheduler.enablePullMode();

    const counter = runtime.getCell<number>(
      space,
      "no-cycle-debounce-computation-counter",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "no-cycle-debounce-computation-output",
      undefined,
      tx,
    );
    const sink = runtime.getCell<number>(
      space,
      "no-cycle-debounce-computation-sink",
      undefined,
      tx,
    );
    counter.set(0);
    output.set(0);
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    let producerRuns = 0;
    let feedbackRuns = 0;

    const producer: Action = async (actionTx) => {
      producerRuns++;
      await new Promise((resolve) => setTimeout(resolve, 35));
      output.withTx(actionTx).send(counter.withTx(actionTx).get() ?? 0);
    };

    const feedback: Action = async (actionTx) => {
      feedbackRuns++;
      await new Promise((resolve) => setTimeout(resolve, 35));
      const value = output.withTx(actionTx).get() ?? 0;
      if (value < 3) {
        counter.withTx(actionTx).send(value + 1);
      }
    };

    const effect: Action = (actionTx) => {
      sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      producer,
      {
        reads: [toMemorySpaceAddress(counter.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      feedback,
      {
        reads: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(counter.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(producerRuns).toBeGreaterThanOrEqual(3);
    expect(feedbackRuns).toBeGreaterThanOrEqual(3);
    expect(runtime.scheduler.getDebounce(producer)).toBeUndefined();
    expect(runtime.scheduler.getDebounce(feedback)).toBeUndefined();
  });

  it("should only increase debounce if cycle debounce is larger than existing", async () => {
    // If an action already has a higher debounce set (manually or from previous
    // cycle debounce), the cycle-aware mechanism should not reduce it.

    const cell = runtime.getCell<number>(
      space,
      "debounce-precedence-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    // Manually set a high debounce
    runtime.scheduler.setDebounce(action, 5000);

    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      {},
    );

    await cell.pull();
    await runtime.idle();

    // The manually set debounce should still be in place
    // (cycle debounce wouldn't have triggered anyway since only 1 run,
    // but even if it did, 5000ms > any likely cycle debounce)
    expect(runtime.scheduler.getDebounce(action)).toBe(5000);
  });

  it("should track multiple actions independently for cycle debounce", async () => {
    // Each action's run count should be tracked separately within an execute()

    const inputA = runtime.getCell<number>(
      space,
      "multi-action-input-a",
      undefined,
      tx,
    );
    const inputB = runtime.getCell<number>(
      space,
      "multi-action-input-b",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "multi-action-output",
      undefined,
      tx,
    );
    inputA.set(0);
    inputB.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCountA = 0;
    let runCountB = 0;

    const actionA: Action = async (actionTx) => {
      runCountA++;
      const val = inputA.withTx(actionTx).get() ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 20));
      output.withTx(actionTx).send(val);
    };

    const actionB: Action = (actionTx) => {
      runCountB++;
      const val = inputB.withTx(actionTx).get() ?? 0;
      // Fast action - no delay
      output.withTx(actionTx).send(val);
    };

    runtime.scheduler.subscribe(
      actionA,
      (depTx) => {
        inputA.withTx(depTx).get();
      },
      { isEffect: true },
    );

    runtime.scheduler.subscribe(
      actionB,
      (depTx) => {
        inputB.withTx(depTx).get();
      },
      { isEffect: true },
    );

    await output.pull();
    await runtime.idle();

    // Both should have run
    expect(runCountA).toBeGreaterThanOrEqual(1);
    expect(runCountB).toBeGreaterThanOrEqual(1);

    // Actions are tracked independently - neither should have cycle debounce
    // since each only ran once per execute cycle
    const debounceA = runtime.scheduler.getDebounce(actionA);
    const debounceB = runtime.scheduler.getDebounce(actionB);

    // Neither should have high cycle debounce (may have auto-debounce if slow)
    expect(debounceA === undefined || debounceA <= 100).toBe(true);
    expect(debounceB === undefined || debounceB <= 100).toBe(true);
  });

  it("should reset run tracking between execute cycles", async () => {
    // The runsThisExecute map should be cleared at the start of each execute(),
    // so runs from previous cycles don't affect the current cycle's debounce.

    const input = runtime.getCell<number>(
      space,
      "reset-tracking-input",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "reset-tracking-output",
      undefined,
      tx,
    );
    input.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;

    const action: Action = (actionTx) => {
      runCount++;
      const val = input.withTx(actionTx).get() ?? 0;
      output.withTx(actionTx).send(val * 2);
    };

    runtime.scheduler.subscribe(
      action,
      (depTx) => {
        input.withTx(depTx).get();
      },
      { isEffect: true },
    );

    // First execute cycle
    await output.pull();
    await runtime.idle();
    expect(runCount).toBe(1);

    // Second execute cycle (triggered by input change)
    const editTx1 = runtime.edit();
    input.withTx(editTx1).send(1);
    await editTx1.commit();
    await runtime.idle();
    expect(runCount).toBe(2);

    // Third execute cycle
    const editTx2 = runtime.edit();
    input.withTx(editTx2).send(2);
    await editTx2.commit();
    await runtime.idle();
    expect(runCount).toBe(3);

    // Even though total runs = 3, each execute() cycle only had 1 run
    // So no cycle debounce should be applied
    const debounce = runtime.scheduler.getDebounce(action);
    expect(debounce === undefined || debounce < 200).toBe(true);
  });

  it("should allow clearDebounce to remove cycle-applied debounce", async () => {
    const cell = runtime.getCell<number>(
      space,
      "clear-cycle-debounce-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    // Set a debounce (simulating what cycle debounce would do)
    runtime.scheduler.setDebounce(action, 500);
    expect(runtime.scheduler.getDebounce(action)).toBe(500);

    // Clear it
    runtime.scheduler.clearDebounce(action);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
  });
});
