import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  applyPullExecuteContinuation,
  type ExecuteContinuationState,
} from "../src/scheduler/continuation.ts";
import {
  isRunnableSchedulingSeed,
  type PullSchedulingState,
} from "../src/scheduler/work-oracle.ts";
import type { SchedulerNode } from "../src/scheduler/node-record.ts";
import type { QueuedEvent } from "../src/scheduler/types.ts";

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

  it("does not resolve idle for an event straddled between two clock reads", () => {
    const NOT_BEFORE = 150;
    // A buggy two-read decision sees 100 (parked) then 200 (ready) → neither.
    stubClock([100, 200]);

    let idleResolved = false;
    const state = {
      // assessPullWork short-circuits on the rehydration barrier before it
      // reads the clock, so the only clock reads come from the park check.
      pullScheduling: {
        hasPendingInitialRehydrations: () => true,
      } as unknown as PullSchedulingState,
      eventQueue: [{ notBefore: NOT_BEFORE } as unknown as QueuedEvent],
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
      setPendingQueueTaskTimer: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;

    applyPullExecuteContinuation(state);

    // With a single clock read the head is consistently parked, so idle() must
    // stay open while the event is queued and undispatched.
    expect(idleResolved).toBe(false);
    expect(state.eventQueue.length).toBe(1);
  });

  it("isRunnableSchedulingSeed honors the passed clock instead of re-reading", () => {
    const ELIGIBLE_AT = 1000;
    const action = () => {};
    const record = {
      action,
      status: "never-ran",
    } as unknown as SchedulerNode;
    const state = {
      isLiveAction: () => true,
      pending: new Set(),
      hasActiveDebounceTimer: () => false,
      getNextEligibleRunTime: () => ELIGIBLE_AT,
      dirtyPullRunnableStateWithDebounce: {
        isThrottled: () => false,
        isDebouncedComputationWaiting: () => false,
      },
    } as unknown as PullSchedulingState;

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
