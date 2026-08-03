import { BoundedKeyMap } from "@commonfabric/utils/cache";
import type { ActionStats } from "../telemetry.ts";
import type { Action } from "./types.ts";

export interface ActionTimingState {
  readonly actionStats: BoundedKeyMap<string, ActionStats>;
  readonly getActionId: (action: Action) => string;
}

export function recordActionTime(
  state: ActionTimingState,
  action: Action,
  elapsed: number,
  now = performance.now(),
): void {
  const actionId = state.getActionId(action);
  const existing = state.actionStats.get(actionId);
  if (existing) {
    existing.runCount++;
    existing.totalTime += elapsed;
    existing.averageTime = existing.totalTime / existing.runCount;
    existing.lastRunTime = elapsed;
    existing.lastRunTimestamp = now;
    // Setting it again moves it to the young end, so the map ages entries by
    // when their action last ran.
    state.actionStats.set(actionId, existing);
    return;
  }
  state.actionStats.set(actionId, {
    runCount: 1,
    totalTime: elapsed,
    averageTime: elapsed,
    lastRunTime: elapsed,
    lastRunTimestamp: now,
  });
}

export function getActionStats(
  state: ActionTimingState,
  action: Action | string,
): ActionStats | undefined {
  const actionId = typeof action === "string"
    ? action
    : state.getActionId(action);
  return state.actionStats.get(actionId);
}
