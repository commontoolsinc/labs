import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type {
  SchedulerEventPreflightActionSummary,
  SchedulerEventPreflightStats,
} from "../telemetry.ts";
import { collectDirectWritersForLog } from "./dependency-graph.ts";
import {
  collectMaterializerWritersForLog,
  type MaterializerIndexState,
} from "./materializers.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import type {
  Action,
  EventPreflightTraceContext,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

export interface EventPreflightDependencyState {
  readonly getTrace: () => EventPreflightTraceContext | undefined;
  readonly nodes: NodeRegistry;
  readonly pending: ReadonlySet<Action>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
  readonly materializerIndex: MaterializerIndexState;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getActionId: (action: Action) => string;
}

export function collectInvalidUpstreamForLog(
  state: EventPreflightDependencyState,
  log: ReactivityLog,
  workSet: Set<Action>,
): boolean {
  const trace = state.getTrace();
  const directWriters = collectDirectWritersForLog({
    writersByEntity: state.writersByEntity,
    effects: state.effects,
    getSchedulingWrites: state.getSchedulingWrites,
    trace,
  }, log);
  for (
    const materializer of collectMaterializerWritersForLog(
      state.materializerIndex,
      log,
    )
  ) {
    directWriters.add(materializer);
  }

  if (trace) {
    trace.directWriterCount += directWriters.size;
    for (const writer of directWriters) {
      trace.rootDirectWriterActions.add(writer);
      getTraceActionSummary(state, trace, writer);
    }
  }

  let hasInvalidUpstream = false;
  const visiting = new Set<Action>();
  const visited = new Set<Action>();
  for (const writer of directWriters) {
    if (visitInvalidUpstream(state, writer, workSet, visiting, visited)) {
      hasInvalidUpstream = true;
    }
  }
  return hasInvalidUpstream;
}

function visitInvalidUpstream(
  state: EventPreflightDependencyState,
  action: Action,
  workSet: Set<Action>,
  visiting: Set<Action>,
  visited: Set<Action>,
): boolean {
  const trace = state.getTrace();
  if (trace) {
    trace.visitCount++;
    trace.maxDepth = Math.max(trace.maxDepth, trace.depth);
    const actionSummary = getTraceActionSummary(state, trace, action);
    actionSummary.visitCount++;
    if (isInvalidNode(state.nodes.get(action))) {
      trace.dirtyInputCount++;
      actionSummary.dirtyInputCount++;
    }
  }

  if (visited.has(action)) {
    if (trace) {
      trace.memoHitCount++;
      getTraceActionSummary(state, trace, action).memoHitCount++;
    }
    return workSet.has(action);
  }

  if (visiting.has(action)) {
    if (trace) trace.cycleHitCount++;
    return workSet.has(action);
  }

  visiting.add(action);
  let hasInvalidUpstream = false;
  if (isInvalidNode(state.nodes.get(action))) {
    hasInvalidUpstream = true;
    if (!workSet.has(action) && trace) trace.workSetAddCount++;
    workSet.add(action);
  }

  const upstreamWriters = collectUpstreamWriters(state, action);
  if (upstreamWriters.size > 0 && trace) {
    recordReverseDependencyTrace(state, trace, action, upstreamWriters);
  }
  for (const writer of upstreamWriters) {
    if (trace) trace.depth++;
    try {
      if (visitInvalidUpstream(state, writer, workSet, visiting, visited)) {
        hasInvalidUpstream = true;
      }
    } finally {
      if (trace) trace.depth--;
    }
  }

  visiting.delete(action);
  visited.add(action);
  if (hasInvalidUpstream && trace) {
    trace.resultTrueCount++;
    getTraceActionSummary(state, trace, action).resultTrueCount++;
  }
  return hasInvalidUpstream;
}

function collectUpstreamWriters(
  state: EventPreflightDependencyState,
  action: Action,
): Set<Action> {
  const writers = new Set(state.reverseDependencies.get(action) ?? []);
  const log = state.dependencies.get(action);
  if (!log) return writers;

  for (
    const materializer of collectMaterializerWritersForLog(
      state.materializerIndex,
      log,
      { exclude: action },
    )
  ) {
    writers.add(materializer);
  }
  return writers;
}

function isInvalidNode(record: SchedulerNode | undefined): boolean {
  return record?.status === "invalid" || record?.status === "never-ran";
}

export function snapshotEventPreflightTraceContext(
  state: EventPreflightDependencyState,
  context: EventPreflightTraceContext,
): SchedulerEventPreflightStats {
  const {
    depth: _depth,
    actionSummaries,
    rootDirectWriterActions,
    ...stats
  } = context;
  const actionRows = [...actionSummaries.values()];
  const topBy = (
    rows: SchedulerEventPreflightActionSummary[],
    key: "visitCount" | "reverseDependencyEdgeCount",
  ) =>
    rows
      .filter((row) => row[key] > 0)
      .sort((a, b) =>
        b[key] - a[key] ||
        b.visitCount - a.visitCount ||
        a.actionId.localeCompare(b.actionId)
      )
      .slice(0, 12);

  const rootDirectWriterRows = [...rootDirectWriterActions].map((action) =>
    getTraceActionSummary(state, context, action)
  );

  return {
    ...stats,
    hotActions: topBy(actionRows, "visitCount"),
    hotFanoutActions: topBy(actionRows, "reverseDependencyEdgeCount"),
    rootDirectWriters: topBy(rootDirectWriterRows, "visitCount"),
  };
}

function recordReverseDependencyTrace(
  state: EventPreflightDependencyState,
  trace: EventPreflightTraceContext,
  action: Action,
  directWriters: Set<Action>,
): void {
  trace.reverseDependencyActionCount++;
  trace.reverseDependencyEdgeCount += directWriters.size;
  const actionSummary = getTraceActionSummary(state, trace, action);
  actionSummary.reverseDependencyEdgeCount += directWriters.size;
  actionSummary.maxDirectWriterCount = Math.max(
    actionSummary.maxDirectWriterCount,
    directWriters.size,
  );
}

function getTraceActionSummary(
  state: EventPreflightDependencyState,
  trace: EventPreflightTraceContext,
  action: Action,
): SchedulerEventPreflightActionSummary {
  let summary = trace.actionSummaries.get(action);
  if (!summary) {
    const log = state.dependencies.get(action);
    summary = {
      actionId: state.getActionId(action),
      actionType: state.effects.has(action)
        ? "effect"
        : state.nodes.isComputation(action)
        ? "computation"
        : "unknown",
      visitCount: 0,
      memoHitCount: 0,
      dirtyInputCount: 0,
      resultTrueCount: 0,
      reverseDependencyEdgeCount: 0,
      maxDirectWriterCount: 0,
      dirty: isInvalidNode(state.nodes.get(action)),
      pending: state.pending.has(action),
      readCount: log?.reads.length ?? 0,
      shallowReadCount: log?.shallowReads.length ?? 0,
      writeCount: state.getSchedulingWrites(action)?.length ?? 0,
    };
    trace.actionSummaries.set(action, summary);
  }
  return summary;
}
