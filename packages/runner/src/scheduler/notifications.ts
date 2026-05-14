import type { MemorySpace } from "@commonfabric/memory/interface";
import { determineTriggeredActions } from "../reactive-dependencies.ts";
import type { ChangeGroup, IMemoryChange } from "../storage/interface.ts";
import type { TriggerIndexState } from "./dependency-index.ts";
import { summarizeTriggerTraceValue } from "./diagnostics.ts";
import { entityKey } from "./keys.ts";
import type {
  Action,
  SpaceScopeAndURI,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
  TriggerTraceScheduledEffect,
} from "./types.ts";

type SchedulerMode = "pull" | "push";

export function schedulerMode(pullMode: boolean): SchedulerMode {
  return pullMode ? "pull" : "push";
}

export function hasRegisteredTriggers(
  state: TriggerIndexState,
): boolean {
  return state.triggers.size > 0 || state.nonRecursiveTriggers.size > 0;
}

export function collectTriggeredActionsForChange(
  state: TriggerIndexState,
  space: MemorySpace,
  change: IMemoryChange,
): {
  entity: SpaceScopeAndURI;
  hasMatchingTriggerPaths: boolean;
  triggeredActions: Action[];
} {
  const entity = entityKey({ ...change.address, space });
  const paths = state.triggers.get(entity);
  const nonRecursivePaths = state.nonRecursiveTriggers.get(entity);

  if (!paths && !nonRecursivePaths) {
    return {
      entity,
      hasMatchingTriggerPaths: false,
      triggeredActions: [],
    };
  }

  const triggeredActionSet = new Set<Action>();
  if (paths) {
    for (
      const action of determineTriggeredActions(
        paths,
        change.before,
        change.after,
        change.address.path,
      )
    ) {
      triggeredActionSet.add(action);
    }
  }
  if (nonRecursivePaths) {
    for (
      const action of determineTriggeredActions(
        nonRecursivePaths,
        change.before,
        change.after,
        change.address.path,
        { nonRecursive: true },
      )
    ) {
      triggeredActionSet.add(action);
    }
  }

  return {
    entity,
    hasMatchingTriggerPaths: true,
    triggeredActions: [...triggeredActionSet],
  };
}

export function createTriggerTraceEntry(state: {
  readonly notificationType: string;
  readonly changeIndex: number;
  readonly matchedActionCount: number;
  readonly pullMode: boolean;
  readonly writerActionId?: string;
  readonly space: MemorySpace;
  readonly change: IMemoryChange;
  readonly now?: number;
}): TriggerTraceEntry {
  return {
    recordedAt: state.now ?? performance.now(),
    notificationType: state.notificationType,
    changeIndex: state.changeIndex,
    matchedActionCount: state.matchedActionCount,
    mode: schedulerMode(state.pullMode),
    writerActionId: state.writerActionId,
    space: state.space,
    entityId: state.change.address.id,
    path: [...state.change.address.path],
    before: summarizeTriggerTraceValue(state.change.before),
    after: summarizeTriggerTraceValue(state.change.after),
    triggered: [],
  };
}

export interface TriggeredActionPlan {
  decision: TriggerTraceActionRecord["decision"];
  operation: "none" | "schedule" | "mark-dirty";
}

export function planTriggeredAction(state: {
  readonly pullMode: boolean;
  readonly isEffect: boolean;
  readonly dirtyBefore: boolean;
  readonly isOwnCommitSource: boolean;
  readonly hasSourceChangeGroup: boolean;
  readonly actionChangeGroup: ChangeGroup | undefined;
  readonly sourceChangeGroup: ChangeGroup | undefined;
}): TriggeredActionPlan {
  if (state.isOwnCommitSource) {
    return { decision: "skip-own-commit-source", operation: "none" };
  }

  if (
    state.hasSourceChangeGroup &&
    state.actionChangeGroup !== undefined &&
    Object.is(state.actionChangeGroup, state.sourceChangeGroup)
  ) {
    return { decision: "skip-same-change-group", operation: "none" };
  }

  if (!state.pullMode) {
    return { decision: "schedule-push", operation: "schedule" };
  }

  if (state.isEffect) {
    return { decision: "schedule-effect", operation: "schedule" };
  }

  return {
    decision: state.dirtyBefore ? "already-dirty" : "mark-dirty",
    operation: "mark-dirty",
  };
}

export function createTriggerTraceActionRecord(state: {
  readonly actionId: string;
  readonly actionType: "effect" | "computation";
  readonly pullMode: boolean;
  readonly decision: TriggerTraceActionRecord["decision"];
  readonly pendingBefore: boolean;
  readonly pendingAfter: boolean;
  readonly dirtyBefore: boolean;
  readonly dirtyAfter: boolean;
  readonly scheduledEffects: TriggerTraceScheduledEffect[];
}): TriggerTraceActionRecord {
  return {
    actionId: state.actionId,
    actionType: state.actionType,
    mode: schedulerMode(state.pullMode),
    decision: state.decision,
    pendingBefore: state.pendingBefore,
    pendingAfter: state.pendingAfter,
    dirtyBefore: state.dirtyBefore,
    dirtyAfter: state.dirtyAfter,
    scheduledEffects: state.scheduledEffects,
  };
}

export function shouldRecordTriggerTraceEntry(
  entry: TriggerTraceEntry,
): boolean {
  return entry.triggered.length > 0 || entry.matchedActionCount > 0;
}
