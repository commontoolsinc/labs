// Pull scheduler core behavior and stale dependency propagation tests.

import { createDirtyDependencyTraceContext } from "../src/scheduler/diagnostics.ts";
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  getStaleSchedulerInternals,
  it,
  Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  Cell,
  EventHandler,
  EventPreflightMarker,
  IExtendedStorageTransaction,
  JSONSchema,
  RuntimeTelemetryMarker,
  SchedulerTestStorageManager,
  TelemetryAnnotations,
} from "./scheduler-test-utils.ts";

describe("pull-based scheduling", () => {
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

  it("should dispatch schema-marked streams without a materialized stream marker", async () => {
    const stream = runtime.getCell<{ amount: number }>(
      space,
      "schema-marked-stream-without-marker",
      {
        asCell: ["stream"],
        type: "object",
        properties: {
          amount: { type: "number" },
        },
      } as JSONSchema,
      tx,
    );
    const result = runtime.getCell<number>(
      space,
      "schema-marked-stream-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let handlerRuns = 0;
    runtime.scheduler.addEventHandler(
      (eventTx, event: { amount: number }) => {
        handlerRuns++;
        result.withTx(eventTx).send(event.amount);
      },
      stream.getAsNormalizedFullLink(),
    );

    stream.send({ amount: 7 });
    await runtime.scheduler.idle();

    expect(handlerRuns).toBe(1);
    expect(await result.pull()).toBe(7);
  });

  it("should mark computations as dirty in pull mode when source changes", async () => {
    // This test verifies that in pull mode, computations are marked dirty
    // rather than scheduled when their inputs change.

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
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
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
        shallowReads: [],
        writes: [toMemorySpaceAddress(target.getAsNormalizedFullLink())],
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

  it("should not re-run an effect for unrelated pending dependency collection", async () => {
    const observed = runtime.getCell<number>(
      space,
      "pending-dep-unrelated-observed",
      undefined,
      tx,
    );
    observed.set(1);
    const effectResult = runtime.getCell<number>(
      space,
      "pending-dep-unrelated-effect-result",
      undefined,
      tx,
    );
    effectResult.set(0);
    const unrelatedSource = runtime.getCell<number>(
      space,
      "pending-dep-unrelated-source",
      undefined,
      tx,
    );
    unrelatedSource.set(1);
    const unrelatedResult = runtime.getCell<number>(
      space,
      "pending-dep-unrelated-result",
      undefined,
      tx,
    );
    unrelatedResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;
    let unrelatedRuns = 0;

    const unrelatedComputation = ((actionTx: IExtendedStorageTransaction) => {
      unrelatedRuns++;
      unrelatedResult.withTx(actionTx).send(
        (unrelatedSource.withTx(actionTx).get() ?? 0) + 1,
      );
    }) as Action & Partial<TelemetryAnnotations>;
    unrelatedComputation.writes = [unrelatedResult.getAsNormalizedFullLink()];

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        observed.withTx(actionTx).get() ?? 0,
      );

      if (effectRuns === 1) {
        runtime.scheduler.subscribe(
          unrelatedComputation,
          (depTx) => {
            unrelatedSource.withTx(depTx).get();
          },
          {},
        );
      }
    };

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(observed.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(1);
    // v2 (spec §5.3): children created during a live effect's run get
    // provisional first-run demand; the v1 writeful-effect exception
    // keyed on run-learned writes, which no longer exist.
    expect(unrelatedRuns).toBe(1);
  });

  it("should re-run an effect for transitively related pending dependency collection", async () => {
    const source = runtime.getCell<number>(
      space,
      "pending-dep-transitive-source",
      undefined,
      tx,
    );
    source.set(2);
    const childResult = runtime.getCell<number>(
      space,
      "pending-dep-transitive-child-result",
      undefined,
      tx,
    );
    const parentResult = runtime.getCell<number>(
      space,
      "pending-dep-transitive-parent-result",
      undefined,
      tx,
    );
    parentResult.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pending-dep-transitive-effect-result",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;
    let childRuns = 0;
    let parentRuns = 0;
    let effectRuns = 0;

    const childComputation = ((actionTx: IExtendedStorageTransaction) => {
      childRuns++;
      childResult.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    }) as Action & Partial<TelemetryAnnotations>;
    childComputation.writes = [childResult.getAsNormalizedFullLink()];

    const parentComputation = ((actionTx: IExtendedStorageTransaction) => {
      parentRuns++;

      if (!childSubscribed) {
        childSubscribed = true;
        runtime.scheduler.subscribe(
          childComputation,
          (depTx) => {
            source.withTx(depTx).get();
          },
          {},
        );
      }

      parentResult.withTx(actionTx).send(
        (childResult.withTx(actionTx).get() ?? 0) + 1,
      );
    }) as Action & Partial<TelemetryAnnotations>;
    parentComputation.writes = [parentResult.getAsNormalizedFullLink()];

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        parentResult.withTx(actionTx).get() ?? 0,
      );
    };

    runtime.scheduler.subscribe(
      parentComputation,
      (depTx) => {
        childResult.withTx(depTx).get();
      },
      {},
    );

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(parentResult.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(childRuns).toBe(1);
    expect(parentRuns).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(21);
  });

  it("should not re-run an effect when pulled dirty computations do not change its inputs", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-effect-unchanged-source",
      undefined,
      tx,
    );
    source.set(1);
    const derived = runtime.getCell<number>(
      space,
      "pull-effect-unchanged-derived",
      undefined,
      tx,
    );
    derived.set(1);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-effect-unchanged-effect-result",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    let effectRuns = 0;

    const computation = ((actionTx: IExtendedStorageTransaction) => {
      computationRuns++;
      const value = source.withTx(actionTx).get() ?? 0;
      derived.withTx(actionTx).send(value % 2);
    }) as Action & Partial<TelemetryAnnotations>;
    computation.writes = [derived.getAsNormalizedFullLink()];

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        derived.withTx(actionTx).get() ?? 0,
      );
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    expect(computationRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(1);

    source.withTx(tx).send(3);
    await tx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(computationRuns).toBe(2);
    expect(derived.get()).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(1);

    source.withTx(tx).send(4);
    await tx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(computationRuns).toBe(3);
    expect(derived.get()).toBe(0);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(0);
  });

  it("should schedule effects when affected by dirty computations", async () => {
    // This test verifies that scheduleAffectedEffects correctly finds and
    // schedules effects that depend on a dirty computation.

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
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
      },
      {},
    );
    await effectResult.pull();

    // Subscribe effect with isEffect: true
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
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

  it("should run dirty computations with live downstream effect demand", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-demanded-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    const derived = runtime.getCell<number>(
      space,
      "pull-demanded-dirty-derived",
      undefined,
      tx,
    );
    derived.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-demanded-dirty-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    let effectRuns = 0;

    const computation: Action = (actionTx) => {
      computationRuns++;
      derived.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        (derived.withTx(actionTx).get() ?? 0) + 5,
      );
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(computationRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(15);

    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    schedulerInternal.pending.delete(effect);
    schedulerInternal.dirty.delete(effect);
    schedulerInternal.markDirty(computation);
    runtime.scheduler.queueExecution();

    await runtime.scheduler.idle();

    expect(computationRuns).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(25);
  });

  it("should demand dirty computations from dependency-bearing live effects", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-demand-live-effect-source",
      undefined,
      tx,
    );
    source.set(1);
    const derived = runtime.getCell<number>(
      space,
      "pull-demand-live-effect-derived",
      undefined,
      tx,
    );
    derived.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    const computation: Action = (actionTx) => {
      computationRuns++;
      derived.withTx(actionTx).send(source.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
      },
      {},
    );

    const effect: Action = (actionTx) => {
      derived.withTx(actionTx).get();
    };
    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    schedulerInternal.registerEffect(effect);
    const { log } = schedulerInternal.setDependencies(effect, {
      reads: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    });
    schedulerInternal.updateDependents(effect, log);

    expect(schedulerInternal.isDemandedPullComputation(computation)).toBe(
      true,
    );

    await runtime.scheduler.idle();

    expect(computationRuns).toBe(1);
    expect(derived.get()).toBe(1);
  });

  it("should discover writes for new child computations in demanded subgraphs", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-demanded-child-source",
      undefined,
      tx,
    );
    source.set(1);
    const parentResult = runtime.getCell<number>(
      space,
      "pull-demanded-child-parent-result",
      undefined,
      tx,
    );
    parentResult.set(0);
    const childResult = runtime.getCell<number>(
      space,
      "pull-demanded-child-result",
      undefined,
      tx,
    );
    childResult.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-demanded-child-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;
    let parentRuns = 0;
    let childRuns = 0;
    let effectRuns = 0;

    const child: Action = (actionTx) => {
      childRuns++;
      childResult.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    };

    const parent: Action = (actionTx) => {
      parentRuns++;
      parentResult.withTx(actionTx).send(source.withTx(actionTx).get() ?? 0);
      if (!childSubscribed) {
        childSubscribed = true;
        runtime.scheduler.subscribe(
          child,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [],
          },
          {},
        );
      }
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        (parentResult.withTx(actionTx).get() ?? 0) +
          (childResult.withTx(actionTx).get() ?? 0),
      );
    };

    runtime.scheduler.subscribe(
      parent,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(parentResult.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [
          toMemorySpaceAddress(parentResult.getAsNormalizedFullLink()),
          toMemorySpaceAddress(childResult.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(parentRuns).toBe(1);
    expect(childRuns).toBe(1);
    expect(effectRuns).toBeGreaterThanOrEqual(2);
    expect(effectResult.get()).toBe(11);
  });

  it("should continue a parent pull when a child writes a parent read", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-continuation-source",
      undefined,
      tx,
    );
    source.set(3);
    const childResult = runtime.getCell<number>(
      space,
      "pull-continuation-child-result",
      undefined,
      tx,
    );
    childResult.set(0);
    const parentResult = runtime.getCell<number>(
      space,
      "pull-continuation-parent-result",
      undefined,
      tx,
    );
    parentResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;
    let parentRuns = 0;
    let childRuns = 0;

    const child: Action = (actionTx) => {
      childRuns++;
      childResult.withTx(actionTx).send(source.withTx(actionTx).get() ?? 0);
    };

    const parent: Action = (actionTx) => {
      parentRuns++;
      if (!childSubscribed) {
        childSubscribed = true;
        runtime.scheduler.subscribe(child, {
          reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(childResult.getAsNormalizedFullLink())],
        });
      }
      parentResult.withTx(actionTx).send(
        (childResult.withTx(actionTx).get() ?? 0) + 1,
      );
    };

    runtime.scheduler.subscribe(parent, {
      reads: [toMemorySpaceAddress(childResult.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(parentResult.getAsNormalizedFullLink())],
    });

    expect(await parentResult.pull()).toBe(4);
    expect(parentRuns).toBe(2);
    expect(childRuns).toBe(1);
  });

  it("should clear provisional continuation demand when unsubscribing", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-continuation-unsubscribe-source",
      undefined,
      tx,
    );
    source.set(2);
    const result = runtime.getCell<number>(
      space,
      "pull-continuation-unsubscribe-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runs = 0;
    const action: Action = (actionTx) => {
      runs++;
      result.withTx(actionTx).send(source.withTx(actionTx).get() ?? 0);
    };
    const log = {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
    };

    runtime.scheduler.subscribe(action, log);
    await runtime.scheduler.idle();
    expect(runs).toBe(0);

    const schedulerInternals = runtime.scheduler as unknown as {
      markPullDemandContinuation: (action: Action) => void;
    };
    schedulerInternals.markPullDemandContinuation(action);

    runtime.scheduler.unsubscribe(action);
    runtime.scheduler.subscribe(action, log);
    await runtime.scheduler.idle();

    expect(runs).toBe(0);
    expect(result.get()).toBe(0);
  });

  it("should first-run child computations created by demand-root effects", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-demanded-effect-child-source",
      undefined,
      tx,
    );
    source.set(3);
    const childResult = runtime.getCell<number>(
      space,
      "pull-demanded-effect-child-result",
      undefined,
      tx,
    );
    childResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;
    let childRuns = 0;
    let childSubscribed = false;

    const child: Action = (actionTx) => {
      childRuns++;
      childResult.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    };

    const effect: Action = () => {
      effectRuns++;
      if (!childSubscribed) {
        childSubscribed = true;
        runtime.scheduler.subscribe(
          child,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [
              toMemorySpaceAddress(childResult.getAsNormalizedFullLink()),
            ],
          },
          {},
        );
      }
    };

    runtime.scheduler.subscribe(
      effect,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(effectRuns).toBe(1);
    expect(childRuns).toBe(1);
    expect(childResult.get()).toBe(30);
  });

  it("should collect shared dirty dependencies consistently across effect seeds", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-shared-seeds-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate = runtime.getCell<number>(
      space,
      "pull-shared-seeds-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const leftResult = runtime.getCell<number>(
      space,
      "pull-shared-seeds-left-result",
      undefined,
      tx,
    );
    leftResult.set(0);
    const rightResult = runtime.getCell<number>(
      space,
      "pull-shared-seeds-right-result",
      undefined,
      tx,
    );
    rightResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    let leftEffectRuns = 0;
    let rightEffectRuns = 0;

    const computation: Action = (actionTx) => {
      computationRuns++;
      const value = source.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(value * 10);
    };

    const leftEffect: Action = (actionTx) => {
      leftEffectRuns++;
      const value = intermediate.withTx(actionTx).get();
      leftResult.withTx(actionTx).send(value + 1);
    };

    const rightEffect: Action = (actionTx) => {
      rightEffectRuns++;
      const value = intermediate.withTx(actionTx).get();
      rightResult.withTx(actionTx).send(value + 2);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
      },
      {},
    );

    runtime.scheduler.subscribe(
      leftEffect,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(leftResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    runtime.scheduler.subscribe(
      rightEffect,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(rightResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(leftResult.get()).toBe(11);
    expect(rightResult.get()).toBe(12);
    expect(computationRuns).toBe(1);
    expect(leftEffectRuns).toBe(1);
    expect(rightEffectRuns).toBe(1);

    const updateTx = runtime.edit();
    source.withTx(updateTx).send(2);
    await updateTx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(leftResult.get()).toBe(21);
    expect(rightResult.get()).toBe(22);
    expect(computationRuns).toBe(2);
    expect(leftEffectRuns).toBe(2);
    expect(rightEffectRuns).toBe(2);

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);

    const collectWorkSet = (seeds: Action[]) => {
      const workSet = new Set<Action>(seeds);
      const memo = new Map<Action, boolean>();
      for (const seed of seeds) {
        schedulerInternal.collectDirtyDependencies(seed, workSet, memo);
      }
      return { workSet, memo };
    };

    schedulerInternal.markDirty(computation);
    schedulerInternal.scheduleAffectedEffects(computation);

    const forward = collectWorkSet([leftEffect, rightEffect]);
    const reverse = collectWorkSet([rightEffect, leftEffect]);

    expect(forward.workSet.has(computation)).toBe(true);
    expect(reverse.workSet.has(computation)).toBe(true);
    expect(forward.memo.get(computation)).toBe(true);
    expect(reverse.memo.get(computation)).toBe(true);
    expect(forward.memo.get(leftEffect)).toBe(true);
    expect(forward.memo.get(rightEffect)).toBe(true);
    expect(reverse.memo.get(leftEffect)).toBe(true);
    expect(reverse.memo.get(rightEffect)).toBe(true);

    // The trace-enabled memo-hit bookkeeping in dirty-dependencies.ts is
    // otherwise reached only when a pull-event preflight trace happens to be
    // active during a memo hit, which depends on event-batch interleaving and
    // so varies run to run. Re-collect from the already-memoized dirty
    // computation with a fresh work set and a trace attached so the counters
    // are asserted deterministically.
    const trace = createDirtyDependencyTraceContext();
    const schedulerWithTrace = runtime.scheduler as unknown as {
      dirtyDependencyTraceContext?: ReturnType<
        typeof createDirtyDependencyTraceContext
      >;
    };
    schedulerWithTrace.dirtyDependencyTraceContext = trace;
    try {
      const tracedWorkSet = new Set<Action>();
      const result = schedulerInternal.collectDirtyDependencies(
        computation,
        tracedWorkSet,
        forward.memo,
      );
      expect(result).toBe(true);
      expect(tracedWorkSet.has(computation)).toBe(true);
      expect(trace.memoHitCount).toBe(1);
      expect(trace.workSetAddCount).toBe(1);
    } finally {
      schedulerWithTrace.dirtyDependencyTraceContext = undefined;
    }
  });

  it("should recompute multi-hop chains before running effects in pull mode", async () => {
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
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate1.getAsNormalizedFullLink())],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      computation2,
      {
        reads: [toMemorySpaceAddress(intermediate1.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate2.getAsNormalizedFullLink())],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(intermediate2.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
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
          toMemorySpaceAddress(selector.getAsNormalizedFullLink()),
          toMemorySpaceAddress(sourceA.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
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
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
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

  it("should track direct dirty and transitive stale separately", async () => {
    const source = runtime.getCell<number>(
      space,
      "stale-state-source",
      undefined,
      tx,
    );
    source.set(1);
    const mid = runtime.getCell<number>(
      space,
      "stale-state-mid",
      undefined,
      tx,
    );
    mid.set(0);
    const output = runtime.getCell<number>(
      space,
      "stale-state-output",
      undefined,
      tx,
    );
    output.set(0);
    const sink = runtime.getCell<number>(
      space,
      "stale-state-sink",
      undefined,
      tx,
    );
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    const actionA: Action = (actionTx) => {
      mid.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
    };
    const actionB: Action = (actionTx) => {
      output.withTx(actionTx).send((mid.withTx(actionTx).get() ?? 0) + 1);
    };
    const effect: Action = (actionTx) => {
      sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
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
    await sink.pull();

    const updateTx = runtime.edit();
    source.withTx(updateTx).send(2);
    await updateTx.commit();

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    expect(runtime.scheduler.isDirty(actionA)).toBe(true);
    expect(runtime.scheduler.isDirty(actionB)).toBe(false);
    expect(schedulerInternal.isStale(actionA)).toBe(true);
    expect(schedulerInternal.isStale(actionB)).toBe(true);
    expect(schedulerInternal.getUpstreamStaleCount(actionB)).toBe(1);
    expect(schedulerInternal.isStale(effect)).toBe(true);
  });

  it("should schedule a newly resubscribed shallow-read effect when its writer is stale", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-shallow-resubscribe-source",
      undefined,
      tx,
    );
    source.set(1);
    const output = runtime.getCell<{ children: number[] }>(
      space,
      "pull-shallow-resubscribe-output",
      undefined,
      tx,
    );
    output.set({ children: [] });
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    const computation: Action = (actionTx) => {
      computationRuns++;
      output.withTx(actionTx).key("children").set([
        source.withTx(actionTx).get() ?? 0,
      ]);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(
            output.key("children").getAsNormalizedFullLink(),
          ),
        ],
      },
      {},
    );

    expect(runtime.scheduler.isDirty(computation)).toBe(true);
    expect(computationRuns).toBe(0);

    let effectRuns = 0;
    const effect: Action = (effectTx) => {
      effectRuns++;
      output.withTx(effectTx).key("children").getRaw({
        nonRecursive: true,
      });
    };

    runtime.scheduler.resubscribe(
      effect,
      {
        reads: [],
        shallowReads: [
          toMemorySpaceAddress(
            output.key("children").getAsNormalizedFullLink(),
          ),
        ],
        writes: [],
      },
      { isEffect: true },
    );

    expect(runtime.scheduler.isDirty(effect)).toBe(true);
    await runtime.scheduler.idle();

    expect(computationRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);
    expect(runtime.scheduler.isDirty(effect)).toBe(false);
  });

  it("should clear downstream stale state when upstream recomputes unchanged", async () => {
    const source = runtime.getCell<number>(
      space,
      "stale-noop-source",
      undefined,
      tx,
    );
    source.set(1);
    const stable = runtime.getCell<number>(
      space,
      "stale-noop-stable",
      undefined,
      tx,
    );
    stable.set(0);
    const output = runtime.getCell<number>(
      space,
      "stale-noop-output",
      undefined,
      tx,
    );
    output.set(0);
    const sink = runtime.getCell<number>(
      space,
      "stale-noop-sink",
      undefined,
      tx,
    );
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    let stableRuns = 0;
    let downstreamRuns = 0;
    let effectRuns = 0;
    const stableAction: Action = (actionTx) => {
      stableRuns++;
      source.withTx(actionTx).get();
      stable.withTx(actionTx).send(1);
    };
    const downstreamAction: Action = (actionTx) => {
      downstreamRuns++;
      output.withTx(actionTx).send((stable.withTx(actionTx).get() ?? 0) + 1);
    };
    const effect: Action = (actionTx) => {
      effectRuns++;
      sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      stableAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(stable.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      downstreamAction,
      {
        reads: [toMemorySpaceAddress(stable.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
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
    await sink.pull();
    expect(sink.get()).toBe(2);

    stableRuns = 0;
    downstreamRuns = 0;
    effectRuns = 0;

    const updateTx = runtime.edit();
    source.withTx(updateTx).send(2);
    await updateTx.commit();
    await runtime.scheduler.idle();

    expect(stableRuns).toBe(1);
    expect(downstreamRuns).toBe(0);
    expect(effectRuns).toBe(0);
    expect(sink.get()).toBe(2);

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    expect(schedulerInternal.isStale(stableAction)).toBe(false);
    expect(schedulerInternal.isStale(downstreamAction)).toBe(false);
    expect(schedulerInternal.isStale(effect)).toBe(false);
  });

  it("should run downstream demand when upstream recompute changes output", async () => {
    const source = runtime.getCell<number>(
      space,
      "stale-change-source",
      undefined,
      tx,
    );
    source.set(1);
    const mid = runtime.getCell<number>(
      space,
      "stale-change-mid",
      undefined,
      tx,
    );
    mid.set(0);
    const output = runtime.getCell<number>(
      space,
      "stale-change-output",
      undefined,
      tx,
    );
    output.set(0);
    const sink = runtime.getCell<number>(
      space,
      "stale-change-sink",
      undefined,
      tx,
    );
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    let downstreamRuns = 0;
    const upstreamAction: Action = (actionTx) => {
      mid.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) * 10);
    };
    const downstreamAction: Action = (actionTx) => {
      downstreamRuns++;
      output.withTx(actionTx).send((mid.withTx(actionTx).get() ?? 0) + 1);
    };
    const effect: Action = (actionTx) => {
      sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      upstreamAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      downstreamAction,
      {
        reads: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
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
    await sink.pull();
    expect(sink.get()).toBe(11);

    downstreamRuns = 0;
    const updateTx = runtime.edit();
    source.withTx(updateTx).send(2);
    await updateTx.commit();
    await sink.pull();

    expect(downstreamRuns).toBe(1);
    expect(sink.get()).toBe(21);
    expect(runtime.scheduler.isDirty(downstreamAction)).toBe(false);
  });

  it("should keep event handlers behind stale dependencies", async () => {
    const source = runtime.getCell<number>(
      space,
      "stale-event-source",
      undefined,
      tx,
    );
    source.set(1);
    const mid = runtime.getCell<number>(
      space,
      "stale-event-mid",
      undefined,
      tx,
    );
    mid.set(0);
    const output = runtime.getCell<number>(
      space,
      "stale-event-output",
      undefined,
      tx,
    );
    output.set(0);
    const eventStream = runtime.getCell<number>(
      space,
      "stale-event-stream",
      undefined,
      tx,
    );
    eventStream.set(0);
    const result = runtime.getCell<number>(
      space,
      "stale-event-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let upstreamRuns = 0;
    let downstreamRuns = 0;
    let handlerRuns = 0;
    const upstreamAction: Action = (actionTx) => {
      upstreamRuns++;
      mid.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
    };
    const downstreamAction: Action = (actionTx) => {
      downstreamRuns++;
      output.withTx(actionTx).send((mid.withTx(actionTx).get() ?? 0) * 2);
    };

    runtime.scheduler.subscribe(
      upstreamAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      downstreamAction,
      {
        reads: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );
    await output.pull();

    const handler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      result.withTx(handlerTx).send(
        (output.withTx(handlerTx).get() ?? 0) + event,
      );
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventStream.getAsNormalizedFullLink(),
      (depTx) => output.withTx(depTx).get(),
    );

    upstreamRuns = 0;
    downstreamRuns = 0;
    const updateTx = runtime.edit();
    source.withTx(updateTx).send(4);
    await updateTx.commit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 5);
    await result.pull();

    expect(upstreamRuns).toBe(1);
    expect(downstreamRuns).toBe(1);
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(((4 + 1) * 2) + 5);
  });

  it("should not recursively walk clean broad event preflight dependencies", async () => {
    runtime.scheduler.setEventPreflightTelemetryEnabled(true);

    const preflights: EventPreflightMarker[] = [];
    const listener = (event: Event) => {
      const marker = (event as CustomEvent<{ marker: RuntimeTelemetryMarker }>)
        .detail.marker;
      if (marker.type === "scheduler.event.preflight") {
        preflights.push(marker);
      }
    };
    runtime.telemetry.addEventListener("telemetry", listener);

    try {
      const source = runtime.getCell<number>(
        space,
        "stale-clean-preflight-source",
        undefined,
        tx,
      );
      source.set(1);
      const shared = runtime.getCell<number>(
        space,
        "stale-clean-preflight-shared",
        undefined,
        tx,
      );
      shared.set(0);
      const target = runtime.getCell<number>(
        space,
        "stale-clean-preflight-target",
        undefined,
        tx,
      );
      target.set(0);
      const eventStream = runtime.getCell<number>(
        space,
        "stale-clean-preflight-event",
        undefined,
        tx,
      );
      eventStream.set(0);
      const result = runtime.getCell<number>(
        space,
        "stale-clean-preflight-result",
        undefined,
        tx,
      );
      result.set(0);
      const fanCells: Cell<number>[] = [];
      for (let i = 0; i < 32; i++) {
        const cell = runtime.getCell<number>(
          space,
          `stale-clean-preflight-fan-${i}`,
          undefined,
          tx,
        );
        cell.set(0);
        fanCells.push(cell);
      }
      await tx.commit();
      tx = runtime.edit();

      const sharedWriter: Action = (actionTx) => {
        shared.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
      };
      runtime.scheduler.subscribe(
        sharedWriter,
        {
          reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(shared.getAsNormalizedFullLink())],
        },
        {},
      );

      for (const [index, fanCell] of fanCells.entries()) {
        const fanWriter: Action = (actionTx) => {
          fanCell.withTx(actionTx).send(
            (shared.withTx(actionTx).get() ?? 0) + index,
          );
        };
        runtime.scheduler.subscribe(
          fanWriter,
          {
            reads: [toMemorySpaceAddress(shared.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(fanCell.getAsNormalizedFullLink())],
          },
          {},
        );
      }

      const targetWriter: Action = (actionTx) => {
        let sum = 0;
        for (const fanCell of fanCells) {
          sum += fanCell.withTx(actionTx).get() ?? 0;
        }
        target.withTx(actionTx).send(sum);
      };
      runtime.scheduler.subscribe(
        targetWriter,
        {
          reads: fanCells.map((cell) =>
            toMemorySpaceAddress(cell.getAsNormalizedFullLink())
          ),
          shallowReads: [],
          writes: [toMemorySpaceAddress(target.getAsNormalizedFullLink())],
        },
        {},
      );
      await target.pull();

      const handler: EventHandler = (handlerTx, event: number) => {
        result.withTx(handlerTx).send(
          (target.withTx(handlerTx).get() ?? 0) + event,
        );
      };
      runtime.scheduler.addEventHandler(
        handler,
        eventStream.getAsNormalizedFullLink(),
        (depTx) => target.withTx(depTx).get(),
      );

      runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
      await result.pull();

      expect(preflights.length).toBe(1);
      expect(preflights[0].skipped).toBe(false);
      expect(preflights[0].hasDirtyDependencies).toBe(false);
      expect(preflights[0].stats.visitCount).toBeLessThan(10);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
  });

  it("should update stale counts when dynamic dependencies change", async () => {
    const selector = runtime.getCell<number>(
      space,
      "stale-dynamic-selector",
      undefined,
      tx,
    );
    selector.set(0);
    const sourceA = runtime.getCell<number>(
      space,
      "stale-dynamic-source-a",
      undefined,
      tx,
    );
    sourceA.set(1);
    const sourceB = runtime.getCell<number>(
      space,
      "stale-dynamic-source-b",
      undefined,
      tx,
    );
    sourceB.set(10);
    const output = runtime.getCell<number>(
      space,
      "stale-dynamic-output",
      undefined,
      tx,
    );
    output.set(0);
    const sink = runtime.getCell<number>(
      space,
      "stale-dynamic-sink",
      undefined,
      tx,
    );
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const useB = (selector.withTx(actionTx).get() ?? 0) === 1;
      const sourceCell = useB ? sourceB : sourceA;
      output.withTx(actionTx).send(sourceCell.withTx(actionTx).get() ?? 0);
    };
    const effect: Action = (actionTx) => {
      sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      action,
      {
        reads: [
          toMemorySpaceAddress(selector.getAsNormalizedFullLink()),
          toMemorySpaceAddress(sourceA.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
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
    await sink.pull();

    const switchTx = runtime.edit();
    selector.withTx(switchTx).send(1);
    await switchTx.commit();
    await sink.pull();
    expect(sink.get()).toBe(10);

    const updateOldSourceTx = runtime.edit();
    sourceA.withTx(updateOldSourceTx).send(2);
    await updateOldSourceTx.commit();

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    expect(runtime.scheduler.isDirty(action)).toBe(false);
    expect(schedulerInternal.isStale(action)).toBe(false);
    expect(schedulerInternal.getUpstreamStaleCount(action)).toBe(0);

    const updateNewSourceTx = runtime.edit();
    sourceB.withTx(updateNewSourceTx).send(11);
    await updateNewSourceTx.commit();
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    expect(schedulerInternal.isStale(action)).toBe(true);
  });

  it("should clear stale counts when stale dependencies unsubscribe", async () => {
    const source = runtime.getCell<number>(
      space,
      "stale-unsubscribe-source",
      undefined,
      tx,
    );
    source.set(1);
    const mid = runtime.getCell<number>(
      space,
      "stale-unsubscribe-mid",
      undefined,
      tx,
    );
    mid.set(0);
    const output = runtime.getCell<number>(
      space,
      "stale-unsubscribe-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    const upstreamAction: Action = (actionTx) => {
      mid.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
    };
    const downstreamAction: Action = (actionTx) => {
      output.withTx(actionTx).send((mid.withTx(actionTx).get() ?? 0) + 1);
    };

    runtime.scheduler.subscribe(
      upstreamAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      downstreamAction,
      {
        reads: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );
    await output.pull();

    const updateTx = runtime.edit();
    source.withTx(updateTx).send(2);
    await updateTx.commit();

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    expect(schedulerInternal.isStale(downstreamAction)).toBe(true);

    runtime.scheduler.unsubscribe(upstreamAction);
    expect(schedulerInternal.isStale(downstreamAction)).toBe(false);
    expect(schedulerInternal.getUpstreamStaleCount(downstreamAction)).toBe(0);
  });

  it("should handle stale cycles conservatively without negative counts", async () => {
    const source = runtime.getCell<number>(
      space,
      "stale-cycle-source",
      undefined,
      tx,
    );
    source.set(1);
    const left = runtime.getCell<number>(
      space,
      "stale-cycle-left",
      undefined,
      tx,
    );
    left.set(0);
    const right = runtime.getCell<number>(
      space,
      "stale-cycle-right",
      undefined,
      tx,
    );
    right.set(0);
    await tx.commit();
    tx = runtime.edit();

    const actionA: Action = () => {};
    const actionB: Action = () => {};

    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [
          toMemorySpaceAddress(source.getAsNormalizedFullLink()),
          toMemorySpaceAddress(right.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(left.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [toMemorySpaceAddress(left.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(right.getAsNormalizedFullLink())],
      },
      {},
    );

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    const workSet = new Set<Action>();
    expect(
      schedulerInternal.collectDirtyDependencies(
        actionA,
        workSet,
        new Map(),
      ),
    ).toBe(true);
    expect(workSet.has(actionA)).toBe(true);
    expect(workSet.has(actionB)).toBe(true);

    schedulerInternal.clearDirectDirty(actionA);
    schedulerInternal.clearDirectDirty(actionB);

    expect(schedulerInternal.getUpstreamStaleCount(actionA))
      .toBeGreaterThanOrEqual(
        0,
      );
    expect(schedulerInternal.getUpstreamStaleCount(actionB))
      .toBeGreaterThanOrEqual(
        0,
      );
  });
});
