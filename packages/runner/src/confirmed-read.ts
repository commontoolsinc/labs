import type { Runtime } from "./runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "./storage/interface.ts";
import { markDurableReadTx } from "./storage/reactivity-log.ts";
import { getTransactionReadActivities } from "./storage/transaction-inspection.ts";

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
   * reflected in `value`. Absent whenever the replica cannot say
   * (`ISpaceReplica.completeThroughSeq`): before its first push, after a
   * frame it failed to apply, and while its server runs server execution or
   * does not say whether it does.
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
 * read-only transaction it is given (`cell.withTx(tx).get()`, or `sample()`),
 * where a write throws, and returns plain data; the transaction is closed once
 * it returns or throws, so neither it nor a cell bound to it reads again. Every
 * read counts, whether or not it would schedule anything. Documents not yet
 * loaded read as absent and leave the read unconfirmed, so a caller loads what
 * it reads first, with `sync()` or `pull()`. A document in another space leaves
 * the read unconfirmed.
 */
export function readConfirmed<R>(
  runtime: Runtime,
  space: MemorySpace,
  read: (tx: IExtendedStorageTransaction) => R,
): ConfirmedRead<R> {
  const tx = runtime.readTx();
  try {
    markDurableReadTx(tx);
    const value = read(tx);
    const { replica } = runtime.storageManager.open(space);
    const confirmed = replica.isConfirmedDocument !== undefined &&
      [...getTransactionReadActivities(tx)].every((activity) =>
        activity.space === space &&
        replica.isConfirmedDocument!(activity.id, activity.scope)
      );
    const seq = confirmed ? replica.completeThroughSeq?.() : undefined;
    return seq === undefined ? { value, confirmed } : { value, confirmed, seq };
  } finally {
    // A read-only transaction refuses abort(); closing it releases the reads
    // it cached, which a callback that kept it would otherwise hold.
    tx.clearReadOnly?.();
    tx.abort();
  }
}
