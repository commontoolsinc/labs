/**
 * Permanent rejections are commit-time precondition failures (spec
 * scheduler-v2 §7.6): retrying can never succeed and MUST not happen —
 * for `receipt-exists` a retry would double-handle an event.
 */
export function isPermanentRejection(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name === "PreconditionFailedError";
}

/**
 * A conflict rejection is a stale-read / pending-dependency commit failure
 * (normalized to `ConflictError`, see storage/v2.ts): the authoritative version
 * is ahead of this replica. A reactive compute or effect recovers from one by
 * re-arming its subscription, waiting for the conflict's `readyToRetry`
 * catch-up, and re-queuing — off the retry budget, since a conflict is a
 * wait-for-catch-up, not a failure. (Reader-dirty propagation re-triggers it too
 * when the catch-up write lands as a fresh notification, but that does not cover
 * a conflict whose triggering write was already delivered, so the re-queue is
 * what guarantees re-evaluation.) Other non-permanent errors are not
 * catch-up-recoverable and keep their bounded retry instead.
 *
 * The event-handler commit path treats the same rejection as the signal to
 * apply committed-write backpressure: re-running the handler against fresh
 * confirmed state and committing again can succeed, so a conflict is retried
 * with backoff rather than dropped. Handler-initiated aborts and system errors
 * are not conflicts and keep their bounded retry budget.
 */
export function isConflictRejection(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name === "ConflictError";
}

/**
 * A stale-basis inconsistency: a value the transaction read changed on this
 * replica between the read and the commit (see storage/v2-transaction.ts
 * `validate()`). Like a conflict it is resolved by re-running the transaction
 * against fresh state; unlike a conflict the invalidating change is local
 * rather than a rejection from upstream. A transport, authorization, or
 * malformed-store error is not a stale basis and re-running does not resolve it.
 */
export function isStorageTransactionInconsistent(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name === "StorageTransactionInconsistent";
}
