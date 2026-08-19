/**
 * Marker for deterministic compile failures on the by-identity cold-load
 * path.
 *
 * The negative memo must never turn a transient storage or resolver failure
 * into a session-long outage. The engine therefore marks only failures that
 * are pure functions of an already verified, content-addressed source
 * closure. Unmarked failures remain retryable, and marking refuses allocation
 * failures outright — heap pressure is not a function of the source.
 *
 * Boot-safe: no TypeScript or compiler-stack imports.
 */

// Deliberately module-private, rather than Symbol.for(): outside code must not
// be able to forge a deterministic classification. A duplicated module graph
// can only cause a missed classification, which safely fails toward retrying.
const DETERMINISTIC_COMPILE_FAILURE: unique symbol = Symbol(
  "cf.deterministicCompileFailure",
);

// An allocation failure is a function of heap pressure, not of the verified
// source bytes, so it must never be classified as deterministic. The messages
// are the stable V8 / JavaScriptCore / SpiderMonkey spellings for catchable
// allocation errors. Stack overflow is deliberately NOT excluded: the
// classified compile steps run on an event-loop-drained stack (see
// `deterministicCompileStep`), so overflow depth is a property of the source
// and recurs on every attempt.
const ALLOCATION_FAILURE_MESSAGE = /out of memory|allocation failed/i;

function isAllocationFailure(error: object): boolean {
  try {
    return ALLOCATION_FAILURE_MESSAGE.test(
      String((error as { message?: unknown }).message ?? ""),
    );
  } catch {
    // Exotic throwable: unclassifiable, so leave it retryable.
    return true;
  }
}

/** Mark and return a failure that will recur for the same verified bytes. */
export function markDeterministicCompileFailure<T>(error: T): T {
  if (
    typeof error === "object" && error !== null && !isAllocationFailure(error)
  ) {
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
