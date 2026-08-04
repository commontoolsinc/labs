import type { Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import {
  isConflictRejection,
  isStorageTransactionInconsistent,
} from "../storage/rejection.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * The per-element bookkeeping a list coordinator keeps across reconciles.
 */
export type ElementRun = {
  resultCell: Cell<any>;
  lastIndex: number;
};

export interface ListSetupRollback {
  /** An entry this reconcile added to the coordinator's element map. */
  created(elementKey: string, entry: ElementRun): void;
  /** An index this reconcile moved, with the value it moved away from. */
  indexChanged(entry: ElementRun, previousIndex: number): void;
  /** A result container this reconcile installed, with a restore for the old one. */
  resultReplaced(restore: () => void): void;
}

/**
 * Undo a reconcile's in-memory bookkeeping when its transaction does not become
 * durable.
 *
 * A reconcile records an element's result cell and index in plain memory while
 * writing that element's setup through its transaction. The memory survives a
 * transaction that is rejected or aborted, so the next reconcile finds the entry,
 * reuses it, and never re-runs the setup whose writes are gone. The element then
 * has no pattern and reads as undefined for as long as the coordinator lives.
 *
 * A stale basis is the exception. A conflict or a local inconsistency re-runs
 * the same reconcile against fresh state, and that re-run is what converges;
 * it reuses this bookkeeping and re-issues only the writes it still needs.
 * Tearing the bookkeeping down under it makes each attempt rebuild the elements
 * it just discarded, and the reconcile stops converging altogether. Every other
 * outcome — an abort, a terminal or permanent refusal, a transport failure —
 * has no such re-run behind it, so the record has to go.
 *
 * Each undo checks that the state it is about to revert is still the state this
 * reconcile installed. An overlapping reconcile that has already moved the same
 * entry owns it, and its bookkeeping matches durable writes of its own.
 */
export function trackListSetupRollback(
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  elementRuns: Map<string, ElementRun>,
): ListSetupRollback {
  const created = new Map<string, ElementRun>();
  const indexChanges = new Map<
    ElementRun,
    { from: number; to: number }
  >();
  const resultRestores: Array<() => void> = [];
  let registered = false;

  const registerRollback = (): void => {
    if (registered) return;
    registered = true;
    tx.addCommitCallback((_settledTx, result) => {
      if (!result.error) return;
      if (
        isConflictRejection(result.error) ||
        isStorageTransactionInconsistent(result.error)
      ) {
        return;
      }
      const errors: unknown[] = [];
      for (const [elementKey, entry] of created) {
        if (elementRuns.get(elementKey) !== entry) continue;
        elementRuns.delete(elementKey);
        indexChanges.delete(entry);
        try {
          runtime.runner.stop(entry.resultCell);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const [entry, { from, to }] of indexChanges) {
        if (entry.lastIndex === to) entry.lastIndex = from;
      }
      for (const restore of resultRestores) {
        try {
          restore();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Multiple list element rollbacks failed",
        );
      }
    });
  };

  return {
    created(elementKey, entry) {
      created.set(elementKey, entry);
      registerRollback();
    },
    indexChanged(entry, previousIndex) {
      const existing = indexChanges.get(entry);
      if (existing) {
        existing.to = entry.lastIndex;
      } else {
        indexChanges.set(entry, { from: previousIndex, to: entry.lastIndex });
      }
      registerRollback();
    },
    resultReplaced(restore) {
      resultRestores.push(restore);
      registerRollback();
    },
  };
}
