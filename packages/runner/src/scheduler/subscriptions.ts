import { getLogger } from "@commonfabric/utils/logger";
import type { Cancel } from "../cancel.ts";
import { toMemorySpaceAddress } from "../link-utils.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { ChangeGroup } from "../storage/interface.ts";
import {
  type DependencyUpdateState,
  pendingDependencyCollectionMightAffect,
  readsOverlapWrites,
  replaceActionTriggerPaths,
  setCancelForTriggerEntities,
  setSchedulerDependencies,
  type TriggerSubscriptionState,
} from "./dependency-index.ts";
import { entityKey } from "./keys.ts";
import type {
  Action,
  PopulateDependencies,
  PopulateDependenciesEntry,
  ReactivityLog,
  SpaceScopeAndURI,
  TelemetryAnnotations,
} from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

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
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly getPullMode: () => boolean;
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

export function subscribeSchedulerAction(
  state: SchedulerSubscribeActionState,
  action: Action,
  populateDependencies: PopulateDependencies | ReactivityLog,
  options: SchedulerSubscribeOptions = {},
): Cancel {
  // Handle backwards-compatible ReactivityLog argument
  let populateDependenciesEntry: PopulateDependenciesEntry;
  let immediateLog: ReactivityLog | undefined;
  if (typeof populateDependencies === "function") {
    populateDependenciesEntry = populateDependencies;
  } else {
    // ReactivityLog provided directly - set up dependencies immediately
    // (for backwards compatibility with code that passes reads/writes)
    immediateLog = populateDependencies;
    populateDependenciesEntry = immediateLog;
  }
  const {
    isEffect = false,
    debounce,
    noDebounce,
    throttle,
  } = options;

  updateSchedulerActionChangeGroup(
    state.subscriptionState,
    action,
    options,
  );

  // Apply debounce settings if provided
  if (debounce !== undefined) {
    state.setDebounce(action, debounce);
  }
  if (noDebounce !== undefined) {
    state.setNoDebounce(action, noDebounce);
  }
  // Apply throttle setting if provided
  if (throttle !== undefined) {
    state.setThrottle(action, throttle);
  }

  const actionIsEffect = updateSchedulerActionType(
    state.subscriptionState,
    action,
    isEffect,
    {
      queueExecution: true,
    },
  );

  // Track parent-child relationship if action is created during another action's execution
  registerParentChildAction(state.subscriptionState, action);
  const parent = state.actionParent.get(action);
  if (
    state.getPullMode() &&
    !actionIsEffect &&
    parent &&
    state.activePullDemandActions.has(parent)
  ) {
    state.pullDemandedFirstRunComputations.add(action);
    state.queueExecution();
  }

  logger.debug(
    "schedule",
    () => [
      "Subscribing to action:",
      action,
      actionIsEffect ? "effect" : "computation",
    ],
  );

  // Store the populateDependencies callback for use in execute()
  state.populateDependenciesCallbacks.set(action, populateDependenciesEntry);

  // In pull mode, newly subscribed computations can be the replacement for an
  // already-running child graph (for example after a $TYPE change). Seed any
  // statically declared writes immediately so existing effects can discover
  // the new writer before the first execute() cycle.
  if (
    state.getPullMode() &&
    !actionIsEffect &&
    !immediateLog
  ) {
    const declaredWrites = (action as Partial<TelemetryAnnotations>).writes;
    if (declaredWrites && declaredWrites.length > 0) {
      setSchedulerDependencies(
        state.dependencyUpdateState,
        action,
        {
          reads: [],
          shallowReads: [],
          writes: declaredWrites.map(toMemorySpaceAddress),
        },
      );
    }
  }

  // If a ReactivityLog was provided directly, set up dependencies immediately.
  // This ensures writes are tracked right away for reverse dependency graph.
  if (immediateLog) {
    const { reads, shallowReads, log: schedulingLog } =
      setSchedulerDependencies(
        state.dependencyUpdateState,
        action,
        immediateLog,
      );
    state.updateDependents(action, schedulingLog);
    const { entities } = replaceActionTriggerPaths(
      state.triggerSubscriptionState,
      action,
      reads,
      shallowReads,
    );

    // Register the cancel function for the latest trigger set.
    setCancelForTriggerEntities(
      state.triggerSubscriptionState,
      action,
      entities,
    );
  } else {
    // Mark action for dependency collection before first run
    state.pendingDependencyCollection.add(action);
  }

  // Mark as dirty and pending for first-time execution
  // In pull mode this still doesn't mean execution: There needs to be an effect to trigger it.
  state.markDirectDirty(action);
  state.pending.add(action);
  state.scheduledFirstTime.add(action);

  if (
    state.getPullMode() &&
    !actionIsEffect &&
    state.getSchedulingWrites(action)?.length
  ) {
    state.scheduleAffectedEffects(action);
  }

  // Emit telemetry for new subscription
  const actionId = state.getActionId(action);
  state.submitSubscribeTelemetry({
    type: "scheduler.subscribe",
    actionId,
    isEffect: actionIsEffect,
  });

  return () => state.unsubscribe(action);
}

export function resubscribeSchedulerAction(
  state: SchedulerSubscribeActionState,
  action: Action,
  log: ReactivityLog,
  options: SchedulerResubscribeOptions = {},
): void {
  const { isEffect } = options;

  updateSchedulerActionChangeGroup(
    state.subscriptionState,
    action,
    options,
  );

  const { reads, shallowReads, log: schedulingLog } = setSchedulerDependencies(
    state.dependencyUpdateState,
    action,
    log,
  );

  // Track action type for pull-based scheduling
  // Once an action is marked as an effect, it stays an effect
  const actionIsEffect = updateSchedulerActionType(
    state.subscriptionState,
    action,
    isEffect,
  );
  const actionId = state.getActionId(action);

  // Update reverse dependency graph after the action type is restored. In
  // pull mode, registering a new edge to a live effect can be the moment a
  // stale upstream computation becomes demanded.
  if (state.getPullMode()) state.updateDependents(action, schedulingLog);

  // Track parent-child relationship if action is created during another action's execution
  // Only set if not already set (resubscribe can be called multiple times)
  registerParentChildAction(state.subscriptionState, action, {
    allowExisting: false,
  });

  const { entities, triggerPathsByEntity } = replaceActionTriggerPaths(
    state.triggerSubscriptionState,
    action,
    reads,
    shallowReads,
  );

  logger.debug("schedule-resubscribe", () => [
    `Action: ${actionId}`,
    `Entities: ${triggerPathsByEntity.size}`,
    `Reads: ${reads.length}`,
  ]);

  setCancelForTriggerEntities(
    state.triggerSubscriptionState,
    action,
    entities,
  );

  markEffectDirtyIfStaleInputs(
    state,
    action,
    actionIsEffect,
    reads,
    shallowReads,
  );
}

function markEffectDirtyIfStaleInputs(
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
  if (!state.getPullMode() || !actionIsEffect || state.stale.size === 0) {
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
    const writers = state.writersByEntity.get(entity);
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

interface SchedulerUnsubscribeActionState {
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
}

function removeActionWriteIndexes(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
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
