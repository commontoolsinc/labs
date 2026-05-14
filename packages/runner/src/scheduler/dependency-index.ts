import {
  addressesToPathByEntity,
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
  sortAndCompactPaths,
  type SortedAndCompactPaths,
} from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "../storage/interface.ts";
import { entityKey } from "./keys.ts";
import type {
  Action,
  DirtyDependencyTraceContext,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

export interface TriggerIndexState {
  readonly triggers: Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >;
  readonly nonRecursiveTriggers: Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >;
}

export interface WriterIndexState {
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly actionWriteEntities: WeakMap<Action, Set<SpaceScopeAndURI>>;
}

export function addTriggerPathsToIndex(
  state: TriggerIndexState,
  action: Action,
  reads: IMemorySpaceAddress[],
  shallowReads: IMemorySpaceAddress[],
): {
  entities: Set<SpaceScopeAndURI>;
  triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
} {
  const pathsByEntity = addressesToPathByEntity(reads);
  const nonRecursivePathsByEntity = addressesToPathByEntity(shallowReads);
  const entities = new Set<SpaceScopeAndURI>();
  const triggerPathsByEntity = new Map<
    SpaceScopeAndURI,
    SortedAndCompactPaths
  >();

  for (const [spaceAndURI, paths] of pathsByEntity) {
    entities.add(spaceAndURI);
    let pathsByAction = state.triggers.get(spaceAndURI);
    if (!pathsByAction) {
      pathsByAction = new Map();
      state.triggers.set(spaceAndURI, pathsByAction);
    }
    pathsByAction.set(action, paths);
    triggerPathsByEntity.set(spaceAndURI, paths);
  }

  for (const [spaceAndURI, paths] of nonRecursivePathsByEntity) {
    entities.add(spaceAndURI);
    let pathsByAction = state.nonRecursiveTriggers.get(spaceAndURI);
    if (!pathsByAction) {
      pathsByAction = new Map();
      state.nonRecursiveTriggers.set(spaceAndURI, pathsByAction);
    }
    pathsByAction.set(action, paths);
  }

  return { entities, triggerPathsByEntity };
}

export function removeActionFromTriggerIndex(
  state: TriggerIndexState,
  action: Action,
  entities: Iterable<SpaceScopeAndURI>,
): void {
  for (const spaceAndURI of entities) {
    state.triggers.get(spaceAndURI)?.delete(action);
    state.nonRecursiveTriggers.get(spaceAndURI)?.delete(action);
  }
}

export function updateWriterIndex(
  state: WriterIndexState,
  action: Action,
  nextSchedulingWrites: readonly IMemorySpaceAddress[],
): {
  nextEntities: Set<SpaceScopeAndURI>;
  addedEntities: Set<SpaceScopeAndURI>;
  removedEntities: Set<SpaceScopeAndURI>;
} {
  const existingEntities = state.actionWriteEntities.get(action) ?? new Set();
  const nextEntities = new Set<SpaceScopeAndURI>();
  const addedEntities = new Set<SpaceScopeAndURI>();
  const removedEntities = new Set<SpaceScopeAndURI>();

  for (const write of nextSchedulingWrites) {
    const entity = entityKey(write);
    nextEntities.add(entity);
    if (!existingEntities.has(entity)) {
      addedEntities.add(entity);
    }
  }

  for (const entity of existingEntities) {
    if (!nextEntities.has(entity)) {
      removedEntities.add(entity);
    }
  }

  for (const entity of removedEntities) {
    const writers = state.writersByEntity.get(entity);
    writers?.delete(action);
    if (writers && writers.size === 0) {
      state.writersByEntity.delete(entity);
    }
  }

  for (const entity of addedEntities) {
    let writers = state.writersByEntity.get(entity);
    if (!writers) {
      writers = new Set();
      state.writersByEntity.set(entity, writers);
    }
    writers.add(action);
  }

  state.actionWriteEntities.set(action, nextEntities);
  return { nextEntities, addedEntities, removedEntities };
}

export function buildKnownSchedulingWrites(state: {
  readonly writes: readonly IMemorySpaceAddress[];
  readonly potentialWrites: readonly IMemorySpaceAddress[];
  readonly declaredWrites: readonly IMemorySpaceAddress[];
  readonly existingCurrentWrites: readonly IMemorySpaceAddress[];
  readonly existingHistoricalWrites: readonly IMemorySpaceAddress[];
}): {
  newCurrentKnownWrites: IMemorySpaceAddress[];
  newHistoricalMightWrite: IMemorySpaceAddress[];
} {
  const currentSeedWrites = state.writes.length > 0
    ? state.writes
    : state.existingCurrentWrites.length > 0
    ? state.existingCurrentWrites
    : state.declaredWrites;
  const dynamicParentWrites = deriveDynamicCollectionParentWrites(
    state.writes,
    state.declaredWrites,
  );
  const newCurrentKnownWrites = sortAndCompactPaths([
    ...currentSeedWrites,
    ...dynamicParentWrites,
    ...state.potentialWrites,
  ]);
  const newHistoricalMightWrite = sortAndCompactPaths([
    ...state.existingHistoricalWrites,
    ...newCurrentKnownWrites,
  ]);
  return { newCurrentKnownWrites, newHistoricalMightWrite };
}

export function diffSchedulingWrites(
  previousSchedulingWrites: readonly IMemorySpaceAddress[],
  nextSchedulingWrites: readonly IMemorySpaceAddress[],
): {
  addedWrites: IMemorySpaceAddress[];
  removedWrites: IMemorySpaceAddress[];
} {
  const addedWrites = nextSchedulingWrites.filter((write) =>
    !previousSchedulingWrites.some((existing) =>
      schedulingWriteSubsumes(existing, write)
    )
  );
  const removedWrites = previousSchedulingWrites.filter((write) =>
    !nextSchedulingWrites.some((existing) =>
      schedulingWriteSubsumes(existing, write)
    )
  );
  return { addedWrites, removedWrites };
}

function schedulingWriteSubsumes(
  existing: IMemorySpaceAddress,
  write: IMemorySpaceAddress,
): boolean {
  return existing.space === write.space &&
    existing.id === write.id &&
    normalizeCellScope(existing.scope) === normalizeCellScope(write.scope) &&
    existing.path.length <= write.path.length &&
    arraysOverlap(existing.path, write.path);
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

export function collectReadersForWrite(
  state: TriggerIndexState,
  write: IMemorySpaceAddress,
): Set<Action> {
  const entity = entityKey(write);
  const readers = new Set<Action>();

  const recursiveReaders = state.triggers.get(entity);
  if (recursiveReaders) {
    for (const [action, paths] of recursiveReaders) {
      if (paths.some((path) => arraysOverlap(write.path, path))) {
        readers.add(action);
      }
    }
  }

  const nonRecursiveReaders = state.nonRecursiveTriggers.get(entity);
  if (nonRecursiveReaders) {
    for (const [action, reads] of nonRecursiveReaders) {
      if (
        reads.some((read) => nonRecursiveReadMayOverlapWrite(read, write.path))
      ) {
        readers.add(action);
      }
    }
  }

  return readers;
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

export function readsOverlapWrites(
  reads: readonly IMemorySpaceAddress[],
  shallowReads: readonly IMemorySpaceAddress[],
  writes: readonly IMemorySpaceAddress[],
): boolean {
  for (const read of reads) {
    for (const write of writes) {
      if (
        read.space === write.space &&
        read.id === write.id &&
        normalizeCellScope(read.scope) === normalizeCellScope(write.scope) &&
        arraysOverlap(write.path, read.path)
      ) {
        return true;
      }
    }
  }

  // For non-recursive reads, only same/ancestor path or direct child writes
  // create a dependency. Deep descendant writes cannot affect shallow structure.
  for (const read of shallowReads) {
    for (const write of writes) {
      if (
        read.space === write.space &&
        read.id === write.id &&
        normalizeCellScope(read.scope) === normalizeCellScope(write.scope) &&
        nonRecursiveReadMayOverlapWrite(read.path, write.path)
      ) {
        return true;
      }
    }
  }

  return false;
}

export function pruneStructuralAncestorWrites(
  writes: readonly IMemorySpaceAddress[],
): IMemorySpaceAddress[] {
  // Transaction reactivity logs include ancestor paths when a child write
  // changes shallow structure. For scheduling writes, the descendant path is
  // precise enough; keeping the ancestor would make unrelated shallow root
  // readers depend on this action.
  return writes.filter((write) =>
    !writes.some((other) =>
      other !== write &&
      other.space === write.space &&
      other.id === write.id &&
      other.type === write.type &&
      write.path.length < other.path.length &&
      arraysOverlap(write.path, other.path)
    )
  );
}

export function deriveDynamicCollectionParentWrites(
  writes: readonly IMemorySpaceAddress[],
  declaredWrites: readonly IMemorySpaceAddress[],
): IMemorySpaceAddress[] {
  const parentWrites: IMemorySpaceAddress[] = [];
  for (const declaredWrite of declaredWrites) {
    for (const write of writes) {
      if (
        declaredWrite.space !== write.space ||
        declaredWrite.id !== write.id ||
        declaredWrite.type !== write.type ||
        declaredWrite.path.length >= write.path.length ||
        !arraysOverlap(declaredWrite.path, write.path)
      ) {
        continue;
      }

      const dynamicSegment = write.path[declaredWrite.path.length];
      if (isDynamicCollectionSegment(dynamicSegment)) {
        parentWrites.push(declaredWrite);
      }
    }
  }
  return parentWrites;
}

function isDynamicCollectionSegment(
  segment: MemoryAddressPathComponent | undefined,
): boolean {
  if (typeof segment === "number") return Number.isInteger(segment);
  return typeof segment === "string" && /^(0|[1-9]\d*)$/.test(segment);
}
