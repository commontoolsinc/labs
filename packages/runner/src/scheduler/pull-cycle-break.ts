import { getLogger } from "@commonfabric/utils/logger";
import { planPullCycleBreak, type SchedulerSettleResult } from "./execution.ts";
import type { Action } from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export interface PullCycleBreakState {
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly runsThisExecute: ReadonlyMap<Action, number>;
  readonly pending: Set<Action>;
  readonly isThrottled: (action: Action) => boolean;
  readonly clearDirty: (action: Action) => void;
  readonly clearInvalid: (action: Action) => void;
  readonly unsubscribe: (action: Action) => void;
  readonly recordExecuted: () => void;
  readonly getActionId: (action: Action) => string;
  readonly runAction: (action: Action) => Promise<unknown>;
}

export async function breakPullCyclesIfNeeded(
  state: PullCycleBreakState,
  settleResult: SchedulerSettleResult,
): Promise<void> {
  // If we hit max iterations without settling, break the cycle:
  // 1. Clear dirty/pending for computations that were in early iterations AND still in last workSet
  // 2. Run all remaining dirty effects so they don't get lost
  const cycleBreakPlan = planPullCycleBreak({
    settledEarly: settleResult.settledEarly,
    lastWorkSet: settleResult.lastWorkSet,
    earlyIterationComputations: settleResult.earlyIterationComputations,
    dirty: state.dirty,
    effects: state.effects,
    runsThisExecute: state.runsThisExecute,
    isThrottled: state.isThrottled,
  });
  if (!cycleBreakPlan.shouldBreak) return;

  logger.debug("schedule-cycle", () => [
    `[CYCLE-BREAK] Hit max iterations (${settleResult.maxSettleIterations}), breaking cycle`,
    `Early computations: ${settleResult.earlyIterationComputations.size}, Last workSet: ${settleResult.lastWorkSet.size}`,
  ]);

  // Clear computations that appear to be in the cycle
  // (present in early iterations AND still in the last workSet)
  // But don't clear throttled computations - they should stay dirty
  for (const comp of cycleBreakPlan.computationsToClear) {
    logger.debug("schedule-cycle", () => [
      `[CYCLE-BREAK] Clearing cyclic computation: ${state.getActionId(comp)}`,
    ]);
    state.clearDirty(comp);
    state.clearInvalid(comp);
    state.pending.delete(comp);
  }

  // Run all remaining dirty effects - these shouldn't be lost
  // But skip throttled effects - they should stay dirty for later
  for (const effect of cycleBreakPlan.dirtyEffectsToRun) {
    if (state.effects.has(effect) && state.dirty.has(effect)) {
      logger.debug("schedule-cycle", () => [
        `[CYCLE-BREAK] Running dirty effect: ${state.getActionId(effect)}`,
      ]);
      state.clearDirty(effect);
      state.pending.delete(effect);
      state.unsubscribe(effect);
      state.recordExecuted();
      await state.runAction(effect);
    }
  }
}
