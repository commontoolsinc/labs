/**
 * Marker for DETERMINISTIC compile failures on the by-identity cold-load
 * path (CT-1838 companion hardening).
 *
 * `PatternManager.tryColdLoadByIdentity` wants to memoize failures so an
 * unloadable identity stops re-running closure-read + compile-throw on every
 * referencing tick (that recurring throw loop feeds the CT-1840 CPU
 * picture). But memoizing indiscriminately is dangerous: a TRANSIENT
 * failure (storage blip, network fetch during fabric resolution) would
 * brick a pattern for the whole session. So the engine marks the failures
 * that are pure functions of the (content-addressed, immutable) input bytes
 * — pretransform/guard throws, compiler diagnostics, identity mismatches —
 * and the memo only ever trusts the marker.
 *
 * The marker is a property stamped on the thrown error object (no wrapping,
 * so messages, stacks, and `instanceof` behavior are unchanged for every
 * existing catch site). Non-object throwables are left unmarked — they stay
 * un-memoizable, which fails toward retrying.
 *
 * Boot-safe: no typescript / compiler-stack imports.
 */

const DETERMINISTIC_COMPILE_FAILURE: unique symbol = Symbol.for(
  "cf.deterministicCompileFailure",
);

/**
 * Stamp `error` as a deterministic compile failure and return it. Only call
 * on failures that recur for the same input bytes — never on storage or
 * network errors.
 */
export function markDeterministicCompileFailure<T>(error: T): T {
  if (typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, DETERMINISTIC_COMPILE_FAILURE, {
        value: true,
        enumerable: false,
      });
    } catch {
      // Frozen/sealed error object: leave unmarked (fails toward retrying).
    }
  }
  return error;
}

/** True iff `error` was stamped by {@link markDeterministicCompileFailure}. */
export function isDeterministicCompileFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as Record<PropertyKey, unknown>)[DETERMINISTIC_COMPILE_FAILURE] ===
      true;
}
