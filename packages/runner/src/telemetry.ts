// RuntimeTelemetry is used throughout the runtime
// to record events that can be subscribed to in other
// contexts to visualize or log events inside the runtime.

import { IMemoryChange } from "./storage/interface.ts";
import { StorageTelemetry } from "./storage/telemetry.ts";
import type * as Inspector from "./storage/inspector.ts";

/**
 * Statistics tracked for each action's execution performance.
 */
export interface ActionStats {
  runCount: number;
  totalTime: number;
  averageTime: number;
  lastRunTime: number;
  lastRunTimestamp: number; // When the action last ran (performance.now())
}

// Types for scheduler graph visualization
export interface SchedulerGraphNode {
  id: string; // actionId or "input:space/entity" for inputs
  type: "effect" | "computation" | "input" | "inactive"; // inactive = has stats but no longer registered
  stats?: ActionStats;
  isDirty: boolean;
  isPending: boolean;
  isDemanded?: boolean;
  isLiveEffect?: boolean;
  isPullDemandRoot?: boolean;
  isConditionallyScheduled?: boolean;
  isDebouncedWaiting?: boolean;
  hasActiveDebounceTimer?: boolean;
  nextDebounceRunInMs?: number;
  nextEligibleRunInMs?: number;
  parentId?: string; // ID of parent action if this was created during parent's execution
  childCount?: number; // Number of child actions created during this action's execution
  preview?: string; // First ~200 chars of function body for hover tooltips
  // Diagnostic info: what cells this action reads and writes
  reads?: string[]; // space/entity paths this action reads
  shallowReads?: string[]; // non-recursive reads used for structural invalidation
  writes?: string[]; // space/entity paths this action writes (mightWrite)
  // Timing controls
  debounceMs?: number; // Current debounce delay in ms (if set)
  throttleMs?: number; // Current throttle period in ms (if set)
  // Pattern association: the content-addressed { identity, symbol } of the
  // pattern this action belongs to (the only pattern pointer post-patternId
  // retirement). `identity` is a module content hash; `symbol` distinguishes
  // co-located patterns of one module (the export vs hoisted sub-patterns).
  patternIdentity?: { identity: string; symbol: string };
}

export interface SchedulerGraphEdge {
  from: string; // actionId of source
  to: string; // actionId of target
  cells: string[]; // Cell IDs creating this dependency
  edgeType?: "data" | "parent"; // data = dependency, parent = parent-child relationship
}

export interface SchedulerGraphSnapshot {
  nodes: SchedulerGraphNode[];
  edges: SchedulerGraphEdge[];
  timestamp: number;
}

export interface SchedulerActionInfo {
  patternName?: string;
  moduleName?: string;
  reads?: string[];
  writes?: string[];
}

export interface SchedulerEventPreflightStats {
  visitCount: number;
  dirtyInputCount: number;
  resultTrueCount: number;
  workSetAddCount: number;
  reverseDependencyActionCount: number;
  reverseDependencyEdgeCount: number;
  logReadCount: number;
  logShallowReadCount: number;
  writerCandidateCount: number;
  writerOverlapCount: number;
  directWriterCount: number;
  hotActions?: SchedulerEventPreflightActionSummary[];
  hotFanoutActions?: SchedulerEventPreflightActionSummary[];
  rootDirectWriters?: SchedulerEventPreflightActionSummary[];
}

export interface SchedulerEventPreflightActionSummary {
  actionId: string;
  actionType: "effect" | "computation" | "unknown";
  visitCount: number;
  dirtyInputCount: number;
  resultTrueCount: number;
  reverseDependencyEdgeCount: number;
  maxDirectWriterCount: number;
  dirty: boolean;
  pending: boolean;
  readCount: number;
  shallowReadCount: number;
  writeCount: number;
}

/** Aggregate-only preflight statistics safe to transfer to a runtime host. */
export interface HostSchedulerEventPreflightStats {
  visitCount: number;
  dirtyInputCount: number;
  resultTrueCount: number;
  workSetAddCount: number;
  reverseDependencyActionCount: number;
  reverseDependencyEdgeCount: number;
  logReadCount: number;
  logShallowReadCount: number;
  writerCandidateCount: number;
  writerOverlapCount: number;
  directWriterCount: number;
  hotActionCount: number;
  hotFanoutActionCount: number;
  rootDirectWriterCount: number;
}

/** Fixed, content-free reasons an event can be dropped before dispatch. */
export type SchedulerEventDropReason =
  | "piece-load"
  | "lineage"
  | "preflight"
  | "load-gate";

// ============================================================
// Diagnosis types for non-settling / non-idempotent detection
// ============================================================

/**
 * Report for a single action detected as non-idempotent.
 * Same inputs (reads) produced different outputs (writes) across runs.
 */
export interface NonIdempotentReport {
  actionId: string;
  actionInfo?: SchedulerActionInfo;
  runs: {
    timestamp: number;
    reads: Record<string, unknown>;
    writes: Record<string, unknown>;
  }[];
  differingWriteKeys: string[];
}

/**
 * A cycle found in the causal chain of action triggers.
 * e.g. A writes cell X -> triggers B, B writes cell Y -> triggers A.
 */
export interface CycleReport {
  cycle: { actionId: string; writesCell: string }[];
  timestamp: number;
}

/**
 * Aggregated result from a diagnosis run.
 */
export interface SchedulerDiagnosisResult {
  nonIdempotent: NonIdempotentReport[];
  cycles: CycleReport[];
  duration: number;
  busyTime: number;
}

// Types of markers that can be submitted by the runtime.
export type RuntimeTelemetryMarker = {
  type: "scheduler.run";
  actionId: string;
  actionInfo?: SchedulerActionInfo;
  error?: string;
} | {
  // Emitted when an action run finishes, next to the ActionStats recording —
  // the same wall-clock measurement, surfaced as a marker so consumers (OTel
  // bridge, debugger) get per-run durations without polling getActionStats().
  type: "scheduler.run.complete";
  actionId: string;
  actionInfo?: SchedulerActionInfo;
  durationMs: number;
  error?: string;
} | {
  // Emitted once per settle pass, unconditionally (unlike SettleStats, which
  // is opt-in): the user-facing "event → stable graph" number.
  type: "scheduler.settle";
  durationMs: number;
  iterations: number;
  settledEarly: boolean;
  seedCount: number;
  workSetSize: number;
} | {
  type: "cell.update";
  change: IMemoryChange;
  error?: string;
} | {
  type: "scheduler.invocation";
  /** Internal-only correlation key. Never export this as an OTel attribute. */
  eventId: string;
  handlerId: string;
  handlerInfo?: SchedulerActionInfo;
  error?: string;
} | {
  type: "scheduler.event.commit";
  /** Internal-only correlation key. Never export this as an OTel attribute. */
  eventId: string;
  handlerId: string;
  handlerInfo?: SchedulerActionInfo;
  /** Scheduler dependency reads performed by this commit attempt. */
  readCount: number;
  /** Changed writes plus deduplicated non-overlapping no-op candidate targets. */
  writeCount: number;
  /** Paths locally changed by this attempt, including speculative failed retries. */
  changedWriteCount: number;
  /** Capped structural addresses for changed writes only. */
  writes: string[];
  writesTruncated?: boolean;
  error?: string;
  permanentRejection?: "origin-committed" | "receipt-exists";
  /** Backpressure attempt count (1-based) for a transient-conflict retry. */
  retryAttempt?: number;
  /** Backoff delay applied before the next retry, in milliseconds. */
  backoffMs?: number;
  /**
   * Set when the commit reached a terminal outcome: `permanent` for a
   * never-retried precondition failure, `convergence` for a transient conflict
   * that exhausted the retry window and surfaced a terminal error, `rule` for a
   * deterministic server-side commit-rule refusal (never retried).
   */
  terminal?: "permanent" | "convergence" | "rule";
} | {
  /** A final pre-dispatch outcome, categorized without event content. */
  type: "scheduler.event.drop";
  /** Internal-only correlation key. Never export this as an OTel attribute. */
  eventId: string;
  reason: SchedulerEventDropReason;
} | {
  type: "scheduler.event.preflight";
  handlerId: string;
  handlerInfo?: SchedulerActionInfo;
  readCount: number;
  shallowReadCount: number;
  dirtySizeBefore: number;
  pendingSizeBefore: number;
  dirtyDependencyCount: number;
  hasDirtyDependencies: boolean;
  skipped: boolean;
  populateMs: number;
  txToLogMs: number;
  depCommitMs: number;
  collectMs: number;
  scheduleMs: number;
  stats: SchedulerEventPreflightStats;
  error?: string;
} | {
  type: "storage.push.start";
  id: string;
  operation: string;
  // Client-side commit sequence + space: the join keys to the memory
  // server's `memory.transact` span (commit.local_seq / space.did attrs).
  localSeq?: number;
  spaceDid?: string;
  error?: string;
} | {
  type: "storage.push.complete";
  id: string;
  // Session is only known once the connection is established, so the
  // session-scoped join key rides the completion rather than the start.
  sessionId?: string;
  error?: string;
} | {
  type: "storage.push.error";
  id: string;
  sessionId?: string;
  error: string;
} | {
  type: "storage.pull.start";
  id: string;
  operation: string;
  error?: string;
} | {
  type: "storage.pull.complete";
  id: string;
  error?: string;
} | {
  type: "storage.pull.error";
  id: string;
  error: string;
} | {
  type: "storage.connection.update";
  status: "pending" | "ok" | "error";
  attempt: number;
  error?: string;
} | {
  type: "storage.subscription.add";
  id: string;
  error?: string;
} | {
  type: "storage.subscription.remove";
  id: string;
  error?: string;
} | {
  type: "scheduler.graph.snapshot";
  graph: SchedulerGraphSnapshot;
} | {
  type: "scheduler.subscribe";
  actionId: string;
  isEffect: boolean;
} | {
  type: "scheduler.dependencies.update";
  actionId: string;
  reads: string[]; // cell paths this action reads
  writes: string[]; // cell paths this action writes
} | {
  type: "scheduler.non-settling";
  busyTime: number;
  windowDuration: number;
  busyRatio: number;
};

export type RuntimeTelemetryMarkerResult = RuntimeTelemetryMarker & {
  timeStamp: number;
};

/** Telemetry marker safe to transfer from a runtime worker to its host. */
export type HostRuntimeTelemetryMarker =
  | { type: "scheduler.run"; timeStamp: number; ok: boolean }
  | {
    type: "scheduler.run.complete";
    timeStamp: number;
    durationMs: number;
    ok: boolean;
  }
  | {
    type: "scheduler.settle";
    timeStamp: number;
    durationMs: number;
    iterations: number;
    settledEarly: boolean;
    seedCount: number;
    workSetSize: number;
  }
  | { type: "cell.update"; timeStamp: number }
  | { type: "scheduler.invocation"; timeStamp: number; ok: boolean }
  | {
    type: "scheduler.event.commit";
    timeStamp: number;
    readCount: number;
    writeCount: number;
    changedWriteCount: number;
    ok: boolean;
    permanentRejection?: "origin-committed" | "receipt-exists";
    retryAttempt?: number;
    backoffMs?: number;
    terminal?: "permanent" | "convergence" | "rule";
  }
  | {
    type: "scheduler.event.drop";
    timeStamp: number;
    reason: SchedulerEventDropReason;
  }
  | {
    type: "scheduler.event.preflight";
    timeStamp: number;
    readCount: number;
    shallowReadCount: number;
    dirtySizeBefore: number;
    pendingSizeBefore: number;
    dirtyDependencyCount: number;
    hasDirtyDependencies: boolean;
    skipped: boolean;
    populateMs: number;
    txToLogMs: number;
    depCommitMs: number;
    collectMs: number;
    scheduleMs: number;
    stats: HostSchedulerEventPreflightStats;
    ok: boolean;
  }
  | { type: "storage.push.start"; timeStamp: number; ok: boolean }
  | { type: "storage.push.complete"; timeStamp: number; ok: boolean }
  | { type: "storage.push.error"; timeStamp: number; ok: false }
  | { type: "storage.pull.start"; timeStamp: number; ok: boolean }
  | { type: "storage.pull.complete"; timeStamp: number; ok: boolean }
  | { type: "storage.pull.error"; timeStamp: number; ok: false }
  | {
    type: "storage.connection.update";
    timeStamp: number;
    status: "pending" | "ok" | "error";
    attempt: number;
    ok: boolean;
  }
  | { type: "storage.subscription.add"; timeStamp: number; ok: boolean }
  | { type: "storage.subscription.remove"; timeStamp: number; ok: boolean }
  | {
    type: "scheduler.graph.snapshot";
    timeStamp: number;
    nodeCount: number;
    edgeCount: number;
  }
  | { type: "scheduler.subscribe"; timeStamp: number; isEffect: boolean }
  | {
    type: "scheduler.dependencies.update";
    timeStamp: number;
    readCount: number;
    writeCount: number;
  }
  | {
    type: "scheduler.non-settling";
    timeStamp: number;
    busyTime: number;
    windowDuration: number;
    busyRatio: number;
  };

export class RuntimeTelemetryEvent
  extends CustomEvent<{ marker: RuntimeTelemetryMarker }> {
  readonly marker: RuntimeTelemetryMarkerResult;

  constructor(marker: RuntimeTelemetryMarker) {
    super("telemetry", {
      detail: {
        marker,
      },
    });
    this.marker = { ...marker, timeStamp: this.timeStamp };
  }
}

export class RuntimeTelemetry extends EventTarget {
  #storageTelemetry: StorageTelemetry;
  #detailedEventCommitTelemetryLeases = 0;

  constructor() {
    super();
    this.#storageTelemetry = new StorageTelemetry(this);
  }

  submit(marker: RuntimeTelemetryMarker) {
    this.dispatchEvent(new RuntimeTelemetryEvent(marker));
  }

  /** Whether a consumer has requested detailed event-commit telemetry. */
  get detailedEventCommitTelemetryEnabled(): boolean {
    return this.#detailedEventCommitTelemetryLeases > 0;
  }

  /**
   * Request detailed event-commit telemetry until the returned release function
   * is called. Releases are idempotent so independent consumers cannot disable
   * each other's demand.
   */
  retainDetailedEventCommitTelemetry(): () => void {
    this.#detailedEventCommitTelemetryLeases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#detailedEventCommitTelemetryLeases--;
    };
  }

  processInspectorCommand(command: Inspector.BroadcastCommand) {
    this.#storageTelemetry.processCommand(command);
  }
}
