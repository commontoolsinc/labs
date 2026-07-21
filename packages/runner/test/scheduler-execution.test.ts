import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  planEventInvalidDependencyScheduling,
  pushBoundedHistory,
} from "../src/scheduler/execution.ts";
import type { Action } from "../src/scheduler/types.ts";

describe("scheduler execution planning", () => {
  it("parks debounced invalid dependencies until their scheduled run", () => {
    const debounced: Action = () => {};
    const runnable: Action = () => {};

    const plan = planEventInvalidDependencyScheduling({
      invalidDeps: [debounced, runnable],
      isDebouncedComputationWaiting: (action) => action === debounced,
      getNextDebounceRunTime: (action) =>
        action === debounced ? 1_250 : undefined,
      getNextEligibleRunTime: () => undefined,
      now: 1_000,
    });

    expect(plan).toEqual({
      runnableDeps: [runnable],
      nextEligibleAt: 1_250,
    });
  });

  it("discards the oldest entry when bounded history is full", () => {
    const history = [1, 2];

    pushBoundedHistory(history, 3, 2);

    expect(history).toEqual([2, 3]);
  });
});
