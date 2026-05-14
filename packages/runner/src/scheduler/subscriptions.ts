import type { Cancel } from "../cancel.ts";
import type { ChangeGroup } from "../storage/interface.ts";
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
  readonly getPullMode: () => boolean;
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

export function updateSchedulerActionType(
  state: SchedulerActionTypeState,
  action: Action,
  isEffect: boolean | undefined,
  options: { queueExecution?: boolean } = {},
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
      (!state.getPullMode() || state.getIdempotencyCheckMode())
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

export function unsubscribeSchedulerAction(
  state: {
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
    readonly actionWriteEntities: WeakMap<Action, Set<SpaceScopeAndURI>>;
    readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
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
  },
  action: Action,
  options: {
    preserveChangeGroup?: boolean;
  } = {},
): void {
  const { preserveChangeGroup = false } = options;
  state.cancels.get(action)?.();
  state.cancels.delete(action);
  state.dependencies.delete(action);
  if (!preserveChangeGroup) {
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
  state.pending.delete(action);
  state.conditionallyScheduledEffects.delete(action);
  // Clear direct/stale state before removing outgoing edges so downstream
  // stale counts are decremented through normal propagation.
  state.clearDirectDirty(action);
  state.forceClearStale(action);
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
  // Clean up effect/computation tracking.
  state.effects.delete(action);
  state.computations.delete(action);
  state.pullDemandedFirstRunComputations.delete(action);
  // Clean up writersByEntity index.
  const writeEntities = state.actionWriteEntities.get(action);
  if (writeEntities) {
    for (const entity of writeEntities) {
      const writers = state.writersByEntity.get(entity);
      writers?.delete(action);
      if (writers && writers.size === 0) {
        state.writersByEntity.delete(entity);
      }
    }
    // Clear actionWriteEntities so resubscribe will re-register the action.
    state.actionWriteEntities.delete(action);
  }
  // NOTE: We intentionally keep parent-child relationships intact.
  // They're needed for cycle detection (identifying obsolete children
  // when parent is re-running). They'll be cleaned up when parent is
  // garbage collected (WeakMap).
  state.cancelDebounceTimer(action);
  state.clearComputationDebounceState(action, { cancelTimer: false });
  // Clean up dependency collection tracking.
  state.populateDependenciesCallbacks.delete(action);
  state.pendingDependencyCollection.delete(action);
}
