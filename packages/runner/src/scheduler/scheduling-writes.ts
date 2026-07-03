import {
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
} from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { entityKey } from "./keys.ts";
import type { Action, SpaceScopeAndURI } from "./types.ts";

export interface WriterIndexState {
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly actionWriteEntities: WeakMap<Action, Set<SpaceScopeAndURI>>;
  setSurface(action: Action, surface: IMemorySpaceAddress[]): void;
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
  getSchedulingWrites(action: Action): IMemorySpaceAddress[] | undefined;
  getSchedulingWritesMap(): WeakMap<Action, IMemorySpaceAddress[]>;
}

export class SchedulerWriteIndex
  implements WriterIndexState, SchedulingWriteState {
  // Current-known writes are the action's static declared write surface.
  readonly currentKnownWrites = new WeakMap<Action, IMemorySpaceAddress[]>();
  // Index: entity -> actions that write to it (for fast dependency lookup).
  // Updated from the active scheduling write set.
  readonly writersByEntity = new Map<SpaceScopeAndURI, Set<Action>>();
  // Reverse index: action -> entities it writes to (for cleanup).
  readonly actionWriteEntities = new WeakMap<
    Action,
    Set<SpaceScopeAndURI>
  >();

  getSchedulingWrites(action: Action): IMemorySpaceAddress[] | undefined {
    return this.currentKnownWrites.get(action);
  }

  getSchedulingWritesMap(): WeakMap<Action, IMemorySpaceAddress[]> {
    return this.currentKnownWrites;
  }

  /** Registers the action's static write surface (idempotent). */
  setSurface(action: Action, surface: IMemorySpaceAddress[]): void {
    this.currentKnownWrites.set(action, surface);
    this.updateWriterIndex(action, surface);
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

/**
 * Visit every writer whose static write surface overlaps one of `reads` /
 * `shallowReads`, via the writersByEntity index. The one entity-pruned
 * overlap scan behind collectDirectWritersForLog,
 * collectReverseDependenciesForLog, the effect-resubscribe stale-input
 * re-check, and the declared-read writer closure — call-site policy (which
 * writers qualify, dedup, early exit) stays in the visitor.
 *
 * `filter` is the cheap pre-overlap writer filter; `onCandidate` fires once
 * per (read, surviving writer) pair before the overlap test (trace
 * bookkeeping). `visit` may be called more than once for the same writer
 * (once per matching read) — visitors dedupe via their own set; returning
 * true stops the whole scan.
 */
export function forEachOverlappingWriter(
  state: {
    readonly writersByEntity: ReadonlyMap<SpaceScopeAndURI, Set<Action>>;
    readonly getSchedulingWrites: (
      action: Action,
    ) => readonly IMemorySpaceAddress[] | undefined;
  },
  reads: readonly IMemorySpaceAddress[],
  shallowReads: readonly IMemorySpaceAddress[],
  visit: (writer: Action) => boolean | void,
  hooks: {
    readonly filter?: (writer: Action) => boolean;
    readonly onCandidate?: (writer: Action) => void;
  } = {},
): void {
  const scan = (
    read: IMemorySpaceAddress,
    shallow: boolean,
  ): boolean => {
    const writers = state.writersByEntity.get(entityKey(read));
    if (!writers) return false;
    for (const writer of writers) {
      if (hooks.filter && !hooks.filter(writer)) continue;
      hooks.onCandidate?.(writer);
      const writes = state.getSchedulingWrites(writer) ?? [];
      const overlaps = shallow
        ? readsOverlapWrites([], [read], writes)
        : readsOverlapWrites([read], [], writes);
      if (overlaps && visit(writer) === true) return true;
    }
    return false;
  };
  for (const read of reads) {
    if (scan(read, false)) return;
  }
  for (const read of shallowReads) {
    if (scan(read, true)) return;
  }
}
