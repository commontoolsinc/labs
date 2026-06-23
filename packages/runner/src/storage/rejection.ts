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
 * (normalized to `ConflictError`, see storage/v2.ts). A reactive compute does
 * NOT need to immediately retry one: the write that caused the conflict dirtied
 * the compute's (still-subscribed) reads, so normal reader-dirty propagation
 * re-runs it with the latest state. Other non-permanent errors are not
 * re-triggered that way and still warrant a retry.
 */
export function isConflictRejection(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name === "ConflictError";
}
