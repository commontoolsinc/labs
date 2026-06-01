import type { RuntimeProgram } from "../harness/types.ts";
import { isPattern, type Pattern } from "./types.ts";

/**
 * Side-table storage for pattern metadata that is associated *after* a pattern
 * is exported from its module:
 *
 * - `program` — the rehydration source (`RuntimeProgram`) attached by the engine
 *   after compilation/eval and at registration time.
 * - `verifiedLoadId` — the CFC verified-load identity attached by the engine
 *   while seeding verified-load ids.
 *
 * These used to live as an own data property (`pattern.program`) and a symbol
 * property (`pattern[unsafe_verifiedLoadId]`) on the pattern object. Storing
 * them in module-level WeakMaps instead lets the ESM loader `harden()` exported
 * pattern values at the module boundary: the associations are still attached
 * later, but a WeakMap write does not mutate the (now frozen) object. Keyed by
 * `object` (patterns are callable objects, and derivation copies / bound values
 * also carry the verified-load id), with WeakMap GC semantics so a value's
 * metadata is collected with the value.
 */

const programByPattern = new WeakMap<object, RuntimeProgram>();
const verifiedLoadIdByValue = new WeakMap<object, string>();

// Provenance brand: a value is added here ONLY by the trusted `pattern()`
// builder (see builder/pattern.ts). `isPattern` is a purely structural check
// (`{argumentSchema, resultSchema, nodes}`), so an attacker can forge that shape
// via `__cf_data({...})` — a frozen plain object that passes `isPattern`.
// Trust-granting sites (program / verified-load-id association, entry-pattern
// selection) must use `isTrustedPattern` instead, so forged pattern-shaped data
// cannot launder itself into the trust side-tables. The runner's own
// instantiation logic keeps using structural `isPattern` (it operates on
// derivation copies and independently re-resolves node implementations).
const trustedPatterns = new WeakSet<object>();

function asKey(value: unknown): object | undefined {
  if (value === null) return undefined;
  return (typeof value === "object" || typeof value === "function")
    ? (value as object)
    : undefined;
}

/** The rehydration source associated with a pattern, if any. */
export function getPatternProgram(
  pattern: unknown,
): RuntimeProgram | undefined {
  const key = asKey(pattern);
  return key ? programByPattern.get(key) : undefined;
}

/** Associate a rehydration source with a pattern (works on frozen patterns). */
export function setPatternProgram(
  pattern: unknown,
  program: RuntimeProgram,
): void {
  const key = asKey(pattern);
  if (key) programByPattern.set(key, program);
}

/** The CFC verified-load id associated with a value, if any. */
export function getVerifiedLoadId(value: unknown): string | undefined {
  const key = asKey(value);
  return key ? verifiedLoadIdByValue.get(key) : undefined;
}

/** Associate a CFC verified-load id with a value (works on frozen values). */
export function setVerifiedLoadId(value: unknown, id: string): void {
  const key = asKey(value);
  if (key) verifiedLoadIdByValue.set(key, id);
}

/** Stamp a value as produced by the trusted `pattern()` builder. */
export function brandTrustedPattern<T>(value: T): T {
  const key = asKey(value);
  if (key) trustedPatterns.add(key);
  return value;
}

/**
 * True only for a value that is both structurally a pattern AND was produced by
 * the trusted builder (carries the provenance brand). Use this at trust-granting
 * sites; a `__cf_data`-forged pattern-shaped object is `isPattern` but NOT
 * `isTrustedPattern`.
 */
export function isTrustedPattern(value: unknown): value is Pattern {
  const key = asKey(value);
  return key !== undefined && trustedPatterns.has(key) && isPattern(value);
}
