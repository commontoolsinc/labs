/**
 * Counts read work inside an explicitly enabled transaction. Wrappers share
 * their underlying transaction's counter; unrelated and diagnostic transactions
 * remain independent. Completed counters are removed before commit work starts.
 */

import type {
  IExtendedStorageTransaction,
  IStorageTransaction,
} from "./storage/interface.ts";
import { getTransactionReadActivities } from "./storage/transaction-inspection.ts";

/** Read operations performed during one measured transaction body. */
export type ReadAccessCounts = {
  /** Property and element value requests, including repeated requests. */
  readonly proxyAccesses: number;

  /** Stored link hops actually followed; memo replay contributes no hops. */
  readonly linkResolutions: number;

  /** Distinct space/entity pairs in the transaction's recorded read activities. */
  readonly distinctDocuments: number;
};

interface Counters {
  proxyAccesses: number;
  linkResolutions: number;
}

const counters = new WeakMap<IStorageTransaction, Counters>();

/** Enables accounting before the first read of a transaction body. */
export function beginReadAccounting(tx: IExtendedStorageTransaction): void {
  if (counters.has(tx.tx)) {
    throw new Error("Read accounting is already enabled for this transaction");
  }
  counters.set(tx.tx, { proxyAccesses: 0, linkResolutions: 0 });
}

/** Records one property or element value request through a reactive view. */
export function recordProxyAccess(tx: IExtendedStorageTransaction): void {
  const counter = counters.get(tx.tx);
  if (counter !== undefined) counter.proxyAccesses++;
}

/** Records one actual stored-link hop through resolution or traversal. */
export function recordLinkResolution(tx: IExtendedStorageTransaction): void {
  const counter = counters.get(tx.tx);
  if (counter !== undefined) counter.linkResolutions++;
}

/**
 * Returns the completed body's counts and disables its probes. Unmeasured
 * transactions return `undefined` without inspecting their read activities.
 * Document cardinality includes machinery and ignored scheduling reads; data
 * URI values absent from the storage read log contribute no document.
 */
export function finishReadAccounting(
  tx: IExtendedStorageTransaction,
): ReadAccessCounts | undefined {
  const counter = counters.get(tx.tx);
  if (counter === undefined) return undefined;
  counters.delete(tx.tx);
  const documents = new Map<string, Set<string>>();
  let distinctDocuments = 0;
  for (const read of getTransactionReadActivities(tx)) {
    let ids = documents.get(read.space);
    if (ids === undefined) {
      ids = new Set();
      documents.set(read.space, ids);
    }
    if (!ids.has(read.id)) {
      ids.add(read.id);
      distinctDocuments++;
    }
  }
  return { ...counter, distinctDocuments };
}
