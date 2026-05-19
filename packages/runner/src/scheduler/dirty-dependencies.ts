import { getLogger } from "@commonfabric/utils/logger";
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
import type {
  Action,
  DirtyDependencyTraceContext,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export interface DirtyDependencyCollectionState {
  readonly collectStack: Set<Action>;
  readonly getTrace: () => DirtyDependencyTraceContext | undefined;
  readonly dirty: ReadonlySet<Action>;
  readonly pending: ReadonlySet<Action>;
  readonly computations: ReadonlySet<Action>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
  readonly materializerIndex: MaterializerIndexState;
  readonly isStale: (action: Action) => boolean;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getActionId: (action: Action) => string;
}

/**
 * Collects computations that must run before `action` can observe up-to-date
 * values. This includes explicitly dirty computations and clean intermediates
 * whose own inputs flow from dirty upstream computations.
 *
 * Returns whether `action` itself is stale with respect to the current dirty
 * set.
 */
export function collectDirtyDependencies(
  state: DirtyDependencyCollectionState,
  action: Action,
  workSet: Set<Action>,
  memo = new Map<Action, boolean>(),
): boolean {
  const collectStart = performance.now();
  let addedToStack = false;
  const trace = state.getTrace();

  try {
    if (trace) {
      trace.visitCount++;
      trace.maxDepth = Math.max(trace.maxDepth, trace.depth);
      const actionSummary = getTraceActionSummary(state, trace, action);
      actionSummary.visitCount++;
      if (state.dirty.has(action)) {
        trace.dirtyInputCount++;
        actionSummary.dirtyInputCount++;
      }
    }

    const cached = memo.get(action);
    if (cached !== undefined) {
      if (trace) {
        trace.memoHitCount++;
        getTraceActionSummary(state, trace, action).memoHitCount++;
      }
      if (cached && state.dirty.has(action) && state.computations.has(action)) {
        if (!workSet.has(action) && trace) trace.workSetAddCount++;
        workSet.add(action);
      }
      return cached;
    }

    if (!state.isStale(action)) {
      memo.set(action, false);
      return false;
    }

    if (state.collectStack.has(action)) {
      if (trace) trace.cycleHitCount++;
      const cycleResult = state.isStale(action) || workSet.has(action);
      memo.set(action, cycleResult);
      return cycleResult;
    }

    state.collectStack.add(action);
    addedToStack = true;

    let actionNeedsRun = state.isStale(action);
    const directWriters = collectDirectWritersForAction(state, action);
    if (directWriters.usedLogFallback && trace) trace.logFallbackCount++;
    if (directWriters.writers.size > 0) {
      recordReverseDependencyTrace(state, action, directWriters.writers);
    }
    for (const writer of directWriters.writers) {
      if (!state.isStale(writer)) {
        memo.set(writer, false);
        continue;
      }
      if (trace) trace.depth++;
      let writerNeedsRun: boolean;
      try {
        writerNeedsRun = collectDirtyDependencies(
          state,
          writer,
          workSet,
          memo,
        );
      } finally {
        if (trace) trace.depth--;
      }
      if (writerNeedsRun) {
        actionNeedsRun = true;
      }
    }

    if (state.dirty.has(action) && state.computations.has(action)) {
      if (!workSet.has(action) && trace) trace.workSetAddCount++;
      workSet.add(action);
    }

    if (actionNeedsRun && trace) {
      trace.resultTrueCount++;
      getTraceActionSummary(state, trace, action).resultTrueCount++;
    }
    memo.set(action, actionNeedsRun);
    return actionNeedsRun;
  } finally {
    if (addedToStack) {
      state.collectStack.delete(action);
    }
    logger.time(
      collectStart,
      "scheduler",
      "execute",
      "collectDirtyDependencies",
    );
  }
}

function collectDirectWritersForAction(
  state: DirtyDependencyCollectionState,
  action: Action,
): { writers: Set<Action>; usedLogFallback: boolean } {
  const writers = new Set(state.reverseDependencies.get(action) ?? []);
  const log = state.dependencies.get(action);
  let usedLogFallback = false;

  if (writers.size === 0 && log) {
    usedLogFallback = true;
    for (
      const writer of collectDirectWritersForLog({
        writersByEntity: state.writersByEntity,
        effects: state.effects,
        getSchedulingWrites: state.getSchedulingWrites,
        trace: state.getTrace(),
      }, log)
    ) {
      writers.add(writer);
    }
  }

  if (log) {
    for (
      const materializer of collectMaterializerWritersForLog(
        state.materializerIndex,
        log,
        { exclude: action },
      )
    ) {
      writers.add(materializer);
    }
  }

  return { writers, usedLogFallback };
}

function recordReverseDependencyTrace(
  state: DirtyDependencyCollectionState,
  action: Action,
  directWriters: Set<Action>,
): void {
  const trace = state.getTrace();
  if (!trace) return;

  trace.reverseDependencyActionCount++;
  trace.reverseDependencyEdgeCount += directWriters.size;
  const actionSummary = getTraceActionSummary(state, trace, action);
  actionSummary.reverseDependencyEdgeCount += directWriters.size;
  actionSummary.maxDirectWriterCount = Math.max(
    actionSummary.maxDirectWriterCount,
    directWriters.size,
  );
}

export function collectDirtyDependenciesForLog(
  state: DirtyDependencyCollectionState,
  log: ReactivityLog,
  workSet: Set<Action>,
  memo = new Map<Action, boolean>(),
): boolean {
  const lookupStart = performance.now();
  const trace = state.getTrace();
  let directWriters: Set<Action>;
  try {
    directWriters = collectDirectWritersForLog({
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
  } finally {
    logger.time(
      lookupStart,
      "scheduler",
      "execute",
      "collectDirtyDependencies",
      "writerLookup",
    );
  }

  if (trace) trace.directWriterCount += directWriters.size;
  if (trace && trace.depth === 0) {
    for (const writer of directWriters) {
      trace.rootDirectWriterActions.add(writer);
      getTraceActionSummary(state, trace, writer);
    }
  }

  let hasDirtyDependencies = false;
  for (const writer of directWriters) {
    if (!state.isStale(writer)) {
      memo.set(writer, false);
      continue;
    }

    if (trace) trace.depth++;
    let writerNeedsRun: boolean;
    try {
      writerNeedsRun = collectDirtyDependencies(
        state,
        writer,
        workSet,
        memo,
      );
    } finally {
      if (trace) trace.depth--;
    }
    if (writerNeedsRun) {
      hasDirtyDependencies = true;
      if (state.dirty.has(writer) && state.computations.has(writer)) {
        if (!workSet.has(writer) && trace) trace.workSetAddCount++;
        workSet.add(writer);
      }
    }
  }

  return hasDirtyDependencies;
}

export function snapshotDirtyDependencyTraceContext(
  state: DirtyDependencyCollectionState,
  context: DirtyDependencyTraceContext,
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

function getTraceActionSummary(
  state: DirtyDependencyCollectionState,
  trace: DirtyDependencyTraceContext,
  action: Action,
): SchedulerEventPreflightActionSummary {
  let summary = trace.actionSummaries.get(action);
  if (!summary) {
    const log = state.dependencies.get(action);
    const writes = state.getSchedulingWrites(action) ?? [];
    summary = {
      actionId: state.getActionId(action),
      actionType: state.effects.has(action)
        ? "effect"
        : state.computations.has(action)
        ? "computation"
        : "unknown",
      visitCount: 0,
      memoHitCount: 0,
      dirtyInputCount: 0,
      resultTrueCount: 0,
      reverseDependencyEdgeCount: 0,
      maxDirectWriterCount: 0,
      dirty: state.dirty.has(action),
      pending: state.pending.has(action),
      readCount: log?.reads.length ?? 0,
      shallowReadCount: log?.shallowReads.length ?? 0,
      writeCount: writes.length,
    };
    trace.actionSummaries.set(action, summary);
  } else {
    summary.dirty ||= state.dirty.has(action);
    summary.pending ||= state.pending.has(action);
  }
  return summary;
}
