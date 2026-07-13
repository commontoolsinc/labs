import { isRecord } from "@commonfabric/utils/types";
import type { Pattern } from "../builder/types.ts";
import type { MemorySpace } from "../cell.ts";
import type { Runtime } from "../runtime.ts";

/**
 * Compact reference to a pattern by its content-addressed `{ identity, symbol }`
 * entry ref, used in place of an embedded pattern graph anywhere a pattern is
 * bound as a value — the `op` input of `map`/`filter`/`flatMap` nodes, a
 * directly-invoked sub-pattern node, or a pattern passed as an argument.
 *
 * Binding substitutes this sentinel for the embedded pattern graph, once the
 * pattern's entry ref is known: see `convert` in `pattern-binding.ts`
 * (`unwrapOneLevelAndBindtoDoc`). Because it is plain data (no symbol keys), it
 * survives the `getImmutableCell` JSON round-trip that strips the in-memory
 * derivation backref — so the builtin/runner reads it back intact and
 * resolves the live canonical pattern directly by its `{ identity, symbol }`
 * entry ref, without deserializing a graph or remapping functions through a
 * serialized reference.
 *
 * The sentinel carries NO embedded fallback graph (identity E4): the artifact
 * index is session-lifetime, and the sentinel is stamped from the op's live
 * artifact in the same session that reads it back, so sync resolution cannot
 * miss short of a bug.
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
 *   same way when its module evaluated this session; a ref from a module that
 *   never evaluated here throws — loud, since a sync Action cannot await the
 *   storage-backed `loadPatternByIdentity`.
 * - Otherwise `op` is an embedded pattern graph, used as-is. Post-CT-1812
 *   this is ONLY the stored-keyless remnant: a live op whose original is a
 *   trusted builder pattern gets a `keyless:` identity minted at node
 *   instantiation (`Runner.substituteOpKeylessPatternRef`) and arrives here
 *   as a sentinel; what still arrives embedded is a graph deserialized
 *   from a
 *   stored no-entry-ref pattern VALUE (the live keyless writer path pinned
 *   by stored-pattern-rehydration.test.ts), for which no pristine artifact
 *   exists to resolve instead. CT-1812 residual: for THAT form, a nested
 *   grandchild's derived-internal output aliases remain defer-corrupted by
 *   the immutable-cell round-trip — re-rooting a bare stored graph without
 *   binding is the open surgery recorded on the ticket.
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
 * Boundary-serialized pattern values carry `$patternRef`: resolve the LIVE
 * canonical pattern by identity — it carries the trust brand and
 * content-addressed entry ref a deserialized graph lacks. An unresolvable ref
 * yields `undefined`; callers with an async context follow up with
 * `loadPatternByIdentity` (compiled artifacts persist in-space as part of
 * compilation), sync callers fail loudly. A plain graph passes through
 * unchanged — the live serialization for patterns with no entry ref
 * (manually constructed / dynamic / bare-Engine evaluation).
 */
export function resolveStoredPattern(
  runtime: Runtime,
  raw: unknown,
): Pattern | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (isPatternRefSentinel(raw)) {
    const { identity, symbol } = raw.$patternRef;
    return runtime.patternManager.artifactFromIdentitySync(
      identity,
      symbol,
    ) as Pattern | undefined;
  }
  return raw as Pattern;
}

/**
 * {@link resolveStoredPattern} with the async net for refs-only stored values
 * whose module never evaluated in this session: load it by identity from the
 * space's persisted compiled artifacts (compilation persists them in-space as
 * an expected invariant). The usual caller is llm-dialog's tool invocation —
 * a stored toolDef pattern is normally in-session live (whatever defined the
 * tool mentioned the pattern, so its module rode that bundle), but a tool
 * invoked cold after a reload may reach for storage.
 */
export async function resolveStoredPatternAsync(
  runtime: Runtime,
  raw: unknown,
  space: MemorySpace,
): Promise<Pattern | undefined> {
  const resolved = resolveStoredPattern(runtime, raw);
  if (resolved !== undefined || !isPatternRefSentinel(raw)) return resolved;
  const { identity, symbol } = raw.$patternRef;
  return await runtime.patternManager.loadPatternByIdentity(
    identity,
    symbol,
    space,
  );
}
