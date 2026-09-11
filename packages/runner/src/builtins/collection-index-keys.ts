/** Enumerates occupied index keys when a consumer demands that surface. */

import type { AddCancel } from "../cancel.ts";
import type { Cell } from "../cell.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { compareCollectionKeys } from "./collection-index-key.ts";
import type { CollectionIndexMembership } from "./collection-index-membership.ts";

/**
 * Reads raw occupied keys in deterministic typed order, preserving Cell keys.
 * Public mixed primitive/Cell enumeration awaits a representation contract at
 * the result materialization boundary.
 */
export function readCollectionIndexKeys(
  tx: IExtendedStorageTransaction,
  state: Cell<CollectionIndexMembership>,
): unknown[] {
  const occupied = Object.values(
    snapshotQueryResult(state.withTx(tx).key("occupied").get() ?? {}),
  ).filter((entry) => entry !== undefined)
    .sort((a, b) => compareCollectionKeys(a.identity, b.identity));
  return occupied.map((entry) =>
    entry.cell
      ? state.runtime.getCellFromLink(entry.cell, undefined, tx)
      : entry.identity.value
  );
}

/** Publishes enumeration through an ordinary demanded child result. */
export function collectionIndexKeys(
  inputs: Cell<{ state: CollectionIndexMembership }>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: AddCancel,
): RawBuiltinReturnType {
  return {
    deferUntilDemand: true,
    action: (tx) => {
      sendResult(
        tx,
        readCollectionIndexKeys(
          tx,
          inputs.withTx(tx).key("state").resolveAsCell(),
        ),
      );
    },
  };
}
