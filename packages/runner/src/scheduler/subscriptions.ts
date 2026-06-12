import type { Cancel } from "../cancel.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { ChangeGroup } from "../storage/interface.ts";
import {
  type DependencyGraphState,
  isLive,
  notifyNodeLivenessChange,
  pendingDependencyCollectionMightAffect,
  setNodeProvisionalDemand,
  unregisterDependentEdge,
} from "./dependency-graph.ts";
import { type DependencyUpdateState } from "./dependency-updates.ts";
import {
  readsOverlapWrites,
  type WriterIndexState,
} from "./scheduling-writes.ts";
import {
  type NodeKind,
  NodeRegistry,
  type SchedulerNode,
} from "./node-record.ts";
import { type TriggerSubscriptionState } from "./trigger-index.ts";
import { entityKey } from "./keys.ts";
import type {
  Action,
  PopulateDependenciesEntry,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

type SchedulerActionTypeState = {
  readonly nodes: NodeRegistry;
  readonly dependencyGraphState: DependencyGraphState;
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
  readonly nodes: NodeRegistry;
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
  deferInitialExecution?: boolean;
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
  readonly markProvisionalDemand: (node: SchedulerNode) => void;
  readonly pending: Set<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly writeIndex: WriterIndexState;
  readonly setDebounce: (action: Action, ms: number) => void;
  readonly setNoDebounce: (action: Action, optOut: boolean) => void;
  readonly setThrottle: (action: Action, ms: number) => void;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly isThrottled: (action: Action) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly isInvalid: (action: Action) => boolean;
  readonly markInvalid: (action: Action) => void;
  readonly updateDependents: (action: Action, log: ReactivityLog) => void;
  readonly registerWriterDependents: (
    action: Action,
    writes: readonly IMemorySpaceAddress[],
  ) => void;
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
  // In pull mode: When an effect resubscribes, check if any non-throttled invalid
  // computations write to what it reads. If so, mark the effect dirty so it can
  // pull those computations and see fresh data.
  // Skip delayed computations; their own wake path will re-open demand later.
  // Use the returned action kind instead of active effects because
  // unsubscribe() clears active membership before run().
  if (!actionIsEffect) {
    return;
  }

  const shouldMarkDirty = pendingDependencyCollectionMightAffect(
    state.pendingDependencyCollectionState,
    action,
    reads,
    shallowReads,
  ) ||
    hasInvalidWriterForEffectReads(state, action, reads, shallowReads);

  if (shouldMarkDirty && !state.isInvalid(action)) {
    state.markInvalid(action);
    state.queueExecution();
  }
}

function hasInvalidWriterForEffectReads(
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
      if (!state.isInvalid(writer)) continue;
      if (state.effects.has(writer)) continue; // Only check computations
      if (state.isThrottled(writer)) continue;
      if (state.isDebouncedComputationWaiting(writer)) continue;

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
  const kind: NodeKind = isEffect === true ||
      state.nodes.isKnownEffect(action)
    ? "effect"
    : "computation";
  const existing = state.nodes.get(action);
  const wasLive = existing
    ? isLive(state.dependencyGraphState, existing)
    : false;
  state.nodes.register(action, kind);
  notifyNodeLivenessChange(state.dependencyGraphState, action, wasLive);
  const actionIsEffect = kind === "effect";

  if (actionIsEffect) {
    if (options.queueExecution) {
      state.queueExecution();
    }
  } else {
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
  state.nodes.linkParent(
    action,
    parent && parent !== action ? parent : undefined,
    { allowExisting },
  );
}

export interface SchedulerUnsubscribeActionState {
  readonly cancels: WeakMap<Action, Cancel>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly changeGroupToActionId: Map<ChangeGroup, string>;
  readonly pending: Set<Action>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly dependencyGraphState: DependencyGraphState;
  readonly nodes: NodeRegistry;
  readonly writeIndex: WriterIndexState;
  readonly populateDependenciesCallbacks: WeakMap<
    Action,
    PopulateDependenciesEntry
  >;
  readonly pendingDependencyCollection: Set<Action>;
  readonly getActionId: (action: Action) => string;
  readonly clearInvalid: (action: Action) => void;
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
  const record = state.nodes.get(action);
  if (record) {
    record.invalidCauses = [];
  }
  state.clearInvalid(action);
}

function removeReverseDependencyEdges(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  const dependencies = state.reverseDependencies.get(action);
  if (dependencies) {
    for (const dependency of [...dependencies]) {
      unregisterDependentEdge(state.dependencyGraphState, dependency, action);
    }
  }

  const dependents = state.dependents.get(action);
  if (dependents) {
    for (const dependent of [...dependents]) {
      unregisterDependentEdge(state.dependencyGraphState, action, dependent);
    }
  }
}

function clearActionTypeTracking(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  const record = state.nodes.get(action);
  if (record?.provisionalDemand) {
    setNodeProvisionalDemand(state.dependencyGraphState, record, false);
  }
  state.nodes.remove(action);
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
