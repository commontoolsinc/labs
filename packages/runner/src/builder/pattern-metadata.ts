import type { RuntimeProgram } from "../harness/types.ts";
import { isPattern, type Pattern, unsafe_originalPattern } from "./types.ts";

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

// Provenance brand for the OTHER trusted builder artifacts — `lift`, `handler`,
// and the node factories they produce (see builder/module.ts `createNodeFactory`).
// `pattern()` brands `trustedPatterns` instead. Kept as a separate set so the
// pattern-only trust gate (`isTrustedPattern`, used by CFC) is unchanged, while
// `isTrustedBuilderArtifact` accepts any trusted builder output. Like the pattern
// brand, this is the gate that stops `__cf_data`-forged data from acquiring a
// content-addressed `{ identity, symbol }` reference via `__cfReg`.
//
// Held lazily on this hoisted accessor rather than a top-level `const`/`let`:
// unlike `pattern()`, `createNodeFactory` is invoked at MODULE-INIT time by some
// builtins (e.g. builtins/sqlite/query-node), which runs inside the builder
// import cycle — a top-level binding would still be in its temporal dead zone at
// that point. A function declaration IS fully hoisted, so caching the `WeakSet`
// on it sidesteps the init-order dependency entirely.
function trustedBuilderArtifacts(): WeakSet<object> {
  const self = trustedBuilderArtifacts as { set?: WeakSet<object> };
  return (self.set ??= new WeakSet<object>());
}

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
 * True only for a value that is structurally a pattern AND has trusted builder
 * provenance — either it carries the brand directly, or it is a derivation /
 * serialized copy whose `unsafe_originalPattern` chain reaches a branded
 * original. Use this at trust-granting sites; a `__cf_data`-forged pattern-shaped
 * object is `isPattern` but NOT `isTrustedPattern` (it carries no brand, and the
 * `unsafe_originalPattern` symbol is module-private — authored code cannot set
 * it to point at a real pattern).
 */
export function isTrustedPattern(value: unknown): value is Pattern {
  if (!isPattern(value)) return false;
  // Walk the original-pattern chain; a branded ancestor confers trust on copies.
  let current: unknown = value;
  const seen = new Set<unknown>();
  while (
    current && (typeof current === "object" || typeof current === "function")
  ) {
    if (trustedPatterns.has(current as object)) return true;
    if (seen.has(current)) break;
    seen.add(current);
    current = (current as Record<symbol, unknown>)[unsafe_originalPattern];
  }
  return false;
}

/** Stamp a value as produced by a trusted non-pattern builder (lift/handler/…). */
export function brandTrustedBuilderArtifact<T>(value: T): T {
  const key = asKey(value);
  if (key) trustedBuilderArtifacts().add(key);
  return value;
}

/**
 * True for any value with trusted-builder provenance — a trusted pattern OR a
 * branded lift/handler/node-factory — walking the `unsafe_originalPattern` chain
 * so derivation / serialized copies inherit trust. This is the gate that decides
 * whether a `__cfReg`-registered value may receive a content-addressed
 * `{ identity, symbol }` reference; forged plain data carries no brand and is
 * rejected.
 */
export function isTrustedBuilderArtifact(value: unknown): boolean {
  let current: unknown = value;
  const seen = new Set<unknown>();
  while (
    current && (typeof current === "object" || typeof current === "function")
  ) {
    if (
      trustedBuilderArtifacts().has(current as object) ||
      trustedPatterns.has(current as object)
    ) {
      return true;
    }
    if (seen.has(current)) break;
    seen.add(current);
    // Fail closed: reading the (module-private) symbol off an exotic value — e.g.
    // a Proxy with a throwing get trap — must not abort registration/lookup.
    try {
      current = (current as Record<symbol, unknown>)[unsafe_originalPattern];
    } catch {
      return false;
    }
  }
  return false;
}
