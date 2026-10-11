import type { Runtime } from "./runtime.ts";
import { txToReactivityLog } from "./scheduler/reactivity.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "./storage/interface.ts";
import { markDurableReadTx } from "./storage/reactivity-log.ts";

/** What {@link readConfirmed} returns. */
export type ConfirmedRead<R> = {
  /** What `read` returned. */
  value: R;

  /**
   * Whether every document `read` consumed holds confirmed state in `space`:
   * watched and delivered, with no pending local write and no value the
   * replica made up locally (`ISpaceReplica.isConfirmedDocument`).
   */
  confirmed: boolean;

  /**
   * When `confirmed`, the commit sequence through which the read is complete:
   * every commit at or below it that touched a document `read` consumed is
   * reflected in `value`. Absent when the replica cannot say, and under
   * server execution, whose wave commits can reach a push's stamped head
   * before their changes reach the push.
   */
  seq?: number;
};

/**
 * Runs `read` against the replica of `space` in one transaction that reads past
 * any speculation overlay, and returns what it returned, whether everything it
 * consumed is confirmed, and the sequence the read is complete through.
 *
 * `read` runs synchronously, so every document it consumes is read at one
 * instant: a value assembled from several cells inside it cannot straddle a
 * commit that a value assembled from separate reads can. It reads through the
 * transaction it is given (`cell.withTx(tx).get()`) and returns plain data;
 * the transaction is aborted once it returns, so a cell bound to it is not
 * read again afterwards. Documents not yet loaded read as absent and leave the
 * read unconfirmed, so a caller loads what it reads first, with `sync()` or
 * `pull()`. A document in another space leaves the read unconfirmed.
 */
export function readConfirmed<R>(
  runtime: Runtime,
  space: MemorySpace,
  read: (tx: IExtendedStorageTransaction) => R,
): ConfirmedRead<R> {
  const tx = runtime.edit();
  markDurableReadTx(tx);
  try {
    const value = read(tx);
    const { replica } = runtime.storageManager.open(space);
    const log = txToReactivityLog(tx);
    const confirmed = replica.isConfirmedDocument !== undefined &&
      [...log.reads, ...log.shallowReads].every((address) =>
        address.space === space &&
        replica.isConfirmedDocument!(address.id, address.scope)
      );
    const seq = confirmed && runtime.experimental.serverExecution !== true
      ? replica.completeThroughSeq?.()
      : undefined;
    return seq === undefined ? { value, confirmed } : { value, confirmed, seq };
  } finally {
    tx.abort();
  }
}
