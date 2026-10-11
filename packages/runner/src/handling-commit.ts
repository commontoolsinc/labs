import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Returns the commit sequence at which the handling of a sent event committed
 * in its receipt's space, given the transaction a sender's commit callback
 * received, or `undefined` when that handling wrote no receipt.
 *
 * The sequence is a position in the space's commit log, comparable with the
 * `since` of any document read from that space and with `committedSeq` on any
 * transaction committed there. The handling's receipt is create-only and is
 * written by the handling's own commit, so the receipt document's revision
 * names that commit wherever it ran: in the sender's own transaction, which
 * already knows its sequence; in the commit an earlier delivery of the same
 * invocation made, which a `receipt-exists` collision addresses; and in the
 * serving run's commit under server execution, where the sender's transaction
 * is a local echo.
 *
 * A receipt is written only with commit preconditions or server execution on
 * (`IExtendedStorageTransaction.handlingReceiptLink`). Call it once the
 * callback has fired: under server execution that is after the served
 * handling consequenced, and before it the receipt does not exist.
 */
export async function handlingCommitSeq(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
): Promise<number | undefined> {
  const receipt = tx.handlingReceiptLink;
  if (receipt === undefined) return undefined;
  // A handling this transaction committed names itself; the receipt is read
  // only for one committed elsewhere.
  const committed = tx.committedSeq?.(receipt.space);
  if (committed !== undefined) return committed;
  await runtime.getCellFromLink(receipt).sync();
  const since = runtime.storageManager.open(receipt.space).replica.get({
    id: receipt.id,
    scope: receipt.scope,
  })?.since;
  return since === undefined || since === 0 ? undefined : since;
}
