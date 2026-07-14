/**
 * Marker for deterministic compile failures on the by-identity cold-load
 * path.
 *
 * The negative memo must never turn a transient storage or resolver failure
 * into a session-long outage. The engine therefore marks only failures that
 * are pure functions of an already verified, content-addressed source
 * closure. Unmarked failures remain retryable.
 *
 * Boot-safe: no TypeScript or compiler-stack imports.
 */

// Deliberately module-private, rather than Symbol.for(): outside code must not
// be able to forge a deterministic classification. A duplicated module graph
// can only cause a missed classification, which safely fails toward retrying.
const DETERMINISTIC_COMPILE_FAILURE: unique symbol = Symbol(
  "cf.deterministicCompileFailure",
);

/** Mark and return a failure that will recur for the same verified bytes. */
export function markDeterministicCompileFailure<T>(error: T): T {
  if (typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, DETERMINISTIC_COMPILE_FAILURE, {
        value: true,
        enumerable: false,
      });
    } catch {
      // Frozen/sealed error: leave unmarked and therefore retryable.
    }
  }
  return error;
}

/** True only for errors stamped by this module. */
export function isDeterministicCompileFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return (error as Record<PropertyKey, unknown>)[
      DETERMINISTIC_COMPILE_FAILURE
    ] === true;
  } catch {
    // Exotic/proxy throwable: fail toward retrying.
    return false;
  }
}
