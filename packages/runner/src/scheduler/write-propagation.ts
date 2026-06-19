import { valueEqual } from "@commonfabric/data-model/fabric-value";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { getTransactionWriteDetails } from "../storage/transaction-inspection.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry } from "./node-record.ts";
import type { TriggerIndexState } from "./trigger-index.ts";
import type { Action, ReactivityLog } from "./types.ts";

export interface WritePropagationState {
  readonly triggerIndex: TriggerIndexState;
  readonly changedWritesHistory: IMemorySpaceAddress[];
  readonly effects: ReadonlySet<Action>;
  readonly computations: ReadonlySet<Action>;
  readonly conditionallyScheduledEffects: Map<Action, number>;
  readonly nodes: NodeRegistry;
  readonly pending: Set<Action>;
  readonly markPullDemandContinuation: (action: Action) => void;
  readonly scheduleWithDebounce: (action: Action) => void;
  readonly markDirty: (action: Action) => void;
  readonly materializerIndex: MaterializerIndexState;
  readonly scheduleAffectedEffects: (action: Action) => void;
  readonly queueExecution: () => void;
}

export function collectChangedWritesForTransaction(
  tx: IExtendedStorageTransaction,
  log: Pick<ReactivityLog, "writes">,
): IMemorySpaceAddress[] {
  if (log.writes.length === 0) return [];

  const spaces = new Set(log.writes.map((write) => write.space));
  const changedWrites: IMemorySpaceAddress[] = [];

  for (const space of spaces) {
    for (const detail of getTransactionWriteDetails(tx, space)) {
      // TODO(danfuzz): `deepEqual` mishandles `FabricValue` (see
      // `utils/deep-equal.ts`); this compares stored `FabricValue`s, so migrate
      // to a `Fabric`-aware equality once available.
      if (!valueEqual(detail.previousValue, detail.value)) {
        changedWrites.push(detail.address);
      }
    }
  }

  return sortAndCompactPaths(changedWrites);
}

export function recordChangedWritesHistory(
  state: Pick<WritePropagationState, "changedWritesHistory">,
  changedWrites: readonly IMemorySpaceAddress[],
): void {
  if (changedWrites.length > 0) {
    state.changedWritesHistory.push(...sortAndCompactPaths([...changedWrites]));
  }
}

export function recordChangedComputationWrites(
  state: WritePropagationState,
  action: Action,
  tx: IExtendedStorageTransaction,
  log: ReactivityLog,
): IMemorySpaceAddress[] {
  if (!state.computations.has(action)) return [];
  const changedWrites = collectChangedWritesForTransaction(tx, log);
  recordChangedWritesHistory(state, changedWrites);
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
      if (state.materializerIndex.isMaterializer(reader)) {
        state.queueExecution();
      }
      if (state.nodes.isAncestor(sourceAction, reader)) {
        // Continuations are only for actions in the scheduler parent chain.
        // Dependency edges already schedule ordinary downstream readers; this
        // handles the narrower case where a child created during a pull writes
        // something its already-run parent read.
        state.markPullDemandContinuation(reader);
        state.pending.add(reader);
        state.queueExecution();
      }
      state.scheduleAffectedEffects(reader);
    }
  }
}
