import { isRecord } from "@commonfabric/utils/types";
import type { Pattern } from "../builder/types.ts";
import type { Runtime } from "../runtime.ts";

/**
 * Compact reference to a pattern by its content-addressed `{ identity, symbol }`
 * entry ref, used in place of an embedded pattern graph for the `op` input of
 * `map`/`filter`/`flatMap` nodes.
 *
 * The runner substitutes this sentinel for the serialized op graph at node
 * instantiation (see `Runner.substituteOpPatternRefs`), once the op pattern's
 * entry ref is known. Because it is plain data (no symbol keys), it survives the
 * `getImmutableCell` JSON round-trip that strips the in-memory
 * derivation backref — so the builtin reads it back intact and
 * resolves the live canonical pattern without deserializing a graph or mapping
 * functions back by `implementationRef`.
 */
export interface PatternRefSentinel {
  $patternRef: { identity: string; symbol: string };
  /**
   * The embedded op pattern graph, retained as a correctness fallback.
   *
   * The identity fast path resolves the op from the in-memory evaluated-module
   * cache, which is bounded (FIFO) — a long-lived session that evaluates enough
   * other modules can evict an op whose map/filter/flatMap node is still live.
   * Cache residency must therefore be an optimization, not a correctness
   * requirement: on a miss we deserialize this graph instead of hard-failing a
   * running node. (#3898 dropped the session-varying `program.files` from
   * serialized patterns, so retaining the graph no longer reintroduces the
   * cross-reload id churn that motivated passing the op by identity.)
   */
  $opFallback?: Pattern;
}

export function isPatternRefSentinel(
  value: unknown,
): value is PatternRefSentinel {
  if (!isRecord(value)) return false;
  const ref = (value as { $patternRef?: unknown }).$patternRef;
  return isRecord(ref) && typeof ref.identity === "string" &&
    typeof ref.symbol === "string";
}

/**
 * Resolve the `op` value a list builtin (`map`/`filter`/`flatMap`) reads from
 * its inputs cell into a live `Pattern`.
 *
 * - When `op` is a {@link PatternRefSentinel}, resolve it synchronously from the
 *   in-memory cache via `artifactFromIdentitySync` (the fast path: the op's
 *   module is part of the parent pattern's bundle, normally still
 *   live by the time the list Action runs). On a cache miss (the op was evicted
 *   mid-session — a sync Action cannot await `loadPatternByIdentity`), fall back
 *   to the sentinel's retained `$opFallback` graph so a running node never breaks
 *   just because its op rolled out of the bounded cache.
 * - Otherwise (legacy / ESM loader off / no entry ref), `op` is the embedded
 *   pattern graph itself, used as-is.
 */
export function resolveOpPattern(
  runtime: Runtime,
  rawOp: unknown,
  builtinName: string,
): Pattern {
  if (isPatternRefSentinel(rawOp)) {
    const { identity, symbol } = rawOp.$patternRef;
    const resolved = runtime.patternManager.artifactFromIdentitySync(
      identity,
      symbol,
    ) as Pattern | undefined;
    if (resolved) return resolved;
    if (rawOp.$opFallback) return rawOp.$opFallback;
    throw new Error(
      `${builtinName}: op pattern ${identity}#${symbol} is not in the ` +
        `evaluated-module cache and has no embedded fallback`,
    );
  }
  return rawOp as Pattern;
}
