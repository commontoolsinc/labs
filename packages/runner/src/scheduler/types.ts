import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { CellScope, Module, Pattern } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  MediaType,
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
  /**
   * Concrete structural surface for a transformer-proven complete source lift.
   * This is runner-owned metadata; raw modules, handlers, and unresolved
   * redirect surfaces leave it absent and therefore remain fail-closed.
   */
  completeSchedulerScopeSummary?: {
    complete: true;
    piece: NormalizedFullLink;
    reads: NormalizedFullLink[];
    writes: NormalizedFullLink[];
    materializerWriteEnvelopes: NormalizedFullLink[];
    directOutputs: NormalizedFullLink[];
  };
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
    /**
     * Optional callback to ensure the handler's input docs are locally
     * available before the handler body runs. A handler reads its asCell
     * inputs (e.g. a SqliteDb handle) synchronously from the local replica;
     * the scheduler awaits this before dispatching the event so those reads
     * don't race the doc-carrying storage responses. The event is passed so
     * inputs reachable only through the event can be covered too.
     */
    presyncInputs?: (event: any) => Promise<void>;
  };
export type AnnotatedEventHandler = EventHandler & TelemetryAnnotations;

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
};

export type EventPreflightTraceContext = SchedulerEventPreflightStats & {
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

export interface TriggerTraceActionRecord {
  actionId: string;
  actionType: "effect" | "computation";
  mode: "pull";
  decision:
    | "mark-invalid"
    | "already-invalid"
    | "skip-own-commit-source"
    | "skip-same-change-group";
  pendingBefore: boolean;
  pendingAfter: boolean;
  dirtyBefore: boolean;
  dirtyAfter: boolean;
}

export interface TriggerTraceEntry {
  recordedAt: number;
  notificationType: string;
  changeIndex: number;
  matchedActionCount: number;
  mode: "pull";
  writerActionId?: string;
  space: MemorySpace;
  entityId: URI;
  path: string[];
  before: TriggerTraceValueSummary;
  after: TriggerTraceValueSummary;
  triggered: TriggerTraceActionRecord[];
}

export type QueuedEvent = {
  /** Durable event id minted at send (spec §7.5). */
  readonly id: string;
  /**
   * The wall-clock instant (ms) bound to this event, captured at its causal
   * origin: carried forward unchanged from the emitting handler's frame, or a
   * fresh reading for a renderer/root event. The dispatching handler's ambient
   * clock reads this (coarsened) instead of the live clock. See Frame.eventTime.
   */
  readonly time?: number;
  /** The transaction whose handler sent this event, when transactional. */
  readonly originTx?: IExtendedStorageTransaction;
  eventLink: NormalizedFullLink;
  action: Action;
  handler: EventHandler;
  event: any;
  /**
   * The FIFO slot was reserved before its handler's piece finished loading.
   * A loading head parks the whole event queue so later, already-registered
   * handlers cannot overtake it.
   */
  handlerLoadPending?: boolean;
  /** Internal exactly-once guard for terminal pre-dispatch drops. */
  finalOutcomeNotified?: boolean;
  /**
   * Whether a transient failure for this event should be retried. `true` routes
   * a transient commit failure through the exponential-backoff window and lets
   * the inSpace-name resolution path (RetryImmediately) re-run the handler;
   * `false` makes both drop on the first failure (a speculative lineage origin or
   * an internal one-shot opts out this way). There is no retry count: a windowed
   * commit failure is bounded by the retry window, and RetryImmediately is
   * bounded by the monotonic space-name cache (each re-run resolves at least one
   * previously-unresolved name, and a resolved name never becomes pending again).
   */
  retry: boolean;
  onCommit?: (tx: IExtendedStorageTransaction) => void;
  notBefore?: number;
  /**
   * Number of transient commit failures this intent has hit. Drives the
   * exponential backoff exponent; carried across backoff retries. Covers every
   * transient commit failure, not only conflicts.
   */
  retryAttempts?: number;
  /**
   * Wall-clock deadline (performance.now()) after which a still-failing intent
   * surfaces a terminal error instead of retrying. Set from the first transient
   * failure and carried across backoff retries.
   */
  retryDeadline?: number;
};
