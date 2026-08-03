/**
 * Install the executor-provider half of conflict retry readiness.
 *
 * Errors can cross a Worker/SES realm before reaching this adapter, so their
 * identity is the protocol `name`, not the local realm's `Error` prototype.
 * The ordinary memory-client gate only proves that the host processed the
 * rejected local sequence. The synthetic executor view is fed separately by
 * accepted-commit notices, so readiness must also cross the host barrier and
 * drain every notice queued before it before advertising caught-up state.
 */
export function installHostConflictRetryBarrier(
  error: unknown,
  options: {
    acceptedCommitsSettled: () => Promise<unknown>;
    markCaughtUp: () => void;
  },
): boolean {
  if (typeof error !== "object" || error === null) return false;
  const conflict = error as {
    name?: unknown;
    readyToRetry?: unknown;
  };
  const readyToRetry = conflict.readyToRetry;
  if (
    conflict.name !== "ConflictError" || typeof readyToRetry !== "function"
  ) {
    return false;
  }
  conflict.readyToRetry = async () => {
    await Promise.resolve(readyToRetry.call(error));
    await options.acceptedCommitsSettled();
    options.markCaughtUp();
  };
  return true;
}
