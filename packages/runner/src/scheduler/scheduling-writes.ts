import {
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
  sortAndCompactPaths,
} from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "../storage/interface.ts";
import { entityKey } from "./keys.ts";
import type { Action, SpaceScopeAndURI } from "./types.ts";

export interface WriterIndexState {
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly actionWriteEntities: WeakMap<Action, Set<SpaceScopeAndURI>>;
  updateWriterIndex(
    action: Action,
    nextSchedulingWrites: readonly IMemorySpaceAddress[],
  ): {
    nextEntities: Set<SpaceScopeAndURI>;
    addedEntities: Set<SpaceScopeAndURI>;
    removedEntities: Set<SpaceScopeAndURI>;
  };
  clearAction(action: Action): void;
}

export interface SchedulingWriteState {
  readonly currentKnownWrites: WeakMap<Action, IMemorySpaceAddress[]>;
  readonly historicalMightWrite: WeakMap<Action, IMemorySpaceAddress[]>;
  readonly useHistoricalMightWrite: () => boolean;
  getSchedulingWrites(action: Action): IMemorySpaceAddress[] | undefined;
  getSchedulingWritesMap(): WeakMap<Action, IMemorySpaceAddress[]>;
}

export class SchedulerWriteIndex
  implements WriterIndexState, SchedulingWriteState {
  // Current-known writes are rebuilt on each dependency update from actual
  // writes plus declared writes. This is the default scheduling view.
  readonly currentKnownWrites = new WeakMap<Action, IMemorySpaceAddress[]>();
  // Historical writes preserve the legacy cumulative union and are only used
  // when the experimental historical-write mode is enabled.
  readonly historicalMightWrite = new WeakMap<Action, IMemorySpaceAddress[]>();
  // Index: entity -> actions that write to it (for fast dependency lookup).
  // Updated from the active scheduling write set.
  readonly writersByEntity = new Map<SpaceScopeAndURI, Set<Action>>();
  // Reverse index: action -> entities it writes to (for cleanup).
  readonly actionWriteEntities = new WeakMap<
    Action,
    Set<SpaceScopeAndURI>
  >();

  constructor(
    private readonly state: {
      readonly useHistoricalMightWrite: () => boolean;
    },
  ) {}

  useHistoricalMightWrite(): boolean {
    return this.state.useHistoricalMightWrite();
  }

  getSchedulingWrites(action: Action): IMemorySpaceAddress[] | undefined {
    return this.useHistoricalMightWrite()
      ? this.historicalMightWrite.get(action)
      : this.currentKnownWrites.get(action);
  }

  getSchedulingWritesMap(): WeakMap<Action, IMemorySpaceAddress[]> {
    return this.useHistoricalMightWrite()
      ? this.historicalMightWrite
      : this.currentKnownWrites;
  }

  updateWriterIndex(
    action: Action,
    nextSchedulingWrites: readonly IMemorySpaceAddress[],
  ): {
    nextEntities: Set<SpaceScopeAndURI>;
    addedEntities: Set<SpaceScopeAndURI>;
    removedEntities: Set<SpaceScopeAndURI>;
  } {
    const existingEntities = this.actionWriteEntities.get(action) ?? new Set();
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
      const writers = this.writersByEntity.get(entity);
      writers?.delete(action);
      if (writers && writers.size === 0) {
        this.writersByEntity.delete(entity);
      }
    }

    for (const entity of addedEntities) {
      let writers = this.writersByEntity.get(entity);
      if (!writers) {
        writers = new Set();
        this.writersByEntity.set(entity, writers);
      }
      writers.add(action);
    }

    this.actionWriteEntities.set(action, nextEntities);
    return { nextEntities, addedEntities, removedEntities };
  }

  clearAction(action: Action): void {
    const writeEntities = this.actionWriteEntities.get(action);
    if (!writeEntities) return;

    for (const entity of writeEntities) {
      const writers = this.writersByEntity.get(entity);
      writers?.delete(action);
      if (writers && writers.size === 0) {
        this.writersByEntity.delete(entity);
      }
    }
    // Clear actionWriteEntities so resubscribe will re-register the action.
    this.actionWriteEntities.delete(action);
  }
}

export function getSchedulingWrites(
  state: SchedulingWriteState,
  action: Action,
): IMemorySpaceAddress[] | undefined {
  return state.getSchedulingWrites(action);
}

export function getSchedulingWritesMap(
  state: SchedulingWriteState,
): WeakMap<Action, IMemorySpaceAddress[]> {
  return state.getSchedulingWritesMap();
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
  return state.updateWriterIndex(action, nextSchedulingWrites);
}

export function buildKnownSchedulingWrites(state: {
  readonly writes: readonly IMemorySpaceAddress[];
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
  const declaredAncestorWrites = deriveDeclaredAncestorWrites(
    state.writes,
    state.declaredWrites,
  );
  const newCurrentKnownWrites = sortAndCompactPaths([
    ...currentSeedWrites,
    ...dynamicParentWrites,
    ...declaredAncestorWrites,
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

export function deriveDeclaredAncestorWrites(
  writes: readonly IMemorySpaceAddress[],
  declaredWrites: readonly IMemorySpaceAddress[],
): IMemorySpaceAddress[] {
  const ancestorWrites: IMemorySpaceAddress[] = [];
  for (const declaredWrite of declaredWrites) {
    for (const write of writes) {
      if (
        declaredWrite.space === write.space &&
        declaredWrite.id === write.id &&
        declaredWrite.type === write.type &&
        declaredWrite.path.length < write.path.length &&
        arraysOverlap(declaredWrite.path, write.path)
      ) {
        ancestorWrites.push(declaredWrite);
        break;
      }
    }
  }
  return ancestorWrites;
}

function isDynamicCollectionSegment(
  segment: MemoryAddressPathComponent | undefined,
): boolean {
  if (typeof segment === "number") return Number.isInteger(segment);
  return typeof segment === "string" && /^(0|[1-9]\d*)$/.test(segment);
}
