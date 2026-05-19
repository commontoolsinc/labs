import type { Cancel } from "../cancel.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { ChangeGroup } from "../storage/interface.ts";
import { pendingDependencyCollectionMightAffect } from "./dependency-graph.ts";
import { type DependencyUpdateState } from "./dependency-updates.ts";
import {
  readsOverlapWrites,
  type WriterIndexState,
} from "./scheduling-writes.ts";
import { type TriggerSubscriptionState } from "./trigger-index.ts";
import { entityKey } from "./keys.ts";
import type {
  Action,
  PopulateDependenciesEntry,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

type SchedulerActionTypeState = {
  readonly isEffectAction: WeakMap<Action, boolean>;
  readonly effects: Set<Action>;
  readonly computations: Set<Action>;
  readonly getIdempotencyCheckMode: () => boolean;
  readonly queueExecution: () => void;
};

type SchedulerActionChangeGroupState = {
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly changeGroupToActionId: Map<ChangeGroup, string>;
  readonly getActionId: (action: Action) => string;
};

type SchedulerParentChildState = {
  readonly getExecutingAction: () => Action | null;
  readonly actionParent: WeakMap<Action, Action>;
  readonly actionChildren: WeakMap<Action, Set<Action>>;
};

export type SchedulerSubscriptionState =
  & SchedulerActionTypeState
  & SchedulerActionChangeGroupState
  & SchedulerParentChildState;

export interface SchedulerSubscribeOptions {
  isEffect?: boolean;
  debounce?: number;
  noDebounce?: boolean;
  throttle?: number;
  changeGroup?: ChangeGroup;
}

export interface SchedulerResubscribeOptions {
  isEffect?: boolean;
  changeGroup?: ChangeGroup;
}

export interface SchedulerSubscribeActionState {
  readonly subscriptionState: SchedulerSubscriptionState;
  readonly dependencyUpdateState: DependencyUpdateState;
  readonly triggerSubscriptionState: TriggerSubscriptionState;
  readonly pendingDependencyCollectionState: {
    readonly pendingDependencyCollection: ReadonlySet<Action>;
    readonly effects: ReadonlySet<Action>;
    readonly isThrottled: (action: Action) => boolean;
    readonly getSchedulingWrites: (
      action: Action,
    ) => readonly IMemorySpaceAddress[] | undefined;
    readonly hasDependentPath: (from: Action, to: Action) => boolean;
  };
  readonly populateDependenciesCallbacks: WeakMap<
    Action,
    PopulateDependenciesEntry
  >;
  readonly pendingDependencyCollection: Set<Action>;
  readonly activePullDemandActions: WeakSet<Action>;
  readonly pullDemandedFirstRunComputations: WeakSet<Action>;
  readonly actionParent: WeakMap<Action, Action>;
  readonly pending: Set<Action>;
  readonly scheduledFirstTime: Set<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly stale: ReadonlySet<Action>;
  readonly writeIndex: WriterIndexState;
  readonly setDebounce: (action: Action, ms: number) => void;
  readonly setNoDebounce: (action: Action, optOut: boolean) => void;
  readonly setThrottle: (action: Action, ms: number) => void;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly isThrottled: (action: Action) => boolean;
  readonly isStale: (action: Action) => boolean;
  readonly markDirectDirty: (action: Action) => void;
  readonly markEffectConditionallyScheduled: (action: Action) => void;
  readonly updateDependents: (action: Action, log: ReactivityLog) => void;
  readonly scheduleAffectedEffects: (action: Action) => void;
  readonly queueExecution: () => void;
  readonly getActionId: (action: Action) => string;
  readonly unsubscribe: (action: Action) => void;
  readonly submitSubscribeTelemetry: (
    event: {
      type: "scheduler.subscribe";
      actionId: string;
      isEffect: boolean;
    },
  ) => void;
}

export function markEffectDirtyIfStaleInputs(
  state: SchedulerSubscribeActionState,
  action: Action,
  actionIsEffect: boolean,
  reads: readonly IMemorySpaceAddress[],
  shallowReads: readonly IMemorySpaceAddress[],
): void {
  // In pull mode: When an effect resubscribes, check if any non-throttled dirty
  // computations write to what it reads. If so, mark the effect dirty so it can
  // pull those computations and see fresh data.
  // Skip throttled computations - they'll trigger via storage changes when unthrottled.
  // Use isEffectAction instead of effects because unsubscribe() clears effects before run()
  if (!actionIsEffect || state.stale.size === 0) {
    return;
  }

  const shouldMarkDirty = pendingDependencyCollectionMightAffect(
    state.pendingDependencyCollectionState,
    action,
    reads,
    shallowReads,
  ) ||
    hasStaleWriterForEffectReads(state, action, reads, shallowReads);

  if (shouldMarkDirty && !state.dirty.has(action)) {
    state.markEffectConditionallyScheduled(action);
    state.markDirectDirty(action);
    state.pending.add(action);
    state.queueExecution();
  }
}

function hasStaleWriterForEffectReads(
  state: SchedulerSubscribeActionState,
  action: Action,
  effectReads: readonly IMemorySpaceAddress[],
  effectShallowReads: readonly IMemorySpaceAddress[],
): boolean {
  // Use writersByEntity index for efficient lookup.
  const entities = new Set<SpaceScopeAndURI>();
  for (const read of effectReads) {
    entities.add(entityKey(read));
  }
  for (const read of effectShallowReads) {
    entities.add(entityKey(read));
  }

  for (const entity of entities) {
    const writers = state.writeIndex.writersByEntity.get(entity);
    if (!writers) continue;

    for (const writer of writers) {
      if (writer === action) continue;
      if (!state.isStale(writer)) continue;
      if (state.effects.has(writer)) continue; // Only check computations
      if (state.isThrottled(writer)) continue; // Skip throttled - they trigger via storage

      // Check path overlap.
      const writerWrites = state.getSchedulingWrites(writer) ?? [];
      if (
        readsOverlapWrites(
          effectReads,
          effectShallowReads,
          writerWrites,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

export function updateSchedulerActionType(
  state: SchedulerActionTypeState,
  action: Action,
  isEffect: boolean | undefined,
  options: { queueExecution?: boolean; queueComputation?: boolean } = {},
): boolean {
  if (isEffect) {
    state.isEffectAction.set(action, true);
  }

  const actionIsEffect = state.isEffectAction.get(action) ?? false;

  if (actionIsEffect) {
    state.effects.add(action);
    state.computations.delete(action);
    if (options.queueExecution) {
      state.queueExecution();
    }
  } else {
    state.computations.add(action);
    state.effects.delete(action);
    if (
      options.queueExecution &&
      (options.queueComputation ?? true)
    ) {
      state.queueExecution();
    }
  }

  return actionIsEffect;
}

export function updateSchedulerActionChangeGroup(
  state: SchedulerActionChangeGroupState,
  action: Action,
  options: { changeGroup?: ChangeGroup },
): void {
  if (
    !Object.prototype.hasOwnProperty.call(options, "changeGroup")
  ) {
    return;
  }
  const previousChangeGroup = state.actionChangeGroups.get(action);
  const actionId = state.getActionId(action);
  if (
    previousChangeGroup !== undefined &&
    state.changeGroupToActionId.get(previousChangeGroup) === actionId
  ) {
    state.changeGroupToActionId.delete(previousChangeGroup);
  }
  if (options.changeGroup === undefined) {
    state.actionChangeGroups.delete(action);
  } else {
    state.actionChangeGroups.set(action, options.changeGroup);
    state.changeGroupToActionId.set(options.changeGroup, actionId);
  }
}

export function registerParentChildAction(
  state: SchedulerParentChildState,
  action: Action,
  options: { allowExisting?: boolean } = {},
): void {
  const { allowExisting = true } = options;
  const parent = state.getExecutingAction();
  if (!parent || parent === action) return;
  if (!allowExisting && state.actionParent.has(action)) return;

  state.actionParent.set(action, parent);

  let children = state.actionChildren.get(parent);
  if (!children) {
    children = new Set();
    state.actionChildren.set(parent, children);
  }
  children.add(action);
}

export interface SchedulerUnsubscribeActionState {
  readonly cancels: WeakMap<Action, Cancel>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly changeGroupToActionId: Map<ChangeGroup, string>;
  readonly pending: Set<Action>;
  readonly conditionallyScheduledEffects: Map<Action, number>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly effects: Set<Action>;
  readonly computations: Set<Action>;
  readonly pullDemandedFirstRunComputations: WeakSet<Action>;
  readonly pullDemandedContinuationComputations: WeakSet<Action>;
  readonly writeIndex: WriterIndexState;
  readonly populateDependenciesCallbacks: WeakMap<
    Action,
    PopulateDependenciesEntry
  >;
  readonly pendingDependencyCollection: Set<Action>;
  readonly getActionId: (action: Action) => string;
  readonly clearDirectDirty: (action: Action) => void;
  readonly forceClearStale: (action: Action) => void;
  readonly cancelDebounceTimer: (action: Action) => void;
  readonly clearComputationDebounceState: (
    action: Action,
    options?: { cancelTimer?: boolean },
  ) => void;
}

export function unsubscribeSchedulerAction(
  state: SchedulerUnsubscribeActionState,
  action: Action,
  options: {
    preserveChangeGroup?: boolean;
  } = {},
): void {
  const { preserveChangeGroup = false } = options;
  cancelActionSubscription(state, action);
  state.dependencies.delete(action);
  clearActionChangeGroup(state, action, preserveChangeGroup);
  clearActionSchedulingState(state, action);
  removeReverseDependencyEdges(state, action);
  clearActionTypeTracking(state, action);
  removeActionWriteIndexes(state, action);
  // NOTE: We intentionally keep parent-child relationships intact.
  // They're needed for cycle detection (identifying obsolete children
  // when parent is re-running). They'll be cleaned up when parent is
  // garbage collected (WeakMap).
  clearActionDelayState(state, action);
  clearDependencyCollectionState(state, action);
}

function cancelActionSubscription(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.cancels.get(action)?.();
  state.cancels.delete(action);
}

function clearActionChangeGroup(
  state: SchedulerUnsubscribeActionState,
  action: Action,
  preserveChangeGroup: boolean,
): void {
  if (preserveChangeGroup) return;

  const changeGroup = state.actionChangeGroups.get(action);
  const actionId = state.getActionId(action);
  if (
    changeGroup !== undefined &&
    state.changeGroupToActionId.get(changeGroup) === actionId
  ) {
    state.changeGroupToActionId.delete(changeGroup);
  }
  state.actionChangeGroups.delete(action);
}

function clearActionSchedulingState(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.pending.delete(action);
  state.conditionallyScheduledEffects.delete(action);
  // Clear direct/stale state before removing outgoing edges so downstream
  // stale counts are decremented through normal propagation.
  state.clearDirectDirty(action);
  state.forceClearStale(action);
}

function removeReverseDependencyEdges(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  const dependencies = state.reverseDependencies.get(action);
  if (dependencies) {
    for (const dependency of dependencies) {
      const dependents = state.dependents.get(dependency);
      dependents?.delete(action);
      if (dependents && dependents.size === 0) {
        state.dependents.delete(dependency);
      }
    }
    state.reverseDependencies.delete(action);
  }
  state.dependents.delete(action);
}

function clearActionTypeTracking(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.effects.delete(action);
  state.computations.delete(action);
  state.pullDemandedFirstRunComputations.delete(action);
  state.pullDemandedContinuationComputations.delete(action);
}

function removeActionWriteIndexes(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.writeIndex.clearAction(action);
}

function clearActionDelayState(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.cancelDebounceTimer(action);
  state.clearComputationDebounceState(action, { cancelTimer: false });
}

function clearDependencyCollectionState(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.populateDependenciesCallbacks.delete(action);
  state.pendingDependencyCollection.delete(action);
}
