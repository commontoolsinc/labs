import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import { toMemorySpaceAddress } from "../link-utils.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import {
  backfillDependentsForNewWrites,
  type DependencyGraphState,
  pruneDependentsForCurrentWrites,
} from "./dependency-graph.ts";
import { filterIgnoredAddresses } from "./reactivity.ts";
import {
  buildKnownSchedulingWrites,
  diffSchedulingWrites,
  pruneStructuralAncestorWrites,
  type SchedulerWriteIndex,
} from "./scheduling-writes.ts";
import type { Action, ReactivityLog, TelemetryAnnotations } from "./types.ts";

export interface DependencyUpdateState {
  readonly writeIndex: SchedulerWriteIndex;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly dependencyGraph: DependencyGraphState;
  readonly isPullMode: () => boolean;
}

export function setSchedulerDependencies(
  state: DependencyUpdateState,
  action: Action,
  log: ReactivityLog,
): {
  reads: IMemorySpaceAddress[];
  shallowReads: IMemorySpaceAddress[];
  log: ReactivityLog;
} {
  const reads = sortAndCompactPaths(log.reads);
  const shallowReads = sortAndCompactPaths(log.shallowReads, false);
  const ignoredSchedulingWrites =
    (action as Partial<TelemetryAnnotations>).ignoredSchedulingWrites ?? [];
  const writes = pruneStructuralAncestorWrites(
    sortAndCompactPaths(
      filterIgnoredAddresses(log.writes, ignoredSchedulingWrites),
      false,
    ),
  );
  const potentialWrites = sortAndCompactPaths(
    filterIgnoredAddresses(log.potentialWrites, ignoredSchedulingWrites),
  );
  const declaredWrites = sortAndCompactPaths(
    filterIgnoredAddresses(
      ((action as Partial<TelemetryAnnotations>).writes ?? []).map(
        toMemorySpaceAddress,
      ),
      ignoredSchedulingWrites,
    ),
  );
  const schedulingLog: ReactivityLog = {
    reads,
    shallowReads,
    writes,
    ...(potentialWrites.length > 0 ? { potentialWrites } : {}),
  };
  state.dependencies.set(action, schedulingLog);

  // Rebuild the current scheduling view from the latest writes plus
  // declared/potential writes. Keep the cumulative legacy union separately
  // so it can be enabled behind an experimental flag.
  const rawExistingCurrentWrites =
    state.writeIndex.currentKnownWrites.get(action) ?? [];
  const existingCurrentWrites = filterIgnoredAddresses(
    rawExistingCurrentWrites,
    ignoredSchedulingWrites,
  );
  const existingHistoricalWrites = filterIgnoredAddresses(
    state.writeIndex.historicalMightWrite.get(action) ?? [],
    ignoredSchedulingWrites,
  );
  const { newCurrentKnownWrites, newHistoricalMightWrite } =
    buildKnownSchedulingWrites({
      writes,
      potentialWrites,
      declaredWrites,
      existingCurrentWrites,
      existingHistoricalWrites,
    });
  state.writeIndex.currentKnownWrites.set(action, newCurrentKnownWrites);
  state.writeIndex.historicalMightWrite.set(action, newHistoricalMightWrite);

  const previousSchedulingWrites = state.writeIndex.useHistoricalMightWrite()
    ? existingHistoricalWrites
    : existingCurrentWrites;
  const nextSchedulingWrites = state.writeIndex.useHistoricalMightWrite()
    ? newHistoricalMightWrite
    : newCurrentKnownWrites;

  const { addedWrites, removedWrites } = diffSchedulingWrites(
    previousSchedulingWrites,
    nextSchedulingWrites,
  );

  state.writeIndex.updateWriterIndex(action, nextSchedulingWrites);

  if (removedWrites.length > 0) {
    pruneDependentsForCurrentWrites(
      state.dependencyGraph,
      action,
      nextSchedulingWrites,
    );
  }

  if (state.isPullMode() && addedWrites.length > 0) {
    // Backfill reverse edges when new writers appear after readers are already subscribed.
    backfillDependentsForNewWrites(
      state.dependencyGraph,
      action,
      addedWrites,
    );
  }

  return { reads, shallowReads, log: schedulingLog };
}
