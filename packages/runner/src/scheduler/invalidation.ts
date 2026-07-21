import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  ChangeGroup,
  IMemoryChange,
  IMemorySpaceAddress,
  StorageNotification,
} from "../storage/interface.ts";
import type { TriggerIndexState } from "./trigger-index.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import { summarizeTriggerTraceValue } from "./diagnostics.ts";
import { shaperInstanceGroupKey } from "./wake-shaping.ts";
import type {
  Action,
  SpaceScopeAndURI,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
} from "./types.ts";

export type SchedulerMode = "pull";

export function hasRegisteredTriggers(
  state: TriggerIndexState,
): boolean {
  return state.hasRegisteredTriggers();
}

// Timing side-channel mitigation (plan B, channels 4/5). Return the token-bucket
// group key for this change's subscriber wake when it should be shaped through the
// cell-notification shaper — i.e. the change is a shapable real-world-timing source
// (a renderer `$value` keystroke write, or a server push) AND the reader is a
// pattern instance (carries a pieceId). Internal machinery (no pieceId) and
// ordinary local computation (not a shapable source) return undefined and are
// never deferred, so normal reactivity is untouched.
//
// Only interactive input (renderer `$value` keystrokes) is shaped here, under a
// per-pattern `|input` bucket.
//
// Server pushes (`pull`/`integrate`) are deliberately NOT shaped, because
// deferring them breaks incremental observation adoption
// (docs/specs/scheduler-v2/incremental-observation-adoption.md). Adoption
// requires the push's readers to be marked dirty SYNCHRONOUSLY: a sync delivers
// its `integrate` notification and the writer's `scheduler-observations` in the
// same synchronous turn, and adoption clears exactly the dirt that integrate
// just created (see adoptRemoteObservations in facade.ts). Holding the wake
// moves the mark-dirty to a later macrotask, so adoption finds nothing to clear
// and the receiver re-runs every computation the writer already ran instead of
// adopting it. The two cannot both hold at this seam — the shaper's hold IS the
// mark-dirty — so the push path stays synchronous.
//
// The security cost is small and was already the design's stated position: a
// pattern cannot drive server pushes at sub-second cadence (it has no way to
// make the server push faster than real network traffic arrives), which is the
// same network-bounded assumption the separate `|push` bucket already rested on.
// See the channel-5 row in docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
export function shapableWakeGroupKey(
  state: StorageNotificationState,
  notification: StorageNotification,
  action: Action,
): string | undefined {
  // Space-qualified so two instances of one pattern in different spaces (which
  // can share a content-addressed pieceId) don't collide into one shaper bucket
  // (see shaperInstanceGroupKey). Undefined for internal machinery (no pieceId).
  const instanceKey = shaperInstanceGroupKey(
    (action as {
      schedulerObservationIdentity?: { ownerSpace?: string; pieceId?: string };
    }).schedulerObservationIdentity,
  );
  if (instanceKey === undefined) return undefined;
  if (
    notification.type === "commit" &&
    state.isRendererInputSource(notification.source)
  ) {
    return `${instanceKey}|input`;
  }
  return undefined;
}

export function processStorageNotification(
  state: StorageNotificationState,
  notification: StorageNotification,
): void {
  const space = notification.space;

  if (!("changes" in notification)) {
    return;
  }

  // One charge per notification (one commit or one push): every reader wake this
  // notification produces observes the same instant, so they share one burst token
  // in the cell-notification shaper rather than each spending their own.
  const commitChargeKey = {};

  const sourceChangeGroup = notification.type === "commit"
    ? notification.source?.changeGroup
    : undefined;
  const hasSourceChangeGroup = notification.type === "commit" &&
    sourceChangeGroup !== undefined;
  const collectTriggerTrace = state.getCollectTriggerTrace();
  const diagnosisEnabled = state.getDiagnosisEnabled();

  let changeIndex = 0;
  for (const change of notification.changes) {
    changeIndex++;
    state.recordCellUpdate(change);

    if (!hasRegisteredTriggers(state.triggerIndex)) {
      continue;
    }

    const {
      entity: spaceAndURI,
      hasMatchingTriggerPaths,
      triggeredActions,
    } = collectTriggeredActionsForChange(
      state.triggerIndex,
      space,
      change,
    );

    if (!hasMatchingTriggerPaths) {
      continue;
    }

    const writerActionId = hasSourceChangeGroup &&
        sourceChangeGroup !== undefined
      ? state.changeGroupToActionId.get(sourceChangeGroup)
      : undefined;
    const triggerTraceEntry: TriggerTraceEntry | null = collectTriggerTrace
      ? createTriggerTraceEntry({
        notificationType: notification.type,
        changeIndex,
        matchedActionCount: triggeredActions.length,
        mode: "pull",
        writerActionId,
        space,
        change,
      })
      : null;

    for (const action of triggeredActions) {
      if (
        diagnosisEnabled && hasSourceChangeGroup &&
        sourceChangeGroup !== undefined
      ) {
        const writerActionId = state.changeGroupToActionId.get(
          sourceChangeGroup,
        );
        if (writerActionId) {
          state.recordCausalEdge({
            writer: writerActionId,
            cell: spaceAndURI,
            triggered: state.getActionId(action),
            timestamp: performance.now(),
          });
        }
      }

      const actionChangeGroup = state.actionChangeGroups.get(action);
      const actionId = state.getActionId(action);
      const actionIsEffect = state.effects.has(action);
      const actionType = actionIsEffect ? "effect" : "computation";
      const pendingBefore = state.pending.has(action);
      const dirtyBefore = state.isInvalid(action);
      const isOwnCommitSource = notification.type === "commit" &&
        notification.source !== undefined &&
        notification.source.sourceAction === action;
      const plan = planPullTriggeredAction({
        invalidBefore: dirtyBefore,
        isOwnCommitSource,
        hasSourceChangeGroup,
        actionChangeGroup,
        sourceChangeGroup,
      });
      const cause: IMemorySpaceAddress = { ...change.address, space };
      const shapeGroupKey = plan.operation !== "none"
        ? shapableWakeGroupKey(state, notification, action)
        : undefined;
      if (shapeGroupKey !== undefined) {
        // Defer this pattern reader's wake through the cell-notification
        // shaper, coalesced per (reader, cell) and released with the pattern's
        // window. The reader re-reads current cell state when it runs, so
        // nothing is lost. Record the invalid cause now as well as at release
        // (addInvalidCause dedups by address): an interleaved unshaped wake may
        // run the action and consume its recorded causes before the deferred
        // release, and the deferred rerun must still carry the "this change
        // triggered me" flow label.
        const record = state.nodes.get(action);
        if (record) addInvalidCause(record, cause);
        state.holdShapedNotification(
          shapeGroupKey,
          `${actionId}|${spaceAndURI}`,
          commitChargeKey,
          () => applyPullTriggeredActionPlan(state, action, plan, cause),
        );
      } else {
        applyPullTriggeredActionPlan(state, action, plan, cause);
      }

      triggerTraceEntry?.triggered.push(
        createTriggerTraceActionRecord({
          actionId,
          actionType,
          mode: "pull",
          decision: plan.decision,
          pendingBefore,
          pendingAfter: state.pending.has(action),
          dirtyBefore,
          dirtyAfter: state.isInvalid(action),
        }),
      );
    }

    if (
      triggerTraceEntry &&
      shouldRecordTriggerTraceEntry(triggerTraceEntry)
    ) {
      state.recordTriggerTrace(triggerTraceEntry);
    }
  }
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
 * Record an invalidating address on `record`. Consumed by the next run,
 * whose transaction joins the addresses' labels into the flow-label
 * derivation: the decision to run now was influenced by the changed values
 * even if that run's branch never re-reads them.
 */
export function markInvalid(
  nodes: NodeRegistry,
  action: Action,
  cause?: IMemorySpaceAddress,
): void {
  const record = nodes.get(action);
  if (!record) return;
  if (cause !== undefined) {
    addInvalidCause(record, cause);
  }
  // Status transition goes through the registry so the invalid-node index
  // stays in lockstep; never-ran nodes keep their status (already indexed).
  if (record.status === "clean") {
    nodes.setStatus(action, "invalid");
  }
}

/**
 * Dedup key for a pending invalid cause. Scope participates (an
 * omitted scope normalizes to `space`, matching storage), and JSON keeps
 * path segments unambiguous: ["a","b"] never collides with ["a/b"].
 */
function invalidCauseKey(address: IMemorySpaceAddress): string {
  return JSON.stringify([
    address.space,
    address.scope ?? "space",
    address.id,
    address.path,
  ]);
}

/**
 * Add a pending invalid cause, deduping repeats of the same address across
 * notifications and retry restoration.
 */
export function addInvalidCause(
  record: SchedulerNode,
  address: IMemorySpaceAddress,
): void {
  const key = invalidCauseKey(address);
  if (record.invalidCauses.some((cause) => invalidCauseKey(cause) === key)) {
    return;
  }
  record.invalidCauses.push(address);
}

export function takeInvalidCauses(
  record: SchedulerNode,
): readonly IMemorySpaceAddress[] | undefined {
  if (record.invalidCauses.length === 0) return undefined;
  const causes = record.invalidCauses;
  record.invalidCauses = [];
  return causes;
}

export function restoreInvalidCauses(
  nodes: NodeRegistry,
  action: Action,
  addresses: readonly IMemorySpaceAddress[],
): void {
  for (const address of addresses) {
    markInvalid(nodes, action, address);
  }
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
  operation: "none" | "schedule" | "invalidate";
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

  // changeGroup is a user-facing suppression feature: external
  // subscribers (e.g. cf-code-editor sinks) group their own writes so
  // their subscription ignores them. It is NOT scheduler-internal
  // self-suppression — that is tx.sourceAction (spec scheduler-v2 P5).
  if (
    state.hasSourceChangeGroup &&
    state.actionChangeGroup !== undefined &&
    Object.is(state.actionChangeGroup, state.sourceChangeGroup)
  ) {
    return { decision: "skip-same-change-group", operation: "none" };
  }

  return undefined;
}

export function planPullTriggeredAction(
  state: TriggeredActionSkipState & {
    readonly invalidBefore: boolean;
  },
): TriggeredActionPlan {
  const skipped = planSkippedTriggeredAction(state);
  if (skipped) return skipped;

  return {
    decision: state.invalidBefore ? "already-invalid" : "mark-invalid",
    operation: "invalidate",
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
  };
}

export function shouldRecordTriggerTraceEntry(
  entry: TriggerTraceEntry,
): boolean {
  return entry.triggered.length > 0 || entry.matchedActionCount > 0;
}

export function applyPullTriggeredActionPlan(
  state: StorageNotificationState,
  action: Action,
  plan: TriggeredActionPlan,
  cause: IMemorySpaceAddress,
): void {
  if (plan.operation === "schedule") {
    state.scheduleWithDebounce(action);
    return;
  }

  if (plan.operation === "invalidate") {
    state.markInvalid(action, cause);
  }
}

interface CausalEdge {
  writer: string;
  cell: string;
  triggered: string;
  timestamp: number;
}

export interface StorageNotificationState {
  readonly triggerIndex: TriggerIndexState;
  readonly nodes: NodeRegistry;
  readonly getDiagnosisEnabled: () => boolean;
  readonly getCollectTriggerTrace: () => boolean;
  readonly changeGroupToActionId: Map<ChangeGroup, string>;
  readonly recordCausalEdge: (edge: CausalEdge) => void;
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly effects: ReadonlySet<Action>;
  readonly pending: ReadonlySet<Action>;
  readonly getActionId: (action: Action) => string;
  readonly recordCellUpdate: (change: IMemoryChange) => void;
  readonly recordTriggerTrace: (entry: TriggerTraceEntry) => void;
  readonly scheduleWithDebounce: (action: Action) => void;
  readonly markInvalid: (
    action: Action,
    cause: IMemorySpaceAddress,
  ) => void;
  readonly isInvalid: (action: Action) => boolean;
  readonly materializerIndex: MaterializerIndexState;
  readonly queueExecution: () => void;
  // Timing side-channel mitigation (plan B, channels 4/5). Whether a committed
  // change came from a renderer `$value` keystroke write — its notification
  // `source` carries the renderer-input mark — so the resulting subscriber wake
  // should be shaped.
  readonly isRendererInputSource: (source: object | undefined) => boolean;
  // Defer a shapable subscriber wake through the cell-notification shaper.
  // groupKey identifies the observing pattern instance (so a pattern's shaped
  // wakes share one window); itemKey is the (reader, cell) coalescing unit;
  // deliver performs the wake once the shaping window releases. chargeKey
  // identifies the source commit so all its reader wakes share one burst token.
  readonly holdShapedNotification: (
    groupKey: string,
    itemKey: string,
    chargeKey: object,
    deliver: () => void,
  ) => void;
}
