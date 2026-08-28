// RuntimeTelemetry is used throughout the runtime
// to record events that can be subscribed to in other
// contexts to visualize or log events inside the runtime.

import type { CfcRefusalDetail } from "./cfc/refusal-detail.ts";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

import { IMemoryChange } from "./storage/interface.ts";

/**
 * Statistics tracked for each action's execution performance.
 */
export type ActionStats = {
  runCount: number;
  totalTime: number;
  averageTime: number;
  lastRunTime: number;
  lastRunTimestamp: number; // When the action last ran (performance.now())
};

// Types for scheduler graph visualization
export type SchedulerGraphNode = {
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
};

export type SchedulerGraphEdge = {
  from: string; // actionId of source
  to: string; // actionId of target
  cells: string[]; // Cell IDs creating this dependency
  edgeType?: "data" | "parent"; // data = dependency, parent = parent-child relationship
};

export type SchedulerGraphSnapshot = {
  nodes: SchedulerGraphNode[];
  edges: SchedulerGraphEdge[];
  timestamp: number;
};

export type SchedulerActionInfo = {
  patternName?: string;
  moduleName?: string;
  reads?: string[];
  writes?: string[];
};

export type SchedulerEventPreflightStats = {
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
};

export type SchedulerEventPreflightActionSummary = {
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
};

//
// Diagnosis types for non-settling / non-idempotent detection
//

/**
 * Report for a single action detected as non-idempotent.
 * Same inputs (reads) produced different outputs (writes) across runs.
 */
export type NonIdempotentReport = {
  actionId: string;
  actionInfo?: SchedulerActionInfo;
  runs: {
    timestamp: number;
    reads: Record<string, FabricValue>;
    writes: Record<string, FabricValue>;
  }[];
  differingWriteKeys: string[];
};

/**
 * A cycle found in the causal chain of action triggers.
 * e.g. A writes cell X -> triggers B, B writes cell Y -> triggers A.
 */
export type CycleReport = {
  cycle: { actionId: string; writesCell: string }[];
  timestamp: number;
};

/**
 * Aggregated result from a diagnosis run.
 */
export type SchedulerDiagnosisResult = {
  nonIdempotent: NonIdempotentReport[];
  cycles: CycleReport[];
  duration: number;
  busyTime: number;
};

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
  handlerId: string;
  handlerInfo?: SchedulerActionInfo;
  error?: string;
} | {
  type: "scheduler.event.commit";
  handlerId: string;
  handlerInfo?: SchedulerActionInfo;
  readCount: number;
  writeCount: number;
  changedWriteCount: number;
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
  // Emitted for every settle episode whose convergence budget deferred work,
  // and for a busy window that crosses the wall-clock heuristic. The deferred
  // fields are present on the convergence-budget path and describe the
  // actions the pass held back. A wave that converges over several passes
  // exhausts a budget too, so a marker reports a bounded pass rather than a
  // graph that will never settle.
  type: "scheduler.non-settling";
  busyTime: number;
  windowDuration: number;
  busyRatio: number;
  deferredActions?: NonSettlingDeferredAction[];
  deferredActionCount?: number;
} | {
  // Emitted every time CFC prepare refuses a transaction, BEFORE the commit
  // boundary decides what that refusal is worth. That ordering is the point:
  // a refusal is terminal — and reaches the scheduler's error channel — only
  // when every reason is a verdict (cfc/verdict-reason.ts), so a refusal
  // mixing a verdict with an unevaluable input is retried instead, and the
  // only trace it leaves upstream is a graph that stops converging. This
  // marker is the trace it leaves either way, so a host can name the cause of
  // a non-settling episode rather than guess at a reactive cycle.
  //
  // It reports; it decides nothing. `terminal` says which arm the commit
  // boundary will take, so a consumer can tell the refusal that will also
  // arrive on the error channel from the one that will not.
  type: "cfc.prepare-reject";
  reasons: string[];
  refusals: CfcRefusalDetail[];
  terminal: boolean;
};

/**
 * One deferred action in a non-settling marker. `label` is the action's
 * display identity — `cf:module/<identity>:<symbol>:<key>` for pattern
 * actions, `raw:<builtin>:<key>` for builtins, which names no piece.
 * `pieceId`/`space` carry the action's scheduler observation identity when it
 * has one: the id of the result cell whose piece the action serves, which is
 * the attribution a builtin's label cannot provide.
 */
export type NonSettlingDeferredAction = {
  label: string;
  pieceId?: string;
  space?: string;
};

export type RuntimeTelemetryMarkerResult = RuntimeTelemetryMarker & {
  timeStamp: number;
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
  submit(marker: RuntimeTelemetryMarker) {
    this.dispatchEvent(new RuntimeTelemetryEvent(marker));
  }
}
