import { deepEqual } from "@commonfabric/utils/deep-equal";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { getTransactionWriteDetails } from "../storage/transaction-inspection.ts";
import type { TriggerIndexState } from "./trigger-index.ts";
import type { Action, ReactivityLog } from "./types.ts";

export interface WritePropagationState {
  readonly triggerIndex: TriggerIndexState;
  readonly changedWritesHistory: IMemorySpaceAddress[];
  readonly effects: ReadonlySet<Action>;
  readonly computations: ReadonlySet<Action>;
  readonly conditionallyScheduledEffects: Map<Action, number>;
  readonly scheduleWithDebounce: (action: Action) => void;
  readonly markDirty: (action: Action) => void;
  readonly scheduleAffectedEffects: (action: Action) => void;
}

export function recordChangedComputationWrites(
  state: WritePropagationState,
  action: Action,
  tx: IExtendedStorageTransaction,
  log: ReactivityLog,
): IMemorySpaceAddress[] {
  if (!state.computations.has(action)) return [];
  if (log.writes.length === 0) return [];

  const spaces = new Set(log.writes.map((write) => write.space));
  const changedWrites: IMemorySpaceAddress[] = [];

  for (const space of spaces) {
    for (const detail of getTransactionWriteDetails(tx, space)) {
      if (!deepEqual(detail.previousValue, detail.value)) {
        changedWrites.push(detail.address);
      }
    }
  }

  if (changedWrites.length > 0) {
    state.changedWritesHistory.push(...sortAndCompactPaths(changedWrites));
  }
  return changedWrites;
}

export function markReadersDirtyForChangedWrites(
  state: WritePropagationState,
  sourceAction: Action,
  changedWrites: readonly IMemorySpaceAddress[],
): void {
  if (changedWrites.length === 0) return;

  const readers = new Set<Action>();
  for (const write of sortAndCompactPaths([...changedWrites])) {
    for (const reader of state.triggerIndex.collectReadersForWrite(write)) {
      if (reader !== sourceAction) {
        readers.add(reader);
      }
    }
  }

  for (const reader of readers) {
    if (state.effects.has(reader)) {
      state.conditionallyScheduledEffects.delete(reader);
      state.scheduleWithDebounce(reader);
    } else if (state.computations.has(reader)) {
      state.markDirty(reader);
      state.scheduleAffectedEffects(reader);
    }
  }
}
