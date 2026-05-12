// Pull-based scheduling tests: pull mode, references, handler dependency
// pulling, array reactivity, and inline idempotency checks.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Action,
  type ErrorWithContext,
  type EventHandler,
  type TelemetryAnnotations,
} from "../src/scheduler.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";
import { type Cell, type JSONSchema } from "../src/builder/types.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { toMemorySpaceAddress } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type StaleSchedulerInternals = {
  isStale: (action: Action) => boolean;
  isDemandedPullComputation: (action: Action) => boolean;
  getUpstreamStaleCount: (action: Action) => number;
  clearDirectDirty: (action: Action) => boolean;
  isEffectAction: WeakMap<Action, boolean>;
  setDependencies: (
    action: Action,
    log: {
      reads: ReturnType<typeof toMemorySpaceAddress>[];
      shallowReads: ReturnType<typeof toMemorySpaceAddress>[];
      writes: ReturnType<typeof toMemorySpaceAddress>[];
    },
  ) => {
    log: {
      reads: ReturnType<typeof toMemorySpaceAddress>[];
      shallowReads: ReturnType<typeof toMemorySpaceAddress>[];
      writes: ReturnType<typeof toMemorySpaceAddress>[];
    };
  };
  updateDependents: (
    action: Action,
    log: {
      reads: ReturnType<typeof toMemorySpaceAddress>[];
      shallowReads: ReturnType<typeof toMemorySpaceAddress>[];
      writes: ReturnType<typeof toMemorySpaceAddress>[];
    },
  ) => void;
  collectDirtyDependencies: (
    action: Action,
    workSet: Set<Action>,
    memo?: Map<Action, boolean>,
  ) => boolean;
};

type EventPreflightMarker = Extract<
  RuntimeTelemetryMarker,
  { type: "scheduler.event.preflight" }
>;

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

  it("should default to push mode", () => {
    expect(runtime.scheduler.isPullModeEnabled()).toBe(false);
  });

  it("should dispatch schema-marked streams without a materialized stream marker", async () => {
    runtime.scheduler.enablePullMode();

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
      { reads: [], shallowReads: [], writes: [] },
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
    runtime.scheduler.enablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);

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
    expect(unrelatedRuns).toBe(0);
  });

  it("should re-run an effect for transitively related pending dependency collection", async () => {
    runtime.scheduler.enablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);

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
    runtime.scheduler.enablePullMode();
    expect(runtime.scheduler.isPullModeEnabled()).toBe(true);

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
    runtime.scheduler.enablePullMode();

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

    const schedulerInternal = runtime.scheduler as unknown as {
      pending: Set<Action>;
      dirty: Set<Action>;
      markDirty: (action: Action) => void;
    };
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
    runtime.scheduler.enablePullMode();

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
    const schedulerInternal = runtime
      .scheduler as unknown as StaleSchedulerInternals;
    schedulerInternal.isEffectAction.set(effect, true);
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
    runtime.scheduler.enablePullMode();

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

  it("should first-run child computations created by demand-root effects", async () => {
    runtime.scheduler.enablePullMode();

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
    runtime.scheduler.enablePullMode();

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

    const schedulerInternal = runtime.scheduler as unknown as {
      collectDirtyDependencies: (
        action: Action,
        workSet: Set<Action>,
        memo?: Map<Action, boolean>,
      ) => boolean;
      markDirty: (action: Action) => void;
      scheduleAffectedEffects: (action: Action) => void;
    };

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
    runtime.scheduler.enablePullMode();

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

    const schedulerInternal = runtime
      .scheduler as unknown as StaleSchedulerInternals;
    expect(runtime.scheduler.isDirty(actionA)).toBe(true);
    expect(runtime.scheduler.isDirty(actionB)).toBe(false);
    expect(schedulerInternal.isStale(actionA)).toBe(true);
    expect(schedulerInternal.isStale(actionB)).toBe(true);
    expect(schedulerInternal.getUpstreamStaleCount(actionB)).toBe(1);
    expect(schedulerInternal.isStale(effect)).toBe(true);
  });

  it("should schedule a newly resubscribed shallow-read effect when its writer is stale", async () => {
    runtime.scheduler.enablePullMode();

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
    runtime.scheduler.enablePullMode();

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

    const schedulerInternal = runtime
      .scheduler as unknown as StaleSchedulerInternals;
    expect(schedulerInternal.isStale(stableAction)).toBe(false);
    expect(schedulerInternal.isStale(downstreamAction)).toBe(false);
    expect(schedulerInternal.isStale(effect)).toBe(false);
  });

  it("should run downstream demand when upstream recompute changes output", async () => {
    runtime.scheduler.enablePullMode();

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
    runtime.scheduler.enablePullMode();

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
    runtime.scheduler.enablePullMode();
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
    runtime.scheduler.enablePullMode();

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

    const schedulerInternal = runtime
      .scheduler as unknown as StaleSchedulerInternals;
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
    runtime.scheduler.enablePullMode();

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

    const schedulerInternal = runtime
      .scheduler as unknown as StaleSchedulerInternals;
    expect(schedulerInternal.isStale(downstreamAction)).toBe(true);

    runtime.scheduler.unsubscribe(upstreamAction);
    expect(schedulerInternal.isStale(downstreamAction)).toBe(false);
    expect(schedulerInternal.getUpstreamStaleCount(downstreamAction)).toBe(0);
  });

  it("should handle stale cycles conservatively without negative counts", async () => {
    runtime.scheduler.enablePullMode();

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

    const schedulerInternal = runtime
      .scheduler as unknown as StaleSchedulerInternals;
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
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(innerOutput.getAsNormalizedFullLink())],
      },
      {},
    );
    await innerOutput.pull();

    runtime.scheduler.subscribe(
      outerLift,
      {
        reads: [toMemorySpaceAddress(innerOutput.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outerOutput.getAsNormalizedFullLink())],
      },
      {},
    );
    await outerOutput.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(outerOutput.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
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

  it("should re-run a schema sink when a followed link target appears later", async () => {
    const source = runtime.getCell(space, "missing-link-source", undefined, tx);
    const target = runtime.getCell<{ name: string }>(
      space,
      "missing-link-target",
      undefined,
      tx,
    );

    source.set({
      profile: target,
    });

    await tx.commit();
    tx = runtime.edit();

    const profileName = source.key("profile").key("name").asSchema(
      {
        type: "string",
      } as const satisfies JSONSchema,
    );

    const seen: Array<string | undefined> = [];
    const cancel = profileName.sink((value) => {
      seen.push(value);
    });

    await runtime.idle();
    expect(seen).toEqual([undefined]);

    target.withTx(tx).set({ name: "Ada" });

    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(seen).toEqual([undefined, "Ada"]);
    cancel();
  });

  it("should re-run a schema sink when a followed link target changes", async () => {
    const source = runtime.getCell(space, "linked-sink-source", undefined, tx);
    const target = runtime.getCell<{ name: string }>(
      space,
      "linked-sink-target",
      undefined,
      tx,
    );

    source.set({
      profile: target,
    });
    target.set({ name: "Ada" });

    await tx.commit();
    tx = runtime.edit();

    const profileName = source.key("profile").key("name").asSchema(
      {
        type: "string",
      } as const satisfies JSONSchema,
    );

    const seen: Array<string | undefined> = [];
    const cancel = profileName.sink((value) => {
      seen.push(value);
    });

    await runtime.idle();
    expect(seen).toEqual(["Ada"]);

    target.withTx(tx).set({ name: "Grace" });

    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(seen).toEqual(["Ada", "Grace"]);
    cancel();
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
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(computedOutput.getAsNormalizedFullLink()),
        ],
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

  it("does not prepare dependency-discovery reads in enforcing mode", async () => {
    await runtime.dispose();
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    runtime.scheduler.enablePullMode();
    tx = runtime.edit();

    const labeledSource = runtime.getCell<number>(
      space,
      "handler-pull-labeled-source",
      {
        type: "number",
        ifc: { confidentiality: ["secret"] },
      } as JSONSchema,
      tx,
    );
    labeledSource.set(7);

    const eventStream = runtime.getCell<number>(
      space,
      "handler-pull-labeled-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    await tx.commit();
    tx = runtime.edit();
    await labeledSource.pull();

    let handlerRuns = 0;
    const handler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      labeledSource.withTx(handlerTx).get();
      void event;
    };

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      labeledSource.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      handler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 5);
    await runtime.idle();
    await runtime.storageManager.synced();

    expect(handlerRuns).toBe(1);
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
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(data.key("foo").getAsNormalizedFullLink()),
        ],
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
        reads: [toMemorySpaceAddress(source1.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed1.getAsNormalizedFullLink())],
      },
      {},
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [toMemorySpaceAddress(source2.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed2.getAsNormalizedFullLink())],
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
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed1.getAsNormalizedFullLink())],
      },
      {},
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [toMemorySpaceAddress(computed1.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed2.getAsNormalizedFullLink())],
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

  it("should park a head event until a throttled dependency becomes runnable", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "handler-throttle-source",
      undefined,
      tx,
    );
    source.set(1);

    const computed = runtime.getCell<number>(
      space,
      "handler-throttle-computed",
      undefined,
      tx,
    );
    const eventStream = runtime.getCell<number>(
      space,
      "handler-throttle-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-throttle-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;

    const computation: Action = (actionTx) => {
      computedRuns++;
      const value = source.withTx(actionTx).get();
      computed.withTx(actionTx).send(value * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed.getAsNormalizedFullLink())],
      },
      {},
    );

    await computed.pull();
    expect(computedRuns).toBe(1);
    expect(computed.get()).toBe(10);

    runtime.scheduler.setThrottle(computation, 100);

    runtime.scheduler.addEventHandler(
      (handlerTx, event: number) => {
        handlerRuns++;
        const value = computed.withTx(handlerTx).get();
        result.withTx(handlerTx).send(value + event);
      },
      eventStream.getAsNormalizedFullLink(),
      (depTx) => {
        computed.withTx(depTx).get();
      },
    );

    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.resetFilterStats();
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(computedRuns).toBe(1);
    expect(handlerRuns).toBe(0);
    expect(runtime.scheduler.getFilterStats().filtered).toBeLessThan(5);

    await new Promise((resolve) => setTimeout(resolve, 70));
    await runtime.scheduler.idle();

    expect(computedRuns).toBe(2);
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(23);
  });

  it("should keep parked event wake when unrelated work queues execution", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "handler-throttle-wake-source",
      undefined,
      tx,
    );
    source.set(1);
    const computed = runtime.getCell<number>(
      space,
      "handler-throttle-wake-computed",
      undefined,
      tx,
    );
    const unrelated = runtime.getCell<number>(
      space,
      "handler-throttle-wake-unrelated",
      undefined,
      tx,
    );
    unrelated.set(0);
    const eventStream = runtime.getCell<number>(
      space,
      "handler-throttle-wake-events",
      undefined,
      tx,
    );
    eventStream.set(0);
    const result = runtime.getCell<number>(
      space,
      "handler-throttle-wake-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;
    let unrelatedRuns = 0;

    const computation: Action = (actionTx) => {
      computedRuns++;
      computed.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    };
    const unrelatedEffect: Action = (actionTx) => {
      unrelatedRuns++;
      unrelated.withTx(actionTx).send(unrelatedRuns);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      unrelatedEffect,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(unrelated.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await computed.pull();
    await unrelated.pull();
    expect(computedRuns).toBe(1);

    runtime.scheduler.setThrottle(computation, 100);
    runtime.scheduler.addEventHandler(
      (handlerTx, event: number) => {
        handlerRuns++;
        result.withTx(handlerTx).send(
          (computed.withTx(handlerTx).get() ?? 0) + event,
        );
      },
      eventStream.getAsNormalizedFullLink(),
      (depTx) => {
        computed.withTx(depTx).get();
      },
    );

    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    runtime.scheduler.queueExecution();

    await new Promise((resolve) => setTimeout(resolve, 120));
    await runtime.scheduler.idle();

    expect(computedRuns).toBe(2);
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(23);
  });

  it("should report preflight dependency errors without wedging the scheduler", async () => {
    runtime.scheduler.enablePullMode();

    const eventStream = runtime.getCell<number>(
      space,
      "handler-preflight-error-events",
      undefined,
      tx,
    );
    eventStream.set(0);
    const result = runtime.getCell<number>(
      space,
      "handler-preflight-error-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    const errors: string[] = [];
    runtime.scheduler.onError((error: ErrorWithContext) => {
      errors.push(error.message);
    });

    let handlerRuns = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, event: number) => {
        handlerRuns++;
        result.withTx(handlerTx).send(event);
      },
      eventStream.getAsNormalizedFullLink(),
      () => {
        throw new Error("preflight dependency failed");
      },
    );

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 7);
    await runtime.scheduler.idle();

    expect(handlerRuns).toBe(0);
    expect(result.get()).toBe(0);
    expect(
      errors.some((message) => message.includes("preflight dependency failed")),
    ).toBe(true);

    const followup: Action = (actionTx) => {
      result.withTx(actionTx).send(9);
    };
    runtime.scheduler.subscribe(
      followup,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await result.pull();
    expect(result.get()).toBe(9);
  });

  it("should not emit event preflight telemetry unless enabled", async () => {
    runtime.scheduler.enablePullMode();

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
      const eventStream = runtime.getCell<number>(
        space,
        "handler-preflight-telemetry-events",
        undefined,
        tx,
      );
      eventStream.set(0);
      const result = runtime.getCell<number>(
        space,
        "handler-preflight-telemetry-result",
        undefined,
        tx,
      );
      result.set(0);
      await tx.commit();
      tx = runtime.edit();

      runtime.scheduler.addEventHandler(
        (handlerTx, event: number) => {
          result.withTx(handlerTx).send(event);
        },
        eventStream.getAsNormalizedFullLink(),
        (depTx) => {
          result.withTx(depTx).get();
        },
      );

      runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
      await result.pull();
      expect(preflights).toEqual([]);

      runtime.scheduler.setEventPreflightTelemetryEnabled(true);
      runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 2);
      await result.pull();
      expect(preflights.length).toBe(1);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
  });

  it("should preserve FIFO order while the head event is parked", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      "handler-throttle-fifo-source",
      undefined,
      tx,
    );
    source.set(1);

    const computed = runtime.getCell<number>(
      space,
      "handler-throttle-fifo-computed",
      undefined,
      tx,
    );
    const eventStream = runtime.getCell<number>(
      space,
      "handler-throttle-fifo-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    await tx.commit();
    tx = runtime.edit();

    let computedRuns = 0;
    const handledEvents: number[] = [];

    const computation: Action = (actionTx) => {
      computedRuns++;
      computed.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed.getAsNormalizedFullLink())],
      },
      {},
    );

    await computed.pull();
    expect(computedRuns).toBe(1);

    runtime.scheduler.setThrottle(computation, 80);

    runtime.scheduler.addEventHandler(
      (handlerTx, event: number) => {
        computed.withTx(handlerTx).get();
        handledEvents.push(event);
      },
      eventStream.getAsNormalizedFullLink(),
      (depTx) => {
        computed.withTx(depTx).get();
      },
    );

    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 2);

    await new Promise((resolve) => setTimeout(resolve, 90));
    await runtime.scheduler.idle();

    expect(computedRuns).toBe(2);
    expect(handledEvents).toEqual([1, 2]);
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
      reads: [toMemorySpaceAddress(liftInput.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(liftOutput.getAsNormalizedFullLink())],
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

  it("should record schema array sinks as shallow structural reads", async () => {
    runtime.scheduler.enablePullMode();

    const arrayCell = runtime.getCell<string[]>(
      space,
      "schema-array-structural-sink",
      { type: "array", items: { type: "string" } },
      tx,
    );
    arrayCell.set(["a", "b"]);
    await tx.commit();
    tx = runtime.edit();

    const cancel = arrayCell.withTx(tx).sink(() => {});
    await runtime.scheduler.idle();

    const link = arrayCell.getAsNormalizedFullLink();
    const expectedAddress = toMemorySpaceAddress(link);
    const expectedRead = `${expectedAddress.space}/${expectedAddress.id}/${
      expectedAddress.path.join("/")
    }`;
    const graph = runtime.scheduler.getGraphSnapshot();
    const sinkNode = graph.nodes.find((node) =>
      node.type === "effect" &&
      node.id.startsWith(`sink:${link.space}/${link.id}/`)
    );

    expect(sinkNode?.shallowReads ?? []).toContain(expectedRead);

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
        reads: [toMemorySpaceAddress(sourceArray.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(filteredCell.getAsNormalizedFullLink())],
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
        reads: [toMemorySpaceAddress(sourceArray.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computedCell.getAsNormalizedFullLink())],
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
        reads: [toMemorySpaceAddress(allPiecesCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
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
        reads: [toMemorySpaceAddress(allPiecesCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(countCell.getAsNormalizedFullLink())],
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
        reads: [toMemorySpaceAddress(allPiecesCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
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
        reads: [toMemorySpaceAddress(allPiecesCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
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
        reads: [toMemorySpaceAddress(allPiecesCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
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
        reads: [toMemorySpaceAddress(allPiecesCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
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
        reads: [toMemorySpaceAddress(allPiecesCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(visiblePiecesCell.getAsNormalizedFullLink()),
        ],
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
        { reads: [], shallowReads: [], writes: [] },
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
      runtime.scheduler.subscribe(doubler, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {});
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
        { reads: [], shallowReads: [], writes: [] },
        {},
      );
      await runtime.scheduler.idle();

      const result = await runtime.scheduler.runIdempotencyCheck();
      expect(result.nonIdempotent.length).toBeGreaterThan(0);
    });
  });
});

describe("inline idempotency check mode", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Inline idempotency mode should work regardless of the scheduler default.
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("detects non-idempotent via inline mode", async () => {
    runtime.scheduler.enableIdempotencyCheck();

    const output = runtime.getCell<number>(
      space,
      "inline-random-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    const randomWriter: Action = (tx) => {
      output.withTx(tx).send(Math.random());
    };
    (
      randomWriter as Action & {
        writes: ReturnType<typeof output.getAsNormalizedFullLink>[];
      }
    ).writes = [output.getAsNormalizedFullLink()];
    runtime.scheduler.subscribe(
      randomWriter,
      () => {},
      {},
    );
    await output.pull();

    expect(runtime.scheduler.getIdempotencyViolations().length).toBeGreaterThan(
      0,
    );
  });

  it("does not flag idempotent computations in inline mode", async () => {
    runtime.scheduler.enableIdempotencyCheck();

    const input = runtime.getCell<number>(
      space,
      "inline-idempotent-input",
      undefined,
      tx,
    );
    input.set(5);
    const output = runtime.getCell<number>(
      space,
      "inline-idempotent-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    const doubler: Action = (tx) => {
      output.withTx(tx).send(input.withTx(tx).get() * 2);
    };
    (
      doubler as Action & {
        writes: ReturnType<typeof output.getAsNormalizedFullLink>[];
      }
    ).writes = [output.getAsNormalizedFullLink()];
    runtime.scheduler.subscribe(
      doubler,
      (tx) => {
        input.withTx(tx).get();
      },
      {},
    );
    expect(await output.pull()).toBe(10);

    const violations = runtime.scheduler.getIdempotencyViolations()
      .filter((r) =>
        r.runs.some((run) =>
          Object.keys(run.writes).some((k) => k.includes("inline-idempotent"))
        )
      );
    expect(violations.length).toBe(0);
  });
});
