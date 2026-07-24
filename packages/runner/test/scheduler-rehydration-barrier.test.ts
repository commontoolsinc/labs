import { assertEquals } from "@std/assert";
import { collectPullIterationSeeds } from "../src/scheduler/settle.ts";
import {
  assessPullWork,
  hasRunnablePullWork,
  type PullSchedulingState,
} from "../src/scheduler/work-oracle.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import type { Action } from "../src/scheduler/types.ts";
import { CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES } from "../src/scheduler/constants.ts";

// Guards the reload "rehydration barrier" (scheduler-v2 3c): while an initial
// rehydration (resume from persisted state) is in flight, NO pull work runs, so
// a sync-fill of a resuming never-ran action can't promote it into the
// status-based runnable-seed set, run it fresh, and abort the resume. Without
// the barrier this made notebook reload nondeterministic and could hang on slow
// CI runners. See work-oracle.ts:hasPendingInitialRehydrations.

function makeState(opts: {
  rehydrationsPending: boolean;
  nodes: NodeRegistry;
  materializers?: ReadonlySet<Action>;
  pending?: Set<Action>;
}): PullSchedulingState {
  const demandedState = {
    effects: opts.nodes.effects,
    isDemandedPullComputation: () => true,
    shouldRunFirstPullComputationInDemandContext: () => false,
    isThrottled: () => false,
    isDebouncedComputationWaiting: () => false,
  };
  return {
    nodes: opts.nodes,
    pending: opts.pending ?? new Set<Action>(),
    effects: opts.nodes.effects,
    materializerIndex: {
      isMaterializer: (action: Action) =>
        opts.materializers?.has(action) ?? false,
    } as never,
    pendingPullRunnableState: demandedState,
    dirtyPullRunnableState: demandedState,
    dirtyPullRunnableStateWithDebounce: demandedState,
    isLiveAction: () => true,
    hasActiveDebounceTimer: () => false,
    getNextEligibleRunTime: () => undefined,
    isClaimedRemoteSpeculationDeferred: () => false,
    hasPendingInitialRehydrations: () => opts.rehydrationsPending,
    isConvergenceHoldActive: () => true,
    isConvergenceBackoffDeferred: () => false,
  };
}

Deno.test("rehydration barrier holds all pull seeds while a resume is in flight", () => {
  const nodes = new NodeRegistry();
  const action: Action = () => {};
  // A freshly registered live effect is born `never-ran` — a runnable seed.
  nodes.register(action, "effect");

  // Barrier engaged: the never-ran live effect is NOT collected as a seed and
  // there is no runnable pull work, even though it would otherwise run.
  const barriered = makeState({ rehydrationsPending: true, nodes });
  const blocked = new Set<Action>();
  collectPullIterationSeeds(barriered, blocked);
  assertEquals(blocked.size, 0);
  assertEquals(hasRunnablePullWork(barriered), false);

  // Barrier lifted (resume resolved): the same node is now a runnable seed.
  const open = makeState({ rehydrationsPending: false, nodes });
  const seeds = new Set<Action>();
  collectPullIterationSeeds(open, seeds);
  assertEquals(seeds.has(action), true);
});

Deno.test("materializers run at idle priority unless promoted by primary work", () => {
  const nodes = new NodeRegistry();
  const effect: Action = () => {};
  const materializer: Action = () => {};
  nodes.register(effect, "effect");
  nodes.register(materializer, "computation");
  const state = makeState({
    rehydrationsPending: false,
    nodes,
    materializers: new Set([materializer]),
  });

  const primary = new Set<Action>();
  collectPullIterationSeeds(state, primary);
  assertEquals([...primary], [effect]);

  nodes.setStatus(effect, "clean");
  const idlePriority = new Set<Action>();
  collectPullIterationSeeds(state, idlePriority);
  assertEquals([...idlePriority], [materializer]);
});

Deno.test("an exhausted subgraph cannot release idle for unrelated convergence", () => {
  const nodes = new NodeRegistry();
  const exhausted: Action = () => {};
  const healthy: Action = () => {};
  const exhaustedRecord = nodes.register(exhausted, "computation");
  const healthyRecord = nodes.register(healthy, "computation");
  nodes.setStatus(exhausted, "invalid");
  nodes.setStatus(healthy, "invalid");
  const wakeAt = performance.now() + 30_000;
  exhaustedRecord.gate.backoffUntil = wakeAt;
  exhaustedRecord.gate.backoffStreak = CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES;
  exhaustedRecord.gate.convergenceHoldPasses =
    CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES;
  healthyRecord.gate.backoffUntil = wakeAt;
  healthyRecord.gate.backoffStreak = 1;
  healthyRecord.gate.convergenceHoldPasses = 1;

  const state = makeState({ rehydrationsPending: false, nodes });
  const assessment = assessPullWork({
    ...state,
    getNextEligibleRunTime: (action) => nodes.get(action)?.gate.backoffUntil,
    isConvergenceBackoffDeferred: () => true,
    isConvergenceHoldActive: (action) =>
      (nodes.get(action)?.gate.convergenceHoldPasses ?? 0) <
        CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES,
  });

  assertEquals(assessment.runnableNow, false);
  assertEquals(assessment.deferredIdleBlocking, true);
});

Deno.test("pending work assessment classifies each source independently", () => {
  const wakeAt = performance.now() + 30_000;
  const cases: Array<{
    name: string;
    kind?: "effect" | "computation";
    demanded?: boolean;
    materializer?: boolean;
    deferred?: boolean;
    expected: {
      runnableNow: boolean;
      nextWakeAt?: number;
      deferredIdleBlocking: boolean;
    };
  }> = [
    {
      name: "live effect",
      kind: "effect",
      expected: {
        runnableNow: true,
        nextWakeAt: undefined,
        deferredIdleBlocking: false,
      },
    },
    {
      name: "materializer",
      kind: "computation",
      materializer: true,
      expected: {
        runnableNow: true,
        nextWakeAt: undefined,
        deferredIdleBlocking: false,
      },
    },
    {
      name: "demanded computation",
      kind: "computation",
      demanded: true,
      expected: {
        runnableNow: true,
        nextWakeAt: undefined,
        deferredIdleBlocking: false,
      },
    },
    {
      name: "irrelevant computation",
      kind: "computation",
      expected: {
        runnableNow: false,
        nextWakeAt: undefined,
        deferredIdleBlocking: false,
      },
    },
    {
      name: "stale unregistered action",
      expected: {
        runnableNow: false,
        nextWakeAt: undefined,
        deferredIdleBlocking: false,
      },
    },
    {
      name: "deferred effect",
      kind: "effect",
      deferred: true,
      expected: {
        runnableNow: false,
        nextWakeAt: wakeAt,
        deferredIdleBlocking: true,
      },
    },
  ];

  for (const scenario of cases) {
    const nodes = new NodeRegistry();
    const action: Action = function pendingAction() {};
    if (scenario.kind) nodes.register(action, scenario.kind);
    const state = makeState({
      rehydrationsPending: false,
      nodes,
      materializers: scenario.materializer ? new Set([action]) : undefined,
      pending: new Set([action]),
    });
    const runnableState = {
      effects: nodes.effects,
      isDemandedPullComputation: (candidate: Action) =>
        scenario.demanded === true && candidate === action,
      shouldRunFirstPullComputationInDemandContext: () => false,
      isThrottled: () => false,
      isDebouncedComputationWaiting: () => false,
    };
    const assessment = assessPullWork({
      ...state,
      pendingPullRunnableState: runnableState,
      dirtyPullRunnableState: runnableState,
      dirtyPullRunnableStateWithDebounce: runnableState,
      getNextEligibleRunTime: (candidate) =>
        scenario.deferred && candidate === action ? wakeAt : undefined,
    });

    assertEquals(
      {
        runnableNow: assessment.runnableNow,
        nextWakeAt: assessment.nextWakeAt,
        deferredIdleBlocking: assessment.deferredIdleBlocking,
      },
      scenario.expected,
      scenario.name,
    );
  }
});
