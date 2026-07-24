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
 * The wire names of terminal commit rejections: a server-side commit-time
 * evaluation that DETERMINISTICALLY refused the committed data itself, so
 * re-running the identical handler recomputes the identical refused write and
 * can NEVER converge. Today: `RowLabelCommitError` — a CFC per-row label
 * commit-rule violation (memory/v2/sqlite/commit-eval.ts, evaluated inside
 * `applyCommitTransaction`, rolls back the whole commit). The memory server
 * MUST serialize the class name unchanged (memory/v2/server.ts transact catch);
 * the runner keeps it through normalization (storage/v2.ts `toRejectedError`).
 * Keep the two in sync — the sqlite-cfc-commit-eval integration test exercises
 * the real server→runner path and fails if the name is dropped or renamed.
 */
const TERMINAL_REJECTION_NAMES: ReadonlySet<string> = new Set([
  "RowLabelCommitError",
]);

/**
 * A terminal rejection is a deterministic, data-caused commit refusal that
 * retrying can never resolve (see {@link TERMINAL_REJECTION_NAMES}). It is
 * terminal like a {@link isPermanentRejection}, but classified separately: a
 * permanent rejection is an idempotency/lineage precondition
 * (`origin-committed`/`receipt-exists`), whereas a terminal rejection is the
 * server refusing the committed rows on their own merits. Both must stop the
 * handler immediately: a doomed handler that keeps re-running through its retry
 * budget produces speculative rev bumps on each attempt that starve concurrent
 * sibling commits sharing reactive state. Unlike a stale-read
 * {@link isConflictRejection} (retry against fresh state can converge), a
 * terminal rejection is NOT retryable.
 */
export function isTerminalRejection(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name !== undefined && TERMINAL_REJECTION_NAMES.has(error.name);
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
 * what guarantees re-evaluation.) The reactive path recovers the local
 * stale-basis guard (`isStorageTransactionInconsistent`) the same way — it too
 * converges by re-running, so it re-queues off the budget rather than stranding
 * a compute as a zombie under a contention burst. Only a non-permanent error
 * that re-running cannot resolve — a transport or malformed-store error — keeps
 * the bounded retry.
 *
 * The event-handler commit path treats the same rejection as the signal to
 * apply committed-write backpressure: re-running the handler against fresh
 * confirmed state and committing again can succeed, so a conflict is retried
 * with backoff rather than dropped. It windows the local stale-basis guard
 * (`isStorageTransactionInconsistent`) the same way. Every other non-permanent
 * rejection there — a handler-initiated abort, an authorization denial, a
 * transport or malformed-store error — is not a stale basis and cannot converge
 * by re-running, so it drops fast rather than entering the window (see
 * `classifyCommitDisposition` in scheduler/events.ts).
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
