import type { RuntimeProgram } from "../harness/types.ts";
import { isPattern, type Pattern } from "./types.ts";

/**
 * Side-table storage for pattern metadata that is associated *after* a pattern
 * is exported from its module:
 *
 * - `program` — the rehydration source (`RuntimeProgram`) attached by the engine
 *   after compilation/eval and at registration time.
 *
 * This used to live as an own data property (`pattern.program`) on the
 * pattern object. Storing it in a module-level WeakMap instead lets the ESM
 * loader `harden()` exported pattern values at the module boundary: the
 * association is still attached later, but a WeakMap write does not mutate
 * the (now frozen) object. Keyed by `object` (patterns are callable objects),
 * with WeakMap GC semantics so a value's metadata is collected with the
 * value.
 */

const programByPattern = new WeakMap<object, RuntimeProgram>();

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

/** Stamp a value as produced by the trusted `pattern()` builder. */
export function brandTrustedPattern<T>(value: T): T {
  const key = asKey(value);
  if (key) trustedPatterns.add(key);
  return value;
}

// Derivation tracking: `copy → root original`. Replaces the former
// `unsafe_originalPattern` symbol backref. Registered ONLY by trusted-builder
// copy sites (`noteDerivedCopy` callers: build-time graph serialization in
// json-utils, traversal copies in traverse-utils, binding copies in
// pattern-binding, and the `asScope`/`inSpace` factory derivations in
// builder/pattern.ts — the latter reachable from authored pattern code, which
// is sound because both objects are builder-minted and already branded) —
// forged values never enter, since nothing on the
// object itself can establish the link. Module-level (not per-manager): the
// copy sites live in builder-layer utilities with no PatternManager handle,
// and the linked facts (trust brands, content-addressed entry refs) are
// globally meaningful. WeakMap keys are the per-runtime live objects, so
// multiple runtimes in one process cannot collide.
const derivedFrom = new WeakMap<object, object>();

// Content-addressed `{ identity, symbol }` entry ref per live builder
// artifact. Written (first-write-wins) by the PatternManager's indexing of
// evaluated modules (`indexArtifact`, gated on `isTrustedBuilderArtifact`);
// promoted here from the manager so derived copies can resolve refs without a
// manager handle. The reverse index (`addressableByIdentity`, identity → live
// value) stays per-manager — it holds live values per runtime and is bounded.
const entryRefByValue = new WeakMap<
  object,
  { identity: string; symbol: string }
>();

type ArtifactEntryRef = { identity: string; symbol: string };

// These stores are reached by `createNodeFactory()` during the builder import
// cycle, so they use the same hoisted lazy-accessor pattern as the trust set
// above rather than top-level `const` bindings that may still be in TDZ.
function durableEntryRefs(): WeakMap<object, ArtifactEntryRef> {
  const self = durableEntryRefs as {
    map?: WeakMap<object, ArtifactEntryRef>;
  };
  return (self.map ??= new WeakMap<object, ArtifactEntryRef>());
}

function factoryRootTokens(): WeakMap<object, object> {
  const self = factoryRootTokens as { map?: WeakMap<object, object> };
  return (self.map ??= new WeakMap<object, object>());
}

function durableRefsByRootToken(): WeakMap<object, ArtifactEntryRef> {
  const self = durableRefsByRootToken as {
    map?: WeakMap<object, ArtifactEntryRef>;
  };
  return (self.map ??= new WeakMap<object, ArtifactEntryRef>());
}

/**
 * Resolve a (possibly derived) value to its root original. Identity for
 * values that were never copied. Bounded: the chain is a tree toward the
 * root original (copies are fresh objects), but guard against cycles anyway.
 */
export function resolveOriginal<T>(value: T): T {
  let current = asKey(value);
  if (!current) return value;
  const seen = new Set<object>();
  while (true) {
    const next = derivedFrom.get(current);
    if (!next || next === current || seen.has(next)) break;
    seen.add(current);
    current = next;
  }
  return current as T;
}

/**
 * Record that `copy` is a derivation/serialized copy of `original`, carrying
 * its identity facts forward:
 *
 * - trust propagates EAGERLY (sound: builders brand their artifacts at
 *   creation time, before any copy can be made);
 * - the entry ref propagates eagerly when already known, but lookups still
 *   walk `derivedFrom` lazily ({@link getArtifactEntryRef}) because refs are
 *   indexed only post-evaluation — AFTER build-time copies were made.
 *
 * Only runner-owned copy sites may call this; it is the sole way a copy can
 * inherit trust, so forged values (which are never passed here with a trusted
 * original) gain nothing.
 */
export function noteDerivedCopy(copy: unknown, original: unknown): void {
  const c = asKey(copy);
  const o = asKey(original);
  if (!c || !o || c === o) return;
  const root = resolveOriginal(o);
  derivedFrom.set(c, root);
  if (trustedPatterns.has(root)) trustedPatterns.add(c);
  if (trustedBuilderArtifacts().has(root)) trustedBuilderArtifacts().add(c);
  const ref = entryRefByValue.get(root);
  if (ref && !entryRefByValue.has(c)) entryRefByValue.set(c, ref);
  const durableRef = durableEntryRefs().get(root);
  if (durableRef && !durableEntryRefs().has(c)) {
    durableEntryRefs().set(c, durableRef);
  }
  const rootToken = factoryRootTokens().get(root);
  if (rootToken) factoryRootTokens().set(c, rootToken);
}

/**
 * Associate a content-addressed `{ identity, symbol }` entry ref with a live
 * builder artifact. First write wins (an artifact may be reachable under
 * several symbols; the first registration is canonical, matching the
 * pre-existing `valueToEntryRef` semantics).
 */
export function setArtifactEntryRef(
  value: unknown,
  ref: { identity: string; symbol: string },
): void {
  const key = asKey(value);
  if (key && !entryRefByValue.has(key)) entryRefByValue.set(key, ref);
}

/**
 * Bind a live builder callable to its stable runner-private factory root token.
 * Modifier and later traversal derivations bind the same token explicitly.
 */
export function bindFactoryRootToken(value: unknown, rootToken: object): void {
  const key = asKey(value);
  if (!key) return;
  const tokens = factoryRootTokens();
  // Do not call resolveOriginal() here: module-init node factories reach this
  // function while the builder import cycle is still evaluating and its
  // `derivedFrom` store may remain in TDZ. Trusted constructors pass the shared
  // token explicitly, so exact-key binding is sufficient at this seam.
  const existing = tokens.get(key);
  if (existing !== undefined && existing !== rootToken) {
    throw new Error("Factory derivation cannot change its root token");
  }
  tokens.set(key, rootToken);

  const durableRef = durableEntryRefs().get(key);
  if (durableRef !== undefined) {
    durableRefsByRootToken().set(rootToken, durableRef);
  }
}

/**
 * Record a verified content-addressed export/`__cfReg` ref. Unlike the legacy
 * session ref channel, this fact may unlock durable Factory@1 sealing.
 */
export function setDurableArtifactEntryRef(
  value: unknown,
  ref: ArtifactEntryRef,
): void {
  setArtifactEntryRef(value, ref);
  const key = asKey(value);
  if (!key) return;
  const refs = durableEntryRefs();
  if (!refs.has(key)) refs.set(key, ref);
  const root = resolveOriginal(key) as object;
  const rootToken = factoryRootTokens().get(key) ??
    factoryRootTokens().get(root);
  if (rootToken !== undefined && !durableRefsByRootToken().has(rootToken)) {
    durableRefsByRootToken().set(rootToken, ref);
  }
}

/** Durable ref associated with a shared factory root token, if verified. */
export function getDurableArtifactRefForRootToken(
  rootToken: object,
): ArtifactEntryRef | undefined {
  return durableRefsByRootToken().get(rootToken);
}

/**
 * The content-addressed `{ identity, symbol }` entry ref for a value — the
 * exact object first, then its root original (a copy made before the ref was
 * indexed resolves through the derivation link).
 */
export function getArtifactEntryRef(
  value: unknown,
): { identity: string; symbol: string } | undefined {
  const key = asKey(value);
  if (!key) return undefined;
  return entryRefByValue.get(key) ??
    entryRefByValue.get(resolveOriginal(key) as object);
}

/**
 * True only for a value that is structurally a pattern AND has trusted builder
 * provenance — either it carries the brand directly, or it is a derivation /
 * serialized copy registered via {@link noteDerivedCopy} (which propagates the
 * brand eagerly). A `__cf_data`-forged pattern-shaped object is `isPattern`
 * but NOT `isTrustedPattern`: no own property can grant trust (the brand and
 * derivation link live in runner-private WeakSets/WeakMaps), and forged values
 * never reach `noteDerivedCopy` with a trusted original.
 */
export function isTrustedPattern(value: unknown): value is Pattern {
  if (!isPattern(value)) return false;
  const key = asKey(value);
  if (!key) return false;
  return trustedPatterns.has(key) ||
    trustedPatterns.has(resolveOriginal(key) as object);
}

/** Stamp a value as produced by a trusted non-pattern builder (lift/handler/…). */
export function brandTrustedBuilderArtifact<T>(value: T): T {
  const key = asKey(value);
  if (key) trustedBuilderArtifacts().add(key);
  return value;
}

/**
 * True for any value with trusted-builder provenance — a trusted pattern OR a
 * branded lift/handler/node-factory — including derivation / serialized
 * copies registered via {@link noteDerivedCopy}. This is the gate that decides
 * whether a `__cfReg`-registered value may receive a content-addressed
 * `{ identity, symbol }` reference; forged plain data carries no brand and is
 * rejected. Pure WeakSet/WeakMap probes — no property reads, so exotic values
 * (e.g. a Proxy with a throwing get trap) cannot abort registration/lookup.
 */
export function isTrustedBuilderArtifact(value: unknown): boolean {
  const key = asKey(value);
  if (!key) return false;
  if (trustedBuilderArtifacts().has(key) || trustedPatterns.has(key)) {
    return true;
  }
  const root = resolveOriginal(key) as object;
  return trustedBuilderArtifacts().has(root) || trustedPatterns.has(root);
}
