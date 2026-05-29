import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { CellScope, Module, Pattern } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  MediaType,
  TransactionReadWatermark,
} from "../storage/interface.ts";
import type {
  SchedulerEventPreflightActionSummary,
  SchedulerEventPreflightStats,
} from "../telemetry.ts";

export interface TelemetryAnnotations {
  pattern: Pattern;
  module: Module;
  reads: NormalizedFullLink[];
  writes: NormalizedFullLink[];
  materializerWriteEnvelopes?: NormalizedFullLink[];
  ignoredSchedulingWrites?: NormalizedFullLink[];
  schedulerObservationIdentity?: SchedulerObservationIdentity;
}

export interface SchedulerObservationIdentity {
  ownerSpace?: MemorySpace;
  branch?: string;
  pieceId: string;
  processGeneration?: number;
}

export type Action = (tx: IExtendedStorageTransaction) => any;
export type AnnotatedAction = Action & TelemetryAnnotations;
export type EventHandler =
  & ((tx: IExtendedStorageTransaction, event: any) => any)
  & {
    /**
     * Optional callback to populate a transaction with the handler's read dependencies.
     * Called by the scheduler to discover what cells the handler will read.
     * The callback should read all cells (using .get({ traverseCells: true })) that
     * the handler will access, so the transaction captures all dependencies.
     * The event is passed so dependencies can be resolved from links in the event.
     */
    populateDependencies?: (
      tx: IExtendedStorageTransaction,
      event: any,
    ) => void;
  };
export type AnnotatedEventHandler = EventHandler & TelemetryAnnotations;

/**
 * Callback to populate a transaction with an action's read dependencies.
 * Called by the scheduler to discover what cells the action will read.
 * The callback should read all cells (using .get({ traverseCells: true })) that
 * the action will access, so the transaction captures all dependencies.
 * The transaction will be aborted after this callback returns, so it's safe
 * to simulate writes.
 */
export type PopulateDependencies = (tx: IExtendedStorageTransaction) => void;

/**
 * Reactivity log.
 *
 * Used to log reads and writes to docs. Used by scheduler to keep track of
 * dependencies and to topologically sort pending actions before executing them.
 */
export type ReactivityLog = {
  reads: IMemorySpaceAddress[];
  /** Reads that should not invalidate on child writes unless they add a new key */
  shallowReads: IMemorySpaceAddress[];
  writes: IMemorySpaceAddress[];
  readWatermarks?: TransactionReadWatermark[];
};

export type PopulateDependenciesEntry = PopulateDependencies | ReactivityLog;

export type DirtyDependencyTraceContext = SchedulerEventPreflightStats & {
  depth: number;
  actionSummaries: Map<Action, SchedulerEventPreflightActionSummary>;
  rootDirectWriterActions: Set<Action>;
};

export type SpaceScopeAndURI = `${MemorySpace}/${CellScope}/${URI}`;
export type SpaceScopeURIAndType =
  `${MemorySpace}/${CellScope}/${URI}/${MediaType}`;

/** Per-iteration stats captured during the settle loop. */
export interface SettleIterationStats {
  workSetSize: number;
  orderSize: number;
  actionsRun: number;
  /** Action IDs in the work set (truncated to top entries) */
  actions: { id: string; type: "effect" | "computation" }[];
  durationMs: number;
}

/** Stats for the entire settle loop of one execute() call. */
export interface SettleStats {
  iterations: SettleIterationStats[];
  totalDurationMs: number;
  settledEarly: boolean;
  initialSeedCount: number;
}

/** One recorded settle stats entry from execute() history. */
export interface SettleStatsHistoryEntry {
  recordedAt: number;
  stats: SettleStats;
}

export interface ActionRunTraceEntry {
  recordedAt: number;
  actionId: string;
  actionType: "effect" | "computation";
  parentActionId?: string;
  durationMs: number;
  declaredWrites: ActionRunTraceAddress[];
  actualWrites: ActionRunTraceAddress[];
}

export interface ActionRunTraceAddress {
  space: MemorySpace;
  entityId: URI;
  path: string[];
}

export type TriggerTraceValueKind =
  | "undefined"
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "array"
  | "object"
  | "other";

export interface TriggerTraceValueSummary {
  kind: TriggerTraceValueKind;
  size?: number;
  preview?: string | number | boolean | null;
}

export interface TriggerTraceScheduledEffect {
  actionId: string;
  pendingBefore: boolean;
  dirtyBefore: boolean;
  debounceMs?: number;
}

export interface TriggerTraceActionRecord {
  actionId: string;
  actionType: "effect" | "computation";
  mode: "pull" | "push";
  decision:
    | "schedule-push"
    | "schedule-effect"
    | "mark-dirty"
    | "already-dirty"
    | "skip-own-commit-source"
    | "skip-same-change-group"
    | "skip-current-sync";
  pendingBefore: boolean;
  pendingAfter: boolean;
  dirtyBefore: boolean;
  dirtyAfter: boolean;
  scheduledEffects: TriggerTraceScheduledEffect[];
}

export interface TriggerTraceEntry {
  recordedAt: number;
  notificationType: string;
  changeIndex: number;
  matchedActionCount: number;
  mode: "pull" | "push";
  writerActionId?: string;
  space: MemorySpace;
  entityId: URI;
  path: string[];
  before: TriggerTraceValueSummary;
  after: TriggerTraceValueSummary;
  triggered: TriggerTraceActionRecord[];
}

export type QueuedEvent = {
  eventLink: NormalizedFullLink;
  action: Action;
  handler: EventHandler;
  event: any;
  retriesLeft: number;
  onCommit?: (tx: IExtendedStorageTransaction) => void;
  notBefore?: number;
};
