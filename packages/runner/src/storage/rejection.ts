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
