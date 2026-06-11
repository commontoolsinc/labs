import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  ChangeGroup,
  IMemoryChange,
  IMemorySpaceAddress,
  IStorageTransaction,
} from "../storage/interface.ts";
import type { TriggerIndexState } from "./trigger-index.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import { summarizeTriggerTraceValue } from "./diagnostics.ts";
import type {
  Action,
  SpaceScopeAndURI,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
  TriggerTraceScheduledEffect,
} from "./types.ts";

export type SchedulerMode = "pull" | "push";

export function hasRegisteredTriggers(
  state: TriggerIndexState,
): boolean {
  return state.hasRegisteredTriggers();
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
  return state.collectTriggeredActionsForChange(space, change);
}

/**
 * Record the address whose change scheduled `action` (§8.9.2 trigger
 * reads). Consumed by the action's next run, whose transaction joins the
 * addresses' labels into the flow-label derivation: the decision to run
 * now was influenced by the changed values even if that run's branch never
 * re-reads them.
 */
export function recordCfcTriggerRead(
  state: Pick<StorageNotificationState, "cfcTriggerReads">,
  action: Action,
  space: MemorySpace,
  change: IMemoryChange,
): void {
  addCfcTriggerRead(state, action, { ...change.address, space });
}

/**
 * Dedup key for a pending trigger-read address. Scope participates (an
 * omitted scope normalizes to `space`, matching storage), and JSON keeps
 * path segments unambiguous: ["a","b"] never collides with ["a/b"].
 */
function cfcTriggerReadKey(address: IMemorySpaceAddress): string {
  return JSON.stringify([
    address.space,
    address.scope ?? "space",
    address.id,
    address.path,
  ]);
}

/**
 * Add a pending trigger-read address for `action`, deduping repeats of the
 * same address across notifications. Also restores consumed addresses when
 * an aborted run is retried: the retry still exists only because of these
 * triggers, so its writes must carry their labels.
 */
export function addCfcTriggerRead(
  state: Pick<StorageNotificationState, "cfcTriggerReads">,
  action: Action,
  address: IMemorySpaceAddress,
): void {
  let pending = state.cfcTriggerReads.get(action);
  if (pending === undefined) {
    pending = { addresses: [], keys: new Set() };
    state.cfcTriggerReads.set(action, pending);
  }
  const key = cfcTriggerReadKey(address);
  if (pending.keys.has(key)) {
    return;
  }
  pending.keys.add(key);
  pending.addresses.push(address);
}

export function createTriggerTraceEntry(state: {
  readonly notificationType: string;
  readonly changeIndex: number;
  readonly matchedActionCount: number;
  readonly mode: SchedulerMode;
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
    mode: state.mode,
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

interface TriggeredActionSkipState {
  readonly isOwnCommitSource: boolean;
  readonly hasSourceChangeGroup: boolean;
  readonly actionChangeGroup: ChangeGroup | undefined;
  readonly sourceChangeGroup: ChangeGroup | undefined;
}

function planSkippedTriggeredAction(
  state: TriggeredActionSkipState,
): TriggeredActionPlan | undefined {
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

  return undefined;
}

export function planPushTriggeredAction(
  state: TriggeredActionSkipState,
): TriggeredActionPlan {
  return planSkippedTriggeredAction(state) ??
    { decision: "schedule-push", operation: "schedule" };
}

export function planPullTriggeredAction(
  state: TriggeredActionSkipState & {
    readonly isEffect: boolean;
    readonly dirtyBefore: boolean;
  },
): TriggeredActionPlan {
  const skipped = planSkippedTriggeredAction(state);
  if (skipped) return skipped;

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
  readonly mode: SchedulerMode;
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
    mode: state.mode,
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

export function applyPushTriggeredActionPlan(
  state: StorageNotificationState,
  action: Action,
  plan: TriggeredActionPlan,
): void {
  if (plan.operation === "schedule") {
    state.scheduleWithDebounce(action);
  }
}

export function applyPullTriggeredActionPlan(
  state: StorageNotificationState,
  action: Action,
  isEffect: boolean,
  plan: TriggeredActionPlan,
): TriggerTraceScheduledEffect[] {
  if (plan.operation === "schedule") {
    if (isEffect) {
      state.conditionallyScheduledEffects.delete(action);
    }
    state.scheduleWithDebounce(action);
    return [];
  }

  if (plan.operation === "mark-dirty") {
    state.markDirty(action);
    const scheduledEffects = state.scheduleAffectedEffects(action);
    if (state.materializerIndex.isMaterializer(action)) {
      state.queueExecution();
    }
    return scheduledEffects;
  }

  return [];
}

interface CausalEdge {
  writer: string;
  cell: string;
  triggered: string;
  timestamp: number;
}

export interface StorageNotificationState {
  readonly triggerIndex: TriggerIndexState;
  // Pending CFC trigger reads per dirtied action (§8.9.2): the addresses
  // whose invalidating writes scheduled it. Consumed when the action next
  // runs; that run's transaction joins their labels into the flow-label
  // derivation. `keys` dedups addresses across notifications.
  readonly cfcTriggerReads: WeakMap<
    Action,
    { addresses: IMemorySpaceAddress[]; keys: Set<string> }
  >;
  readonly getDiagnosisEnabled: () => boolean;
  readonly getCollectTriggerTrace: () => boolean;
  readonly changeGroupToActionId: Map<ChangeGroup, string>;
  readonly recordCausalEdge: (edge: CausalEdge) => void;
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly effects: ReadonlySet<Action>;
  readonly pending: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly inFlightSources: WeakMap<Action, Set<IStorageTransaction>>;
  readonly conditionallyScheduledEffects: Map<Action, number>;
  readonly getActionId: (action: Action) => string;
  readonly recordCellUpdate: (change: IMemoryChange) => void;
  readonly recordTriggerTrace: (entry: TriggerTraceEntry) => void;
  readonly scheduleWithDebounce: (action: Action) => void;
  readonly markDirty: (action: Action) => void;
  readonly materializerIndex: MaterializerIndexState;
  readonly queueExecution: () => void;
  readonly scheduleAffectedEffects: (
    action: Action,
  ) => TriggerTraceScheduledEffect[];
}
