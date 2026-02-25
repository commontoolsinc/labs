import type { IExtendedStorageTransaction } from "../storage/interface.ts";

const cfcHandlerTransactionMarker = Symbol("cfc-handler-transaction");

type MarkedTransaction = IExtendedStorageTransaction & {
  [cfcHandlerTransactionMarker]?: boolean;
};

export function markCfcHandlerTransaction(
  tx: IExtendedStorageTransaction,
): void {
  (tx as MarkedTransaction)[cfcHandlerTransactionMarker] = true;
}

export function isCfcHandlerTransaction(
  tx: IExtendedStorageTransaction | undefined,
): boolean {
  return Boolean(
    tx &&
      (tx as MarkedTransaction)[cfcHandlerTransactionMarker],
  );
}
