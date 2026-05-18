import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { entityKey } from "./keys.ts";
import { readsOverlapWrites } from "./scheduling-writes.ts";
import type { SchedulerStaleness } from "./staleness.ts";
import type { TriggerIndexState } from "./trigger-index.ts";
import type {
  Action,
  DirtyDependencyTraceContext,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

export interface DependencyGraphState {
  readonly triggerIndex: TriggerIndexState;
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  readonly staleness: SchedulerStaleness;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly isStale: (action: Action) => boolean;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly queueExecution: () => void;
}

export function groupReadsByEntity(
  reads: readonly IMemorySpaceAddress[],
): Map<SpaceScopeAndURI, IMemorySpaceAddress[]> {
  const readsByEntity = new Map<SpaceScopeAndURI, IMemorySpaceAddress[]>();
  for (const read of reads) {
    const entity = entityKey(read);
    let entityReads = readsByEntity.get(entity);
    if (!entityReads) {
      entityReads = [];
      readsByEntity.set(entity, entityReads);
    }
    entityReads.push(read);
  }
  return readsByEntity;
}

export function collectDirectWritersForLog(state: {
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly trace?: DirtyDependencyTraceContext;
}, log: ReactivityLog): Set<Action> {
  const directWriters = new Set<Action>();
  if (state.trace) {
    state.trace.logReadCount += log.reads.length;
    state.trace.logShallowReadCount += log.shallowReads.length;
  }

  for (const read of log.reads) {
    const entity = entityKey(read);
    const writers = state.writersByEntity.get(entity);
    if (!writers) continue;

    for (const writer of writers) {
      if (state.effects.has(writer)) continue;
      if (state.trace) state.trace.writerCandidateCount++;
      const writes = state.getSchedulingWrites(writer) ?? [];
      if (readsOverlapWrites([read], [], writes)) {
        if (state.trace && !directWriters.has(writer)) {
          state.trace.writerOverlapCount++;
        }
        directWriters.add(writer);
      }
    }
  }

  for (const read of log.shallowReads) {
    const entity = entityKey(read);
    const writers = state.writersByEntity.get(entity);
    if (!writers) continue;

    for (const writer of writers) {
      if (state.effects.has(writer)) continue;
      if (state.trace) state.trace.writerCandidateCount++;
      const writes = state.getSchedulingWrites(writer) ?? [];
      if (readsOverlapWrites([], [read], writes)) {
        if (state.trace && !directWriters.has(writer)) {
          state.trace.writerOverlapCount++;
        }
        directWriters.add(writer);
      }
    }
  }

  return directWriters;
}

export function collectReverseDependenciesForLog(
  state: {
    readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
    readonly getSchedulingWrites: (
      action: Action,
    ) => readonly IMemorySpaceAddress[] | undefined;
  },
  action: Action,
  log: ReactivityLog,
): Set<Action> {
  const dependencies = new Set<Action>();

  // Group reads by entity for efficient writer lookups.
  const readsByEntity = groupReadsByEntity(log.reads);
  const nonRecursiveByEntity = groupReadsByEntity(log.shallowReads);
  const allEntities = new Set([
    ...readsByEntity.keys(),
    ...nonRecursiveByEntity.keys(),
  ]);

  // For each entity we read from, find actions that write to it.
  for (const entity of allEntities) {
    const writers = state.writersByEntity.get(entity);
    if (!writers) continue;

    const entityReads = readsByEntity.get(entity) ?? [];
    const entityNonRecursiveReads = nonRecursiveByEntity.get(entity) ?? [];

    for (const otherAction of writers) {
      if (otherAction === action) continue;
      if (dependencies.has(otherAction)) continue;

      const otherWrites = state.getSchedulingWrites(otherAction) ?? [];
      if (
        readsOverlapWrites(
          entityReads,
          entityNonRecursiveReads,
          otherWrites,
        )
      ) {
        dependencies.add(otherAction);
      }
    }
  }

  return dependencies;
}

export function updateDependentEdgesForLog(
  state: DependencyGraphState,
  action: Action,
  log: ReactivityLog,
): void {
  const previousDependencies = state.reverseDependencies.get(action);
  if (previousDependencies) {
    for (const dependency of [...previousDependencies]) {
      unregisterDependentEdge(state, dependency, action);
    }
    state.reverseDependencies.delete(action);
  }

  const newDependencies = collectReverseDependenciesForLog(
    state,
    action,
    log,
  );

  for (const dependency of newDependencies) {
    registerDependentEdge(state, dependency, action);
  }

  state.reverseDependencies.set(action, newDependencies);
}

export function registerDependentEdge(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
): void {
  if (writer === dependent) return;

  let dependents = state.dependents.get(writer);
  if (!dependents) {
    dependents = new Set();
    state.dependents.set(writer, dependents);
  }
  const alreadyDependent = dependents.has(dependent);
  dependents.add(dependent);

  let reverse = state.reverseDependencies.get(dependent);
  if (!reverse) {
    reverse = new Set();
    state.reverseDependencies.set(dependent, reverse);
  }
  reverse.add(writer);

  if (!alreadyDependent && state.isStale(writer)) {
    state.staleness.addStaleUpstream(writer, dependent);
    if (state.isDemandedPullComputation(writer)) {
      state.queueExecution();
    }
  }
}

export function unregisterDependentEdge(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
): void {
  const dependents = state.dependents.get(writer);
  const hadDependent = dependents?.delete(dependent) ?? false;
  if (dependents && dependents.size === 0) {
    state.dependents.delete(writer);
  }

  const reverse = state.reverseDependencies.get(dependent);
  reverse?.delete(writer);
  if (reverse && reverse.size === 0) {
    state.reverseDependencies.delete(dependent);
  }

  if (hadDependent) {
    state.staleness.removeStaleUpstream(writer, dependent);
  }
}

export function backfillDependentsForNewWrites(
  state: DependencyGraphState,
  writer: Action,
  writes: readonly IMemorySpaceAddress[],
): void {
  if (writes.length === 0) return;
  const readers = new Set<Action>();
  for (const write of writes) {
    for (const action of state.triggerIndex.collectReadersForWrite(write)) {
      readers.add(action);
    }
  }
  readers.delete(writer);

  for (const action of readers) {
    registerDependentEdge(state, writer, action);
  }
}

export function pruneDependentsForCurrentWrites(
  state: DependencyGraphState,
  writer: Action,
  writes: readonly IMemorySpaceAddress[],
): void {
  const dependents = state.dependents.get(writer);
  if (!dependents) return;

  for (const dependent of [...dependents]) {
    const log = state.dependencies.get(dependent);
    if (
      log &&
      readsOverlapWrites(log.reads, log.shallowReads, writes)
    ) {
      continue;
    }

    unregisterDependentEdge(state, writer, dependent);
  }
}

export function pendingDependencyCollectionMightAffect(
  state: {
    readonly pendingDependencyCollection: ReadonlySet<Action>;
    readonly effects: ReadonlySet<Action>;
    readonly isThrottled: (action: Action) => boolean;
    readonly getSchedulingWrites: (
      action: Action,
    ) => readonly IMemorySpaceAddress[] | undefined;
    readonly hasDependentPath: (from: Action, to: Action) => boolean;
  },
  action: Action,
  reads: readonly IMemorySpaceAddress[],
  shallowReads: readonly IMemorySpaceAddress[],
): boolean {
  if (reads.length === 0 && shallowReads.length === 0) return false;

  for (const pendingAction of state.pendingDependencyCollection) {
    if (pendingAction === action) continue;
    if (state.effects.has(pendingAction)) continue;
    if (state.isThrottled(pendingAction)) continue;

    const writes = state.getSchedulingWrites(pendingAction);
    if (!writes || writes.length === 0) return true;
    if (state.hasDependentPath(pendingAction, action)) return true;
    if (readsOverlapWrites(reads, shallowReads, writes)) {
      return true;
    }
  }

  return false;
}
