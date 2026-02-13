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
  parentId?: string; // ID of parent action if this was created during parent's execution
  childCount?: number; // Number of child actions created during this action's execution
  preview?: string; // First ~200 chars of function body for hover tooltips
  // Diagnostic info: what cells this action reads and writes
  reads?: string[]; // space/entity paths this action reads
  writes?: string[]; // space/entity paths this action writes (mightWrite)
  // Timing controls
  debounceMs?: number; // Current debounce delay in ms (if set)
  throttleMs?: number; // Current throttle period in ms (if set)
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
  type: "scheduler.mode.change";
  pullMode: boolean;
} | {
  type: "scheduler.subscribe";
  actionId: string;
  isEffect: boolean;
} | {
  type: "scheduler.dependencies.update";
  actionId: string;
  reads: string[]; // cell paths this action reads
  writes: string[]; // cell paths this action writes
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
