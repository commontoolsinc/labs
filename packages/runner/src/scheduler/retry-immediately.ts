/**
 * Thrown from a handler/action `postRun` when the run referenced a pattern space
 * by name (`PatternFactory.inSpace("name")`) whose DID had not yet been
 * resolved. Before throwing, the runner resolves the pending name(s) into the
 * runtime's space-name cache; the scheduler then aborts the current transaction
 * and re-runs the same handler/action, which now resolves the name(s)
 * synchronously from the cache and proceeds normally.
 *
 * This is an internal control-flow signal, not a user-facing error.
 */
export class RetryImmediately extends Error {
  constructor(message = "Retry action immediately") {
    super(message);
    this.name = "RetryImmediately";
  }
}

export function isRetryImmediately(error: unknown): error is RetryImmediately {
  return error instanceof RetryImmediately;
}
