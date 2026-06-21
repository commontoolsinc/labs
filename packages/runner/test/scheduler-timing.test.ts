// Scheduler debounce and throttle tests.

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

  it("should cancel pending debounce wake on dispose", async () => {
    const local = createSchedulerTestRuntime(`${import.meta.url}#dispose-wake`);
    let runCount = 0;
    const action: Action = () => {
      runCount++;
    };

    try {
      local.runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true, debounce: 50 },
      );
      expect(runCount).toBe(0);

      local.runtime.scheduler.dispose();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(runCount).toBe(0);
    } finally {
      await local.tx.commit();
      // NB: only the scheduler is disposed above (the behaviour under test).
      // Calling runtime.dispose() here as well leaks a still-pending promise
      // (the runtime dispose path does not compose with an already-disposed
      // scheduler), so we close storage directly.
      await local.storageManager.close();
    }
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

  it("auto-debounces slow write-less effects; pull roots opt out via noDebounce", () => {
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

    // v2 (spec §8.2): the auto-debounce exemption is the explicit
    // noDebounce opt-out (pull() sets it); v1 exempted any write-less
    // effect via the demand-root writes proxy, which no longer exists.
    expect(runtime.scheduler.getDebounce(effect)).toBe(100);

    const protectedEffect: Action = () => {};
    runtime.scheduler.subscribe(protectedEffect, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true, noDebounce: true });

    scheduler.actionStats.set(scheduler.getActionId(protectedEffect), {
      runCount: 3,
      totalTime: 180,
      averageTime: 60,
      lastRunTime: 60,
      lastRunTimestamp: performance.now(),
    });

    scheduler.maybeAutoDebounce(protectedEffect);

    expect(runtime.scheduler.getDebounce(protectedEffect)).toBeUndefined();
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

  it("should allow clearDebounce to remove a manual debounce", async () => {
    const cell = runtime.getCell<number>(
      space,
      "clear-manual-debounce-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    runtime.scheduler.setDebounce(action, 500);
    expect(runtime.scheduler.getDebounce(action)).toBe(500);

    runtime.scheduler.clearDebounce(action);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
  });
});
