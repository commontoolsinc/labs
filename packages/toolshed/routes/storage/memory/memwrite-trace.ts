/**
 * Gated diagnostic trace for writes hitting the v2 memory route.
 *
 * Off by default. Enable with `CF_DEBUG_MEMORY_WRITES=1`. Each emitted line
 * attributes one write to a specific client connection via `c=<n>` — the lever
 * that makes cross-client write storms diagnosable (e.g. whether two divergent
 * link targets for the same shared cell come from two distinct clients each
 * minting a different id, vs. one client alternating between branches).
 *
 * Values are summarized as a stable content hash (`vhash`) only. To additionally
 * dump raw values (`val=`), set `CF_DEBUG_MEMORY_WRITE_VALUES=1` — AVOID on real
 * data: cell values can contain user content, PII, or secrets. The hash alone is
 * enough to tell "same value" from "different value", which is all a divergence
 * investigation needs.
 *
 * This module holds the pure formatting so it is unit-testable; the impure parts
 * (env reads, per-connection counter, message parsing) live in the route.
 */

/** A single operation from a parsed memory commit. */
export interface MemWriteOp {
  op?: string;
  id?: unknown;
  scope?: unknown;
  /** Present for `set`/`delete`; absent for `patch` (value lives in `patches`). */
  value?: unknown;
  /** JSON-patch entries for `patch` ops, each `{ path, value, ... }`. */
  patches?: unknown;
}

/**
 * Deterministic JSON with object keys sorted, so equal content always renders
 * the same regardless of key insertion order (the very thing that diverged in
 * the fresh-vs-resume storm). Stable across runs and processes. Cycles render as
 * `"[circular]"`; anything unserializable falls back to `String(value)`.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x;
    if (seen.has(x as object)) return "[circular]";
    seen.add(x as object);
    if (Array.isArray(x)) return x.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>).sort()) {
      out[k] = walk((x as Record<string, unknown>)[k]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(value)) ?? "undefined";
  } catch {
    return String(value);
  }
}

/** FNV-1a/32 of a string as 8 hex chars. Stable across runs and processes. */
export function memwriteHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Sentinel `vhash` for an operation that carries no value (e.g. `delete`). */
const NO_VALUE_HASH = "--------";

/**
 * Format one memory-commit operation as a single `[memwrite]` trace line.
 *
 * @param connId per-connection ordinal (`c=`), so a storm's writes can be
 *   attributed to specific clients.
 * @param includeValues when true, append the raw value (`val=`, truncated).
 *   Off by default — see the module-level privacy note.
 */
export function formatMemWriteTrace(
  op: MemWriteOp,
  connId: number,
  includeValues: boolean,
): string {
  // For `set`/`delete` the written value is `op.value`; for `patch` it lives in
  // the JSON-patch entries and `op.value` is absent. Summarize whichever is
  // present so a patch's value isn't silently dropped.
  const valueSource = op.patches !== undefined ? op.patches : op.value;
  const hasValue = valueSource !== undefined;
  const canon = hasValue ? stableStringify(valueSource) : "";
  const vhash = hasValue ? memwriteHash(canon) : NO_VALUE_HASH;
  const paths = Array.isArray(op.patches)
    ? op.patches
      .map((p) => (p as { path?: unknown } | null)?.path)
      .filter((p) => p !== undefined)
      .slice(0, 4)
      .join(",")
    : "";
  const base = `[memwrite] c=${connId} op=${op.op} id=${
    String(op.id).slice(0, 28)
  } scope=${op.scope ?? "(space)"} vhash=${vhash} paths=[${paths}]`;
  return includeValues ? `${base} val=${canon.slice(0, 600)}` : base;
}
