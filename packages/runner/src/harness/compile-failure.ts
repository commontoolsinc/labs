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

// Deliberately a module-private WeakSet rather than a marker property: outside
// code must not be able to forge the classification, and set membership cannot
// be faked the way a property read can — a lying proxy trap or an inherited
// marker never answers for object identity. Frozen errors classify fine, since
// membership never touches the object. A duplicated module graph can only
// cause a missed classification, which safely fails toward retrying.
const deterministicCompileFailures = new WeakSet<object>();

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
      deterministicCompileFailures.add(error);
    } catch {
      // Revoked proxy or otherwise unweakable throwable: leave it retryable.
    }
  }
  return error;
}

/** True only for throwables stamped by this module. */
export function isDeterministicCompileFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return deterministicCompileFailures.has(error);
  } catch {
    // Revoked proxy: fail toward retrying.
    return false;
  }
}
