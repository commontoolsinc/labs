/**
 * Rejection for operations that cannot complete because the runtime
 * (connection) is disposed or mid-disposal. Expected whenever async work
 * races a teardown — logout, worker replacement, page navigation — so
 * callers should treat it as a cancellation, not a failure.
 */
export class RuntimeDisposedError extends Error {
  override name = "RuntimeDisposedError";
}

/**
 * Matches by `name` rather than `instanceof` so the check survives
 * duplicate bundled copies of this module.
 */
export function isRuntimeDisposedError(
  error: unknown,
): error is RuntimeDisposedError {
  return error instanceof Error && error.name === "RuntimeDisposedError";
}
