import { getLogger } from "@commonfabric/utils/logger";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { SchedulerEventPreflightActionSummary } from "../telemetry.ts";
import { collectDirectWritersForLog } from "./dependency-index.ts";
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
  readonly trace?: DirtyDependencyTraceContext;
  readonly dirty: ReadonlySet<Action>;
  readonly computations: ReadonlySet<Action>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
  readonly isStale: (action: Action) => boolean;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getTraceActionSummary: (
    trace: DirtyDependencyTraceContext,
    action: Action,
  ) => SchedulerEventPreflightActionSummary;
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
  const trace = state.trace;

  try {
    if (trace) {
      trace.visitCount++;
      trace.maxDepth = Math.max(trace.maxDepth, trace.depth);
      const actionSummary = state.getTraceActionSummary(trace, action);
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
        state.getTraceActionSummary(trace, action).memoHitCount++;
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
    const directWriters = state.reverseDependencies.get(action);
    if (directWriters) {
      recordReverseDependencyTrace(state, action, directWriters);
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
          actionNeedsRun = true;
        }
      }
    } else {
      if (trace) trace.logFallbackCount++;
      const log = state.dependencies.get(action);
      if (log) {
        if (collectDirtyDependenciesForLog(state, log, workSet, memo)) {
          actionNeedsRun = true;
        }
      }
    }

    if (state.dirty.has(action) && state.computations.has(action)) {
      if (!workSet.has(action) && trace) trace.workSetAddCount++;
      workSet.add(action);
    }

    if (actionNeedsRun && trace) {
      trace.resultTrueCount++;
      state.getTraceActionSummary(trace, action).resultTrueCount++;
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

function recordReverseDependencyTrace(
  state: DirtyDependencyCollectionState,
  action: Action,
  directWriters: Set<Action>,
): void {
  const trace = state.trace;
  if (!trace) return;

  trace.reverseDependencyActionCount++;
  trace.reverseDependencyEdgeCount += directWriters.size;
  const actionSummary = state.getTraceActionSummary(trace, action);
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
  const trace = state.trace;
  let directWriters: Set<Action>;
  try {
    directWriters = collectDirectWritersForLog({
      writersByEntity: state.writersByEntity,
      effects: state.effects,
      getSchedulingWrites: state.getSchedulingWrites,
      trace,
    }, log);
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
      state.getTraceActionSummary(trace, writer);
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
