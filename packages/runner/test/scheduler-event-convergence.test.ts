import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { PASS_RUN_BUDGET } from "../src/scheduler/constants.ts";
import {
  collectInvalidUpstreamForLog,
  type EventPreflightDependencyState,
} from "../src/scheduler/event-preflight-dependencies.ts";
import type { SchedulerSettleLoopState } from "../src/scheduler/execution.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import { runPullSchedulerSettleLoop } from "../src/scheduler/settle.ts";
import type { Action } from "../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

describe("event preflight convergence demand", () => {
  it("keeps an alternating event-only cycle under one pass's budgets", async () => {
    const nodes = new NodeRegistry();
    const actionA: Action = function eventOnlyCycleA() {};
    const actionB: Action = function eventOnlyCycleB() {};
    const recordA = nodes.register(actionA, "computation");
    const recordB = nodes.register(actionB, "computation");
    nodes.setStatus(actionA, "invalid");
    nodes.setStatus(actionB, "clean");
    const pending = new Set<Action>([actionA]);
    let runs = 0;
    const outputA: IMemorySpaceAddress = {
      space: "did:key:event-convergence",
      id: "event:cycle-a",
      path: [],
    };
    const outputB: IMemorySpaceAddress = {
      space: "did:key:event-convergence",
      id: "event:cycle-b",
      path: [],
    };
    const dependencies = new WeakMap([
      [actionA, { reads: [outputB], shallowReads: [], writes: [outputA] }],
      [actionB, { reads: [outputA], shallowReads: [], writes: [outputB] }],
    ]);
    const dependents = new WeakMap<Action, Set<Action>>([
      [actionA, new Set([actionB])],
      [actionB, new Set([actionA])],
    ]);
    const reverseDependencies = new WeakMap<Action, Set<Action>>([
      [actionA, new Set([actionB])],
      [actionB, new Set([actionA])],
    ]);
    const writes = new WeakMap<Action, IMemorySpaceAddress[]>([
      [actionA, [outputA]],
      [actionB, [outputB]],
    ]);
    const writersByEntity = new Map([
      [entityKey(outputA), new Set([actionA])],
      [entityKey(outputB), new Set([actionB])],
    ]);
    const materializerIndex = {
      materializersByEntity: new Map(),
      effects: nodes.effects,
      getMaterializerWriteEnvelopes: () => undefined,
      isMaterializer: () => false,
    };
    const preflightState = {
      getTrace: () => undefined,
      nodes,
      pending,
      reverseDependencies,
      dependents,
      dependencies,
      writersByEntity,
      effects: nodes.effects,
      materializerIndex,
      triggerIndex: { collectReadersForWrite: () => new Set<Action>() },
      getSchedulingWrites: (action) => writes.get(action),
      getActionId: (action) =>
        action === actionA ? "event-only-cycle-a" : "event-only-cycle-b",
    } satisfies EventPreflightDependencyState;
    const handlerDeps = {
      reads: [outputB],
      shallowReads: [],
      writes: [],
    };

    const state = {
      getCollectSettleStats: () => false,
      effects: nodes.effects,
      computations: nodes.computations,
      pending,
      dependencies,
      nodes,
      dependents,
      filterStats: { filtered: 0, executed: 0 },
      materializerIndex,
      writersByEntity,
      getSchedulingWrites: (action) => writes.get(action),
      getSchedulingWritesMap: () => writes,
      collectPullIterationSeeds: () => {},
      refreshPassScopedDemand: (demand) => {
        // This is the production refresh shape: rerun decision 15's inverted
        // invalid-node -> handler-closure query on every settle iteration.
        demand.clear();
        collectInvalidUpstreamForLog(preflightState, handlerDeps, demand);
      },
      getActionId: (action) =>
        action === actionA ? "event-only-cycle-a" : "event-only-cycle-b",
      isThrottled: () => false,
      getNextEligibleRunTime: () => undefined,
      isDebouncedComputationWaiting: () => false,
      clearComputationDebounceState: () => {},
      // The action is demanded only by the head event's preflight closure.
      isLiveAction: () => false,
      runAction: (action) => {
        runs++;
        // Each successful run invalidates the other, initially-clean member.
        // A is the only node invalid at preflight; B must become transiently
        // demanded when the next settle iteration re-evaluates the closure.
        nodes.setStatus(action, "clean");
        nodes.setStatus(action === actionA ? actionB : actionA, "invalid");
        return Promise.resolve();
      },
    } satisfies SchedulerSettleLoopState;

    const result = await runPullSchedulerSettleLoop(
      state,
      new Set([actionA]),
    );

    expect(runs).toBe(PASS_RUN_BUDGET);
    expect(pending.size).toBe(0);
    expect(result.settledEarly).toBe(false);
    expect(result.backoffApplied).toBe(true);
    expect(result.backoffActionCount).toBe(1);
    const deferred = [recordA, recordB].filter((record) =>
      record.gate.backoffUntil !== undefined
    );
    expect(deferred.length).toBe(1);
    expect(deferred[0].gate.backoffUntil).toBeGreaterThan(performance.now());
    expect(deferred[0].gate.convergenceHoldPasses).toBe(1);
  });
});
