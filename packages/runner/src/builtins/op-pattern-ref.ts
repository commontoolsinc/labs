import { isRecord } from "@commonfabric/utils/types";
import { isPattern, type Pattern } from "../builder/types.ts";
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
 *
 * The sentinel carries NO embedded fallback graph (identity E4): the artifact
 * index is session-lifetime, and the sentinel is stamped from the op's live
 * artifact in the same session that reads it back, so sync resolution cannot
 * miss short of a bug. (Sentinels of the earlier `$opFallback`-carrying
 * vintage are still read tolerantly — see {@link resolveStoredPattern}.)
 */
export interface PatternRefSentinel {
  $patternRef: { identity: string; symbol: string };
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
 * - When `op` is a {@link PatternRefSentinel}, resolve it synchronously from
 *   the session-lifetime artifact index via `artifactFromIdentitySync` — the
 *   op's module evaluated in this session by construction (the sentinel was
 *   stamped from its live artifact at node instantiation).
 * - A stored pattern VALUE reaching `op` (pattern-as-argument) resolves the
 *   same way when its module evaluated this session, else from the graph the
 *   value itself carries (E3-and-earlier vintages). A bare ref from a module
 *   that never evaluated here throws — loud, since a sync Action cannot await
 *   the storage-backed `loadPatternByIdentity`.
 * - Otherwise (no entry ref known at instantiation), `op` is the embedded
 *   pattern graph itself, used as-is.
 */
export function resolveOpPattern(
  runtime: Runtime,
  rawOp: unknown,
  builtinName: string,
): Pattern {
  const resolved = resolveStoredPattern(runtime, rawOp);
  if (resolved === undefined && isPatternRefSentinel(rawOp)) {
    throw new Error(
      `${builtinName}: op pattern ${rawOp.$patternRef.identity}#` +
        `${rawOp.$patternRef.symbol} did not evaluate in this session and ` +
        `carries no graph`,
    );
  }
  return resolved as Pattern;
}

/**
 * Resolve a pattern VALUE read raw from a cell into a runnable `Pattern`.
 *
 * Boundary-serialized pattern values carry `$patternRef`: prefer resolving the
 * LIVE canonical pattern by identity — it carries the trust brand and
 * content-addressed entry ref a deserialized graph lacks — then fall back to
 * a graph the value still carries (stored vintages: the E3 dual-write graph
 * alongside the ref, or a pre-E4 sentinel's `$opFallback`). A bare
 * unresolvable ref yields `undefined`; callers with an async context follow
 * up with `loadPatternByIdentity` (compiled artifacts persist in-space as part
 * of compilation), sync callers fail loudly. Any other value passes through
 * unchanged (legacy stored graphs).
 */
export function resolveStoredPattern(
  runtime: Runtime,
  raw: unknown,
): Pattern | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (isPatternRefSentinel(raw)) {
    const { identity, symbol } = raw.$patternRef;
    const resolved = runtime.patternManager.artifactFromIdentitySync(
      identity,
      symbol,
    ) as Pattern | undefined;
    if (resolved) return resolved;
    const vintageFallback = (raw as { $opFallback?: Pattern }).$opFallback;
    if (vintageFallback) return vintageFallback;
    if (isPattern(raw)) return raw as unknown as Pattern;
    return undefined;
  }
  return raw as Pattern;
}
