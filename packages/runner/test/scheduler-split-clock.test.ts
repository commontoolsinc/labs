import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  applyPullExecuteContinuation,
  applyQuiescentContinuation,
  type ExecuteContinuationState,
} from "../src/scheduler/continuation.ts";
import {
  isRunnableSchedulingSeed,
  type PullSchedulingState,
} from "../src/scheduler/work-oracle.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { SchedulerMaterializers } from "../src/scheduler/materializers.ts";
import {
  NodeRegistry,
  type SchedulerNode,
} from "../src/scheduler/node-record.ts";
import type {
  Action,
  EventHandler,
  QueuedEvent,
} from "../src/scheduler/types.ts";

// F11: a readiness/parked decision must read `performance.now()` once. When the
// head-event park check is evaluated twice with two different clock reads, an
// event whose `notBefore` falls between them is classed as neither ready nor
// parked — so the quiescent continuation resolves idle() with the event still
// queued and undispatched.

describe("split-clock readiness decisions", () => {
  const realNow = performance.now.bind(performance);

  afterEach(() => {
    performance.now = realNow;
  });

  // Return each value in `sequence` on successive reads, then pin the last.
  function stubClock(sequence: readonly number[]): void {
    let i = 0;
    performance.now = () => sequence[Math.min(i++, sequence.length - 1)];
  }

  const testEventLink: NormalizedFullLink = {
    id: "of:scheduler-split-clock-test",
    path: [],
    scope: "space",
    space: "did:key:scheduler-split-clock-test",
  };
  const noopAction: Action = () => {};
  const noopHandler: EventHandler = () => {};

  function queuedEventAt(notBefore: number): QueuedEvent {
    return {
      id: "scheduler-split-clock-test",
      eventLink: testEventLink,
      action: noopAction,
      handler: noopHandler,
      event: {},
      retry: false,
      notBefore,
    };
  }

  function pullSchedulingState(
    overrides: Partial<PullSchedulingState> = {},
  ): PullSchedulingState {
    const nodes = new NodeRegistry();
    const effects = nodes.effects;
    const isDemandedPullComputation = () => false;
    const isThrottled = () => false;
    return {
      nodes,
      pending: new Set<Action>(),
      effects,
      materializerIndex: new SchedulerMaterializers(effects),
      pendingPullRunnableState: {
        effects,
        isDemandedPullComputation,
        shouldRunFirstPullComputationInDemandContext: () => false,
      },
      dirtyPullRunnableState: {
        effects,
        isDemandedPullComputation,
        isThrottled,
      },
      dirtyPullRunnableStateWithDebounce: {
        effects,
        isDemandedPullComputation,
        isThrottled,
        isDebouncedComputationWaiting: () => false,
      },
      isLiveAction: () => false,
      hasActiveDebounceTimer: () => false,
      getNextEligibleRunTime: () => undefined,
      isConvergenceHoldActive: () => false,
      isConvergenceBackoffDeferred: () => false,
      hasPendingInitialRehydrations: () => false,
      ...overrides,
    };
  }

  function schedulerNode(action: Action): SchedulerNode {
    return {
      action,
      ordinal: 0,
      kind: "computation",
      status: "never-ran",
      declaredReads: [],
      invalidCauses: [],
      liveRefs: 0,
      provisionalDemand: false,
      gate: { backoffStreak: 0, convergenceHoldPasses: 0 },
      passRuns: 0,
    };
  }

  it("does not resolve idle for an event straddled between two clock reads", () => {
    const NOT_BEFORE = 150;
    // A buggy two-read decision sees 100 (parked) then 200 (ready) → neither.
    stubClock([100, 200]);

    let idleResolved = false;
    const state = {
      // assessPullWork short-circuits on the rehydration barrier before it
      // reads the clock, so the only clock reads come from the park check.
      pullScheduling: pullSchedulingState({
        hasPendingInitialRehydrations: () => true,
      }),
      eventQueue: [queuedEventAt(NOT_BEFORE)],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => false,
      hasPendingLineageHeadEvent: () => false,
      hasLoadParkedHeadEvent: () => false,
      scheduleWake: () => {},
      hasWakeTimer: () => false,
      setScheduled: () => {},
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => {},
      setPendingQueueTaskTimer: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;

    applyPullExecuteContinuation(state);

    // With a single clock read the head is consistently parked, so idle() must
    // stay open while the event is queued and undispatched.
    expect(idleResolved).toBe(false);
    expect(state.eventQueue.length).toBe(1);
  });

  it("starts a fresh convergence-hold episode after the idle escape", () => {
    let idleResolved = false;
    let holdResets = 0;
    const state = {
      pullScheduling: pullSchedulingState(),
      eventQueue: [],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => false,
      hasPendingLineageHeadEvent: () => false,
      hasLoadParkedHeadEvent: () => false,
      scheduleWake: () => {},
      hasWakeTimer: () => true,
      setScheduled: () => {},
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => holdResets++,
      setPendingQueueTaskTimer: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;

    applyQuiescentContinuation(state, {
      hasParkedHeadEvent: false,
      nextDirtyPullRunAt: 1_000,
      nextDirtyPullRunWaitsForIdle: false,
    });

    expect(idleResolved).toBe(true);
    expect(holdResets).toBe(1);
  });

  it("does not let an irrelevant shared wake hold idle open", () => {
    let idleResolved = false;
    let holdResets = 0;
    const state = {
      pullScheduling: pullSchedulingState(),
      eventQueue: [],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => false,
      hasPendingLineageHeadEvent: () => false,
      hasLoadParkedHeadEvent: () => false,
      scheduleWake: () => {},
      // With no nextDirtyPullRunAt and no parked event, this timer belongs only
      // to dormant/non-idle-relevant work.
      hasWakeTimer: () => true,
      setScheduled: () => {},
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => holdResets++,
      setPendingQueueTaskTimer: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;

    applyQuiescentContinuation(state, { hasParkedHeadEvent: false });

    expect(idleResolved).toBe(true);
    expect(holdResets).toBe(1);
  });

  it("resets convergence holds at an ordinary idle boundary", () => {
    let idleResolved = false;
    let holdResets = 0;
    const state = {
      pullScheduling: pullSchedulingState(),
      eventQueue: [],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => false,
      hasPendingLineageHeadEvent: () => false,
      hasLoadParkedHeadEvent: () => false,
      scheduleWake: () => {},
      hasWakeTimer: () => false,
      setScheduled: () => {},
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => holdResets++,
      setPendingQueueTaskTimer: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;

    applyQuiescentContinuation(state, { hasParkedHeadEvent: false });

    expect(idleResolved).toBe(true);
    expect(holdResets).toBe(1);
  });

  it("isRunnableSchedulingSeed honors the passed clock instead of re-reading", () => {
    const ELIGIBLE_AT = 1000;
    const action = () => {};
    const record = schedulerNode(action);
    const state = pullSchedulingState({
      isLiveAction: () => true,
      getNextEligibleRunTime: () => ELIGIBLE_AT,
    });

    // The internal clock reads PAST the gate; the caller's captured clock reads
    // BEFORE it. A single-clock assessment must use the passed value and treat
    // the node as still time-gated (not runnable).
    stubClock([ELIGIBLE_AT + 100]);
    const runnable = isRunnableSchedulingSeed(state, record, ELIGIBLE_AT - 100);
    expect(runnable).toBe(false);

    // Sanity: past the gate under the same passed clock it is runnable.
    expect(isRunnableSchedulingSeed(state, record, ELIGIBLE_AT + 100)).toBe(
      true,
    );
  });
});
