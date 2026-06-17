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
  pullMode: boolean;
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
  memoHitCount: number;
  cycleHitCount: number;
  dirtyInputCount: number;
  resultTrueCount: number;
  workSetAddCount: number;
  reverseDependencyActionCount: number;
  reverseDependencyEdgeCount: number;
  logFallbackCount: number;
  logReadCount: number;
  logShallowReadCount: number;
  writerCandidateCount: number;
  writerOverlapCount: number;
  directWriterCount: number;
  maxDepth: number;
  hotActions?: SchedulerEventPreflightActionSummary[];
  hotFanoutActions?: SchedulerEventPreflightActionSummary[];
  rootDirectWriters?: SchedulerEventPreflightActionSummary[];
}

export interface SchedulerEventPreflightActionSummary {
  actionId: string;
  actionType: "effect" | "computation" | "unknown";
  visitCount: number;
  memoHitCount: number;
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
  error?: string;
} | {
  type: "storage.push.complete";
  id: string;
  error?: string;
} | {
  type: "storage.push.error";
  id: string;
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

  constructor() {
    super();
    this.#storageTelemetry = new StorageTelemetry(this);
  }

  submit(marker: RuntimeTelemetryMarker) {
    this.dispatchEvent(new RuntimeTelemetryEvent(marker));
  }

  processInspectorCommand(command: Inspector.BroadcastCommand) {
    this.#storageTelemetry.processCommand(command);
  }
}
