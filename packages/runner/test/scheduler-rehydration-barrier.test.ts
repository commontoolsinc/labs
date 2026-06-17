import { assertEquals } from "@std/assert";
import {
  collectPullIterationSeeds,
  hasRunnablePullWork,
  type PullSchedulingState,
} from "../src/scheduler/pull-scheduling.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import type { Action } from "../src/scheduler/types.ts";

// Guards the reload "rehydration barrier" (scheduler-v2 3c): while an initial
// rehydration (resume from persisted state) is in flight, NO pull work runs, so
// a sync-fill of a resuming never-ran action can't promote it into the
// status-based runnable-seed set, run it fresh, and abort the resume. Without
// the barrier this made notebook reload nondeterministic and could hang on slow
// CI runners. See pull-scheduling.ts:hasPendingInitialRehydrations.

function makeState(opts: {
  rehydrationsPending: boolean;
  nodes: NodeRegistry;
}): PullSchedulingState {
  const debounceState = {
    isThrottled: () => false,
    isDebouncedComputationWaiting: () => false,
  };
  return {
    nodes: opts.nodes,
    pending: new Set<Action>(),
    effects: opts.nodes.effects,
    // Unused while a primary seed exists / the barrier is engaged.
    materializerIndex: { isMaterializer: () => false } as never,
    pendingPullRunnableState: {} as never,
    dirtyPullRunnableState: {} as never,
    dirtyPullRunnableStateWithDebounce: debounceState as never,
    isLiveAction: () => true,
    hasActiveDebounceTimer: () => false,
    getNextEligibleRunTime: () => undefined,
    hasPendingInitialRehydrations: () => opts.rehydrationsPending,
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
