/**
 * Pattern → ROG extraction (W0.4, first pass).
 *
 * Normalizes the in-memory serialized `Pattern` ({argumentSchema, resultSchema,
 * derivedInternalCells, result, nodes}) into the flat ROG vocabulary
 * (`rog.ts`). This is a **classifier + structural mapper with an honest coverage
 * report** — not a complete, fully-wired extraction. It exists to (a) prove the
 * normalization approach against real builder output and (b) MEASURE precisely
 * how much of the corpus maps cleanly into the ROG vocabulary, so the remaining
 * wiring work (W1 inputs) is quantified, not guessed.
 *
 * What it handles: module-kind classification (ref builtins → collection /
 * control / effect / leaf; javascript → leaf; pattern → pattern), result +
 * input `$alias` → ValueRef for the recognized alias forms (argument / internal
 * / generated), and recursion into collection element ops. What it does NOT yet
 * do: resolve every internal-cell alias to its producing op (internal→opOut),
 * nested-construct templates, or the full label-structure hints. Those land with
 * W1; the coverage report lists what was not recognized.
 */

import type {
  CollectionOp,
  ControlOp,
  EffectSink,
  ImplRef,
  Op,
  OpId,
  OpKind,
  PathStep,
  Rog,
  ValueRef,
} from "./rog.ts";
import type { LeafImpl } from "./interpret.ts";
import { isLegacyAlias } from "../link-types.ts";

// The in-memory Pattern shape we read (a structural subset; see builder/types).
interface RawModule {
  type?: string;
  /** For `type: "ref"` this is the builtin name (string). For an in-memory
   * `type: "javascript"` module it is the *live implementation function* (the
   * lift body); once serialized it is the source-string form instead. We accept
   * either and only treat the callable form as a resolvable leaf impl. */
  implementation?: string | ((input: unknown) => unknown);
  $implRef?: { identity: string; symbol: string };
  $patternRef?: { identity: string; symbol: string };
  argumentSchema?: unknown;
  resultSchema?: unknown;
  /** Set to `true` on a `type:"javascript"` module the builder marks as an
   * effect (side-effecting, not a value computation). A module carrying
   * `isEffect:true` is NOT a pure value-leaf. (Note: the registry-level
   * `isEffect` of effect *builtins* like llm/sqlite is NOT propagated onto the
   * in-memory `type:"ref"` module object — the builder-side `ref` factories in
   * builder/built-in.ts emit only `{type:"ref", implementation:<name>}`. Those
   * effect/stream/async builtins are instead classified by their ref NAME via
   * `EFFECT_REFS` below; the ref-branch `isEffect` check is a fail-closed
   * backstop for any ref that does happen to carry the marker.) */
  isEffect?: boolean;
  /** A `type:"javascript"` module built by `cf.handler` carries `wrapper:
   * "handler"` (builder/module.ts). A handler is an EVENT-STREAM SINK, not a
   * pure value computation: applying it produces a stream link the result
   * references. Interpreting it as a pure leaf evaluates the handler body and
   * silently DROPS the stream — so it must NOT classify as `leaf`. */
  wrapper?: "handler";
}
interface RawNode {
  module?: RawModule | RawPattern;
  inputs?: unknown;
  outputs?: unknown;
}
interface RawPattern {
  argumentSchema?: unknown;
  resultSchema?: unknown;
  result?: unknown;
  nodes?: RawNode[];
}

const COLLECTION_OPS = new Set(["map", "filter", "flatMap"]);
const CONTROL_OPS = new Set(["ifElse", "when", "unless"]);
// Effect / stream / async ref builtins, named explicitly so a top-level use as
// a value computation classifies as `effect` → `ineligible_opkind` (fail closed
// BY NAME, not via the incidental `unresolved_leaf` gate). These all do I/O,
// produce streams, or write results back asynchronously — none is a pure value
// leaf. The names are the registered builtin refs (the `implementation` string
// each `createNodeFactory({type:"ref", implementation})` carries in
// builder/built-in.ts, matching the `addModuleByRef` keys in builtins/index.ts).
// Pure builtins (str, …) are deliberately NOT listed — they stay `leaf`.
const EFFECT_REFS = new Set([
  "navigateTo",
  "streamData",
  "llm",
  "llmDialog",
  "generateText",
  "generateObject",
  "fetchData",
  "fetchProgram",
  "compileAndRun",
  "sqliteQuery",
  "sqliteDatabase",
  "wish",
]);

export interface CoverageReport {
  /** Total nodes seen (this graph + nested element graphs). */
  nodes: number;
  /** Nodes whose module classified into a known OpKind. */
  classified: number;
  /** Per-kind counts. */
  byKind: Record<OpKind | "unknown", number>;
  /** Distinct `$alias` shapes that were NOT recognized (for follow-up). Shared
   * across the whole recursion (top frame + every nested sub-pattern frame). */
  unrecognizedAliases: string[];
  /** The subset of `unrecognizedAliases` recorded while extracting the TOP frame
   * (`depth === 0`). A nested sub-pattern frame's serialized aliases legitimately
   * carry cross-frame `defer`s the outer frame cannot resolve locally — those
   * pollute `unrecognizedAliases` but are validated independently when the child
   * re-dispatches (§4.7). The runner gates the OUTER pattern only on THIS set so a
   * nested-frame cross-frame indirection does not spuriously fall the outer
   * pattern back; a genuine top-frame alias problem still fails closed. */
  topFrameUnrecognizedAliases: string[];
  /** Nested element graphs recursed into. */
  nested: number;
}

function isPatternLike(m: unknown): m is RawPattern {
  return !!m && typeof m === "object" && Array.isArray((m as RawPattern).nodes);
}

function classifyModule(
  module: RawModule | RawPattern | undefined,
): {
  kind: OpKind;
  impl?: ImplRef;
  collOp?: CollectionOp;
  ctrlOp?: ControlOp;
  /** For an `effect` kind: distinguish an I/O-builtin DATAFLOW producer
   * (`fetchData`/`generateText`/`llm`/`sqliteQuery` — output is a tracked result
   * cell a downstream segment reads, NOT a `$ctx` side-effect write) from an
   * event-stream HANDLER sink (`cf.handler` / `isEffect` javascript). The F4
   * write-back-cycle gate fires only for the latter (07 §4.7). */
  effectSink?: EffectSink;
} {
  if (isPatternLike(module)) return { kind: "pattern" };
  const m = (module ?? {}) as RawModule;
  if (m.$patternRef) return { kind: "pattern", impl: m.$patternRef };
  if (m.type === "pattern") return { kind: "pattern", impl: m.$patternRef };
  if (m.type === "javascript") {
    // FAIL CLOSED: a `type:"javascript"` module is a PURE value-leaf ONLY when
    // it carries NO effect markers. The two markers that make it non-pure are
    // readable directly on the in-memory module object:
    //   - `wrapper === "handler"`: a `cf.handler` node. It is an event-stream
    //     SINK — applying it yields a stream link the pattern result references.
    //     Evaluating its body as a pure leaf SILENTLY DROPS that stream (legacy
    //     emits `{increment:<stream link>}`, a leaf-interpretation emits `{}`).
    //   - `isEffect === true`: a `type:"javascript"` module the builder marked
    //     as an effect (side-effecting, not a value computation).
    // Either marker → classify as `effect` → ineligible (effect is not in the
    // runner's ELIGIBLE_KINDS, and `byKind.effect>0` trips the collection and
    // nested-pattern coverage gates) → legacy fallback, which models the stream.
    // A bare lift/computed/derive/str-lowered module (no wrapper, no isEffect)
    // is the genuine pure leaf and stays `leaf` so real coverage is preserved.
    if (m.wrapper === "handler" || m.isEffect === true) {
      // A `cf.handler` / `isEffect` javascript node is an EVENT-STREAM SINK (its
      // application produces a stream link / `$ctx` side-effect write), not an
      // I/O dataflow producer → handler sink (F4 cycle gate applies).
      return { kind: "effect", effectSink: "handler" };
    }
    return { kind: "leaf", impl: m.$implRef };
  }
  if (m.type === "ref") {
    // A `ref` module's implementation is the builtin name (always a string).
    const ref = typeof m.implementation === "string" ? m.implementation : "";
    if (COLLECTION_OPS.has(ref)) {
      return { kind: "collection", collOp: ref as CollectionOp };
    }
    if (CONTROL_OPS.has(ref)) {
      return { kind: "control", ctrlOp: ref as ControlOp };
    }
    if (EFFECT_REFS.has(ref)) {
      // `navigateTo`/`streamData` write a stream/navigation SINK (no consumable
      // dataflow result); the rest (`fetchData`/`generateText`/`llm*`/`sqlite*`/
      // `wish`/`fetchProgram`/`compileAndRun`) are I/O DATAFLOW PRODUCERS whose
      // output result cell a downstream segment legitimately reads (a sound
      // `bnd→seg` edge, NOT a write-back cycle). Distinguish so the F4 gate fires
      // only for the sink forms (07 §4.7).
      const sinkOnly = ref === "navigateTo" || ref === "streamData";
      return { kind: "effect", effectSink: sinkOnly ? "handler" : "io" };
    }
    // A ref module the builder marked as an effect (`raw(..., {isEffect:true})`
    // lowerings may surface it on the in-memory module) is a side-effecting /
    // stream-producing builtin — fail closed to `effect`, never an opaque leaf.
    if (m.isEffect === true) return { kind: "effect", effectSink: "handler" };
    // Other PURE builtins (str, …) are opaque value leaves.
    return { kind: "leaf" };
  }
  // Non-javascript / non-ref module types (`raw`, `isolated`, `passthrough`) are
  // NOT provably pure value-leaves. A `type:"javascript"` leaf is the only shape
  // whose pure-ness we can read off the module; anything else fails closed to
  // `effect` so an unmodeled side-effecting/stream-bearing module is rejected by
  // the eligibility gates rather than silently mis-evaluated as a pure leaf.
  // Fail closed to the HANDLER sink (the F4 gate applies — we cannot prove the
  // unknown module's output is a consumable dataflow value).
  return { kind: "effect", effectSink: "handler" };
}

/** Map a `partialCause` (the opaque derived-internal-cell identity, an arbitrary
 * `JSONValue`) to the STABLE STRING NAME the interpreter keys internal cells by.
 *
 * The legacy binding layer matches a `partialCause` alias to its
 * `derivedInternalCells` descriptor via `deepEqual` (pattern-binding.ts), so the
 * cause can be ANY JSON value. The interpreter only needs a deterministic,
 * collision-free string KEY for its `internalToOp` / `internalCellAliasByName`
 * maps — the ORIGINAL `partialCause` payload is carried separately wherever the
 * binding layer is invoked (so deepEqual still matches the real descriptor).
 *
 * Two legacy forms keep their HISTORICAL names verbatim so already-engaged
 * patterns are unchanged:
 *   - a `string` cause `"foo"` → `"foo"`
 *   - a `{$generated:N}` cause → `"$generated:N"`
 * Every OTHER JSON cause (the common builder `[label, counterId]` tuple, e.g.
 * `["normalizedValue", 4]`, or any object cause) is namespaced under `$cause:`
 * with a canonical JSON encoding. The `$cause:` prefix cannot collide with a bare
 * string name, and the canonical JSON cannot collide with `$generated:N` (which
 * is emitted only for the `{$generated:N}` form). Returns null only for an absent
 * cause (the caller then tries `cell:"argument"` / fails closed). */
export function partialCauseToInternalName(
  partialCause: unknown,
): string | null {
  if (partialCause === undefined) return null;
  if (typeof partialCause === "string") return partialCause;
  if (
    partialCause && typeof partialCause === "object" &&
    "$generated" in (partialCause as object)
  ) {
    return `$generated:${(partialCause as { $generated: number }).$generated}`;
  }
  // The `["__patternResult", <field>]` cause is the transformer's RESULT-CELL
  // PROJECTION marker (ts-transformers PATTERN_RESULT_CAUSE), NOT a derived
  // internal cell with a producing compute op. The interpreter handles the
  // pattern result via the preserved result tree, not as a named internal cell;
  // naming it would (a) wrongly wire a `map` node's result-projection output into
  // `internalToOp` — flipping the deferred COLLECTION probe's bare-map-output
  // detection and bypassing the legacy `$patternRef` sentinel path — and (b) name
  // a cell no compute op produces. Leave it UNRECOGNIZED (null) so both paths
  // behave exactly as before this normalization. (No engaged scalar/partition
  // pattern in the corpus carries a `__patternResult` cause; collections are
  // INC3.)
  if (
    Array.isArray(partialCause) && partialCause[0] === "__patternResult"
  ) {
    return null;
  }
  // General JSON cause (array tuple / object). Canonical, namespaced key.
  return `$cause:${JSON.stringify(partialCause)}`;
}

/** Map a single `$alias` payload to a ValueRef, or null if unrecognized.
 *
 * `expectedDefer` is the recursion depth of the (sub-)Rog this alias lives in
 * (0 = top-level). The builder increments `defer` once per nesting level it
 * serializes an alias through (builder/json-utils.ts:87-98), so an alias that
 * resolves to ITS OWN frame carries `defer === depth` at depth `d` (empirically
 * confirmed: a 2-level nest carries defer 0/1/2 at depths 0/1/2). Within the
 * sub-Rog's own frame that alias is a LOCAL (level-0-relative) reference, so we
 * treat `defer === expectedDefer` as resolvable and strip the level. */
function aliasToValueRef(
  alias: Record<string, unknown>,
  unrecognized: Set<string>,
  expectedDefer: number,
): ValueRef | null {
  // FAIL CLOSED on an UNEXPECTED `defer` level. At depth `d` a local alias (one
  // pointing at this frame's own argument/internal) carries `defer === d`. Any
  // OTHER defer level means the alias resolves through a DIFFERENT number of
  // nested-pattern indirections than this frame models — resolving it as if it
  // were local would silently point at the WRONG cell (not a throw, so the
  // eligibility probe would not catch it). Record it as unrecognized so the
  // pattern falls back to the legacy path, which handles deferred resolution.
  //
  // At the top level (`expectedDefer === 0`) a `defer`-bearing alias is the
  // serialized / cross-frame indirection that must fail closed — preserving the
  // original top-level contract (`defer` absent or 0 = local).
  //
  // NOTE on `scope`: the fresh in-memory builder attaches `scope` to ordinary
  // top-level argument/internal aliases (builder/pattern.ts:349) at the
  // ELIGIBLE tier; that scope is the ambient/default frame the interpreter
  // already resolves against, and the prod-wire oracle confirms those patterns
  // interpret correctly. Failing closed on `scope` would regress real eligible
  // patterns, so we do NOT — only an UNEXPECTED `defer` is the unmodeled,
  // production-reachable indirection that must fail closed here.
  // Type-agnostic: any `defer` that is not exactly the expected number fails
  // closed (the builder only ever emits it as a number `(defer ?? 0) + 1`, but a
  // hand-built / arbitrarily serialized alias could carry a non-number `defer`
  // — that too must not be resolved as local).
  const localDefer = expectedDefer === 0
    ? !("defer" in alias) || alias.defer === 0
    : alias.defer === expectedDefer;
  if (!localDefer) {
    unrecognized.add(JSON.stringify(Object.keys(alias).sort()));
    return null;
  }
  const path = ((alias.path as string[]) ?? []).map(String);
  if (alias.cell === "argument") return { kind: "argument", path };
  // Any `partialCause` (string, `{$generated:N}`, or a general JSON cause such as
  // the builder's `[label, counterId]` tuple) names a derived internal cell. We
  // key it by the SAME stable name `outputInternalName` uses, so a result/input
  // `internal` ref lines up with its producing node's output cell.
  if ("partialCause" in alias) {
    const name = partialCauseToInternalName(alias.partialCause);
    if (name !== null) return { kind: "internal", name, path };
  }
  unrecognized.add(JSON.stringify(Object.keys(alias).sort()));
  return null;
}

/** Marker recorded into `unrecognized` for a value that bears a `$alias` key but
 * is NOT a canonical legacy alias (non-record / non-array-path payload) or that
 * mixes `$alias` with sibling keys. Either makes the value unrepresentable as a
 * structured input. Recorded → the pattern is ineligible → legacy fallback. */
const MALFORMED_ALIAS_MARKER = '["$alias:malformed"]';

/** Marker recorded into `unrecognized` for a node whose OUTPUT aliases an
 * ARGUMENT cell (`{$alias:{cell:"argument",path:[...]}}`) — i.e. the node writes
 * its computed value BACK into the argument cell (which the pattern result then
 * aliases). This is a reactive side effect, not pure compute: the synthetic
 * interpreter node has no per-output write-back machinery (it only `sendResult`s
 * the single `$ri-result`), so the write-back would be silently dropped and the
 * result (aliasing the arg cell) would read `{}`. Recorded → the runner maps it
 * to the `argument_writeback` fallback reason → legacy path. Kept distinct from
 * `MALFORMED_ALIAS_MARKER` so the census attributes it precisely. */
const ARGUMENT_WRITEBACK_MARKER = '["$output:argument-writeback"]';

/** True iff the `unrecognized` report carries the argument-writeback marker, so
 * the runner can map it to the dedicated `argument_writeback` fallback reason
 * (vs the generic `unrecognized_alias`). Exported for the runner's gate. */
export function hasArgumentWritebackMarker(
  unrecognizedAliases: readonly string[],
): boolean {
  return unrecognizedAliases.includes(ARGUMENT_WRITEBACK_MARKER);
}

/** True iff `obj` has a `$alias` own-key AND at least one OTHER own-key. Such an
 * object is not a representable structured input: resolving the alias would
 * silently discard the siblings. */
function hasAliasMixedWithSiblings(obj: Record<string, unknown>): boolean {
  if (!Object.hasOwn(obj, "$alias")) return false;
  for (const k of Object.keys(obj)) {
    if (k !== "$alias") return true;
  }
  return false;
}

/** Best-effort: pull the first recognizable ValueRef out of a value/alias tree.
 * Scalars become `const`; a canonical `$alias` payload becomes the recognized
 * ValueRef (or null + an `unrecognized` entry). A value that bears a `$alias`
 * key but is NOT canonical — a malformed payload (e.g. `{$alias:"str"}`,
 * `{$alias:null}`) or `$alias` mixed with sibling keys — is RECORDED into
 * `unrecognized` and returns null (never collapsed to const/partial construct).
 * A plain *structured* (object/array) value with no `$alias` key returns null
 * WITHOUT recording — `buildStructuredRef` handles those recursively and is
 * responsible for recording any leaf it cannot represent. */
function valueToRef(
  v: unknown,
  unrecognized: Set<string>,
  expectedDefer: number,
): ValueRef | null {
  if (v === null || typeof v !== "object") {
    return { kind: "const", value: v };
  }
  const obj = v as Record<string, unknown>;
  // Canonical legacy alias (sole concern of the interpreter): a record bearing
  // `$alias` whose payload is itself a record with an array `path`. Use the
  // SAME predicate the rest of the runtime uses so we never diverge.
  if (isLegacyAlias(v)) {
    // A canonical alias mixed with sibling keys is still not a representable
    // single structured input — resolving it would drop the siblings.
    if (hasAliasMixedWithSiblings(obj)) {
      unrecognized.add(MALFORMED_ALIAS_MARKER);
      return null;
    }
    return aliasToValueRef(
      obj.$alias as Record<string, unknown>,
      unrecognized,
      expectedDefer,
    );
  }
  // Bears a `$alias` key but is NOT a canonical alias (truthy non-record /
  // missing-or-non-array path, e.g. `{$alias:"str"}`, `{$alias:null}`,
  // `{$alias:{}}`). Unrepresentable — record, do not collapse.
  if (Object.hasOwn(obj, "$alias")) {
    unrecognized.add(MALFORMED_ALIAS_MARKER);
    return null;
  }
  return null; // structured input (object/array of refs) — see buildStructuredRef
}

/**
 * Reconstruct an arbitrary input value tree into a SINGLE ValueRef, LOSSLESSLY.
 *
 * Legacy passes a leaf ONE resolved structured value (`{a:<v>, b:<v>}` for
 * `add({a,b})`). The ROG has no "structured" ValueRef kind, so we synthesize a
 * `construct` op (object/array assembly) and reference its output — the same
 * representation the pattern result uses. This way the leaf receives the exact
 * keyed object/array legacy passes, not a positional alias list.
 *
 * Handles: scalars/consts, a single `$alias`, object-of-refs (keys preserved),
 * array-of-refs, and arbitrary nesting / `$alias`-mixed-with-literals.
 *
 * FAIL-CLOSED CONTRACT (holds universally, not just for in-memory builder
 * output): any value that cannot be faithfully represented as a ValueRef is
 * recorded into `unrecognized` (via `valueToRef`/`aliasToValueRef`) and is NEVER
 * silently dropped or collapsed to a `const undefined` / partial construct. A
 * recorded entry makes the pattern ineligible → legacy fallback. This covers,
 * in addition to the canonical-builder shapes:
 *   - a malformed `$alias` payload (truthy non-record, or missing/non-array
 *     `path` — e.g. `{$alias:"str"}`, `{$alias:null}`, `{$alias:{}}`),
 *   - `$alias` mixed with sibling keys (resolving would drop the siblings),
 *   - a canonical alias carrying a non-zero `defer` (serialized / nested-pattern
 *     indirection the interpreter does not yet model — resolving as level-0
 *     would point at the wrong cell). (`scope` is NOT a fail-closed trigger: the
 *     fresh builder emits it on ordinary eligible-tier aliases and the
 *     interpreter resolves against the ambient frame — see `aliasToValueRef`.)
 * Plain scalars, incl. functions/symbols, become `const`, exactly the value
 * legacy would pass. The canonical alias predicate (`isLegacyAlias`) is the same
 * one the rest of the runtime uses, so eligibility never diverges from it.
 */
function buildStructuredRef(
  v: unknown,
  unrecognized: Set<string>,
  ops: Op[],
  nextSynthId: () => OpId,
  bump: (k: OpKind | "unknown") => void,
  expectedDefer: number,
): ValueRef {
  const direct = valueToRef(v, unrecognized, expectedDefer);
  if (direct) return direct;
  // `direct` is null in exactly two cases:
  //   1. a plain structured object/array (NO `$alias` own-key) — assemble below;
  //   2. a value bearing a `$alias` own-key that `valueToRef` already RECORDED
  //      into `unrecognized` (malformed payload, defer/scope, or alias mixed
  //      with siblings). For (2) the graph is already ineligible; we must NOT
  //      fall through to the object/array assembly below (that would emit a
  //      bogus `{$alias: const(...)}` / partial construct). Surface a placeholder
  //      so the type-checks before fallback hold — the recorded entry, not this
  //      const, is what drives the (correct) legacy fallback.
  const obj = v as Record<string, unknown>;
  if (Object.hasOwn(obj, "$alias")) {
    return { kind: "const", value: undefined };
  }

  if (Array.isArray(v)) {
    const items = v.map((el) =>
      buildStructuredRef(
        el,
        unrecognized,
        ops,
        nextSynthId,
        bump,
        expectedDefer,
      )
    );
    const id = nextSynthId();
    ops.push({
      id,
      kind: "construct",
      inputs: items,
      outSchema: true as unknown as Op["outSchema"],
      detail: { kind: "construct", template: { shape: "array", items } },
    });
    bump("construct");
    return { kind: "opOut", op: id, path: [] };
  }

  const fields: Record<string, ValueRef> = {};
  for (const [k, el] of Object.entries(obj)) {
    fields[k] = buildStructuredRef(
      el,
      unrecognized,
      ops,
      nextSynthId,
      bump,
      expectedDefer,
    );
  }
  const id = nextSynthId();
  ops.push({
    id,
    kind: "construct",
    inputs: Object.values(fields),
    outSchema: true as unknown as Op["outSchema"],
    detail: { kind: "construct", template: { shape: "object", fields } },
  });
  bump("construct");
  return { kind: "opOut", op: id, path: [] };
}

/**
 * Build the single structured input ValueRef for a node, LOSSLESSLY.
 *
 * A node's `inputs` is the structured value its module receives. We reconstruct
 * it into one ValueRef (synthesizing construct ops for object/array shapes) so
 * the evaluator can pass the leaf the exact value legacy passes. Returns a
 * single-element array (one structured input) so the existing `op.inputs` shape
 * and the single-input leaf contract are preserved. An empty/undefined input
 * tree yields no inputs (a zero-arg leaf, called with undefined).
 */
function inputRefs(
  inputs: unknown,
  unrecognized: Set<string>,
  ops: Op[],
  nextSynthId: () => OpId,
  bump: (k: OpKind | "unknown") => void,
  expectedDefer: number,
): ValueRef[] {
  if (inputs === undefined || inputs === null) return [];
  const ref = buildStructuredRef(
    inputs,
    unrecognized,
    ops,
    nextSynthId,
    bump,
    expectedDefer,
  );
  return [ref];
}

/** True iff a canonical `$alias`'s payload is an EVENT-STREAM source, not a
 * value producer. A handler's `$event` input (and any stream-typed internal
 * cell) carries `partialCause = { $kind: "stream", … }` (builder/pattern.ts:312)
 * or the legacy `{ stream: [...] }` shape. The boundary fires on events from
 * such a source; it does NOT wait for a segment to PRODUCE the stream value, so
 * it is not a `boundary←producer` edge. Mirrors the standalone probe's
 * `aliasProducerName` exclusion (coalescing-partition-probe.ts). */
function isEventStreamAlias(alias: Record<string, unknown>): boolean {
  const pc = alias.partialCause;
  if (!pc || typeof pc !== "object") return false;
  const o = pc as Record<string, unknown>;
  return o.$kind === "stream" || Array.isArray(o.stream);
}

/**
 * Capture a BOUNDARY (effect) op's input ValueRef(s) from the RAW `node.inputs`
 * alias tree — the `boundary←producer` edges the partitioner (§4.2) needs to
 * order a producing segment before the boundary it feeds, and the labeled
 * read-through CFC (§4.5) needs to attribute the boundary's reads.
 *
 * An effect op's `detail` carries no refs (`{kind:"effect", sink}`) and the
 * interpreter never EVALUATES it (it throws `NotInterpretedHere`), so unlike a
 * leaf we do NOT reconstruct the structured argument into ONE construct-backed
 * ValueRef. We instead collect the FLAT list of value-producer alias leaves —
 * one ValueRef per canonical `$alias` the boundary reads — using the SAME
 * lossless `aliasToValueRef` path leaf nodes use (so the recognized argument /
 * internal / generated forms resolve identically, and the same `defer`
 * fail-closed contract holds). EVENT-STREAM aliases (a handler's `$event`,
 * `{$kind:"stream"}` / `{stream:[…]}` payloads) are EXCLUDED — they are event
 * sources, not value producers (mirrors the probe).
 *
 * Order of traversal is deterministic (object key / array order), so the
 * resulting `op.inputs` is stable. A malformed `$alias` leaf (non-canonical
 * payload, or `$alias` mixed with siblings) is recorded into `unrecognized`
 * exactly as the leaf path records it — fail-closed, so a boundary whose input
 * tree is unrepresentable still makes the pattern ineligible (it already was,
 * since it carries an effect op, so eligibility is unchanged either way).
 */
function effectInputRefs(
  inputs: unknown,
  unrecognized: Set<string>,
  expectedDefer: number,
): ValueRef[] {
  const refs: ValueRef[] = [];
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    const obj = v as Record<string, unknown>;
    if (isLegacyAlias(v)) {
      // A canonical alias mixed with sibling keys is not a representable input
      // — record it (fail closed) and do not descend, matching `valueToRef`.
      if (hasAliasMixedWithSiblings(obj)) {
        unrecognized.add(MALFORMED_ALIAS_MARKER);
        return;
      }
      const alias = obj.$alias as Record<string, unknown>;
      // Event-stream source (handler `$event`, stream cell): not a producer.
      if (isEventStreamAlias(alias)) return;
      const ref = aliasToValueRef(alias, unrecognized, expectedDefer);
      if (ref) refs.push(ref);
      // Never descend into an alias payload (path/schema are not inputs).
      return;
    }
    // Bears a `$alias` key but is NOT canonical (malformed payload): record,
    // do not descend — same fail-closed contract as `valueToRef`.
    if (Object.hasOwn(obj, "$alias")) {
      unrecognized.add(MALFORMED_ALIAS_MARKER);
      return;
    }
    if (Array.isArray(v)) {
      for (const el of v) visit(el);
      return;
    }
    for (const el of Object.values(obj)) visit(el);
  };
  visit(inputs);
  return refs;
}

/** Map an `outputs` alias to the internal-cell name it writes (the producing
 * op's output alias), matching `aliasToValueRef`'s `internal` naming so the
 * evaluator's `internalToOp` lookup keys line up. Returns null if the output is
 * not a recognizable internal alias. Exported for the runner's faithful
 * multi-output emission (it builds the synthetic node's per-field output binding
 * keyed by these names). */
export function outputInternalName(outputs: unknown): string | null {
  if (!outputs || typeof outputs !== "object") return null;
  const alias = (outputs as { $alias?: Record<string, unknown> }).$alias;
  if (!alias || typeof alias !== "object") return null;
  if (!("partialCause" in alias)) return null;
  return partialCauseToInternalName(alias.partialCause);
}

/** True iff a node's `outputs` is a canonical alias that targets the ARGUMENT
 * cell (`{$alias:{cell:"argument",path:[...]}}`) — a write-BACK into the
 * argument the result aliases. (A normal output aliases a `partialCause`
 * internal cell, recognized by `outputInternalName`.) */
function isArgumentWritebackOutput(outputs: unknown): boolean {
  if (!outputs || typeof outputs !== "object") return false;
  if (!isLegacyAlias(outputs)) return false;
  const alias = (outputs as { $alias?: Record<string, unknown> }).$alias;
  return !!alias && typeof alias === "object" && alias.cell === "argument";
}

export interface ExtractResult {
  rog: Rog;
  coverage: CoverageReport;
  /** Internal-cell name (a node's output `partialCause`) → producing op id, so
   * the evaluator can resolve `internal` ValueRefs to `opOut`. Only the
   * top-level pattern's nodes are wired (nested element graphs are W3). */
  internalToOp: Map<string, OpId>;
}

/**
 * Infer the `baseDefer` of a sub-graph extracted in ISOLATION (a collection
 * element pattern). The builder serializes a pattern's argument aliases with a
 * `defer` equal to the number of nesting levels it sits below the SERIALIZATION
 * root — so an element pattern inlined under its parent `map` carries
 * `defer === 1` on its `element`/`index` argument reads, even though it is the
 * element evaluator's OWN root (depth 0). We scan the pattern's TOP-frame
 * argument-cell aliases (in `result` + each node's `inputs`/`outputs`, NOT
 * recursing into a nested element pattern's `op`) and return the MINIMUM `defer`
 * observed — that minimum is the element frame's own base (a deeper nested alias
 * carries a higher defer the recursion handles relative to it). Returns 0 when
 * no `cell:"argument"` alias carries a numeric `defer` (a standalone root, or an
 * element reading only internals/consts), which leaves the default behavior
 * unchanged. PURE — read-only structural scan, no side effects.
 */
export function extractRogBaseDefer(pattern: RawPattern): number {
  let min = Infinity;
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const el of v) visit(el);
      return;
    }
    const obj = v as Record<string, unknown>;
    const alias = obj.$alias as Record<string, unknown> | undefined;
    if (
      alias && typeof alias === "object" && alias.cell === "argument" &&
      typeof alias.defer === "number"
    ) {
      if (alias.defer < min) min = alias.defer;
      // Do not descend into a resolved alias payload.
      return;
    }
    for (const val of Object.values(obj)) visit(val);
  };
  const p = pattern as { result?: unknown; nodes?: unknown[] };
  visit(p.result);
  for (const node of p.nodes ?? []) {
    const n = node as { inputs?: unknown; outputs?: unknown };
    visit(n.inputs);
    visit(n.outputs);
  }
  return Number.isFinite(min) ? min : 0;
}

export function extractRog(
  pattern: RawPattern,
  /** Defer level of THIS pattern's OWN top frame, as the builder serialized it.
   * Default 0 — a pattern authored as a standalone root (its argument aliases
   * carry `defer === 0`). A NON-zero value is for a sub-graph extracted in
   * isolation whose argument aliases were serialized relative to an OUTER frame
   * (e.g. a collection ELEMENT pattern the builder inlined under its parent map,
   * so its `element`/`index` argument aliases carry `defer === 1`). The
   * collection element evaluator re-extracts the element pattern as its OWN root
   * but the serialized `defer` still reflects the parent nesting; passing the
   * observed base aligns `expectedDefer` so those local argument reads resolve
   * (and any DEEPER nesting inside the element still increments correctly from
   * the base). Inferred by `extractRogBaseDefer` for the element-evaluator. */
  baseDefer = 0,
): ExtractResult {
  // §4.7: the unrecognized-alias report is shared across the whole recursion (the
  // top frame + every nested sub-pattern frame), because a nested sub-pattern's
  // serialized aliases legitimately carry cross-frame `defer`s the OUTER frame
  // cannot resolve locally — those pollute the outer report. We additionally
  // track which failures came from the TOP frame (`depth === 0`) so the runner
  // can tell a genuine outer-frame alias problem (always fall back) from a
  // nested-frame cross-frame indirection (validated independently when the child
  // re-dispatches — see the recursion comment in `buildInterpreterPattern`). A
  // Set subclass records the CURRENT recursion depth at add-time into the top-
  // frame set, capturing additions from BOTH `build` and every helper that takes
  // the `unrecognized` set, without threading depth through each call.
  let currentExtractDepth = 0;
  const topFrameUnrecognized = new Set<string>();
  class DepthAwareUnrecognized extends Set<string> {
    override add(value: string): this {
      if (currentExtractDepth === 0) topFrameUnrecognized.add(value);
      return super.add(value);
    }
  }
  const unrecognized: Set<string> = new DepthAwareUnrecognized();
  const byKind = {} as Record<OpKind | "unknown", number>;
  let nodeCount = 0;
  let classified = 0;
  let nested = 0;

  const bump = (k: OpKind | "unknown") => {
    byKind[k] = (byKind[k] ?? 0) + 1;
  };

  // Synthesized ops (result construct + per-leaf structured-input constructs)
  // are NOT Pattern nodes; they get unique negative ids so they never collide
  // with node ids (== node index, >= 0) in the topo/byId maps. Counter is shared
  // across the whole extraction so synth ids are globally unique; per-Rog node
  // ids still start at 0 (the node index), so a sub-Rog's leaf ops and the
  // parent's leaf ops both begin at 0 — they must NEVER share one flat map (R2),
  // which is why `internalToOp` and `leafImpls` are PER-Rog / per-detail.
  let synthCounter = 0;
  const nextSynthId = (): OpId => --synthCounter; // -1, -2, -3, ...

  // `build` returns the Rog plus the LOCAL `internalToOp` for that (sub-)Rog's
  // node space. The top-level call's map becomes `ExtractResult.internalToOp`
  // (public surface unchanged); each sub-Rog's map rides on its inlined detail.
  function build(
    p: RawPattern,
    depth: number,
  ): { rog: Rog; internalToOp: Map<string, OpId> } {
    // Track the recursion depth for the depth-aware unrecognized recorder. A
    // nested `build(..., depth+1)` sets it deeper and restores it on return, so
    // every `unrecognized.add(...)` (here or in a helper) is attributed to the
    // frame that is currently processing — `topFrameUnrecognized` collects only
    // the `depth === 0` ones.
    const savedExtractDepth = currentExtractDepth;
    currentExtractDepth = depth;
    try {
      return buildInner(p, depth);
    } finally {
      currentExtractDepth = savedExtractDepth;
    }
  }

  function buildInner(
    p: RawPattern,
    depth: number,
  ): { rog: Rog; internalToOp: Map<string, OpId> } {
    const ops: Op[] = [];
    const nodes = p.nodes ?? [];
    // PER-Rog internal-cell wiring. The sub-pattern's internal refs are LOCAL to
    // the child node space and MUST resolve within the sub-Rog — never share the
    // parent's map (Change B).
    const internalToOp = new Map<string, OpId>();
    // At recursion depth `d` a LOCAL alias (one resolving to this frame's own
    // argument/internal) carries `defer === d` RELATIVE TO THIS ROOT — but if the
    // root was itself serialized under an outer frame (`baseDefer > 0`, e.g. a
    // collection element pattern), its own top frame's locals carry
    // `defer === baseDefer`, so offset by it (the builder still increments once
    // per nesting level it serializes through, json-utils.ts:87-98).
    const expectedDefer = baseDefer + depth;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      nodeCount++;
      const c = classifyModule(node.module);
      bump(c.kind);
      classified++; // every node classifies (leaf is the sound default)

      // Wire this node's output alias → its op id into THIS Rog's LOCAL map, so
      // `internal` ValueRefs (result/input refs to derived cells) resolve within
      // the same node space. Wired at EVERY depth now (Change B): a sub-Rog's
      // internal cells must resolve against the sub-Rog's own nodes.
      {
        const outName = outputInternalName(node.outputs);
        if (outName !== null) {
          internalToOp.set(outName, i);
        } else if (isArgumentWritebackOutput(node.outputs)) {
          // FAIL CLOSED: the node's OUTPUT aliases an ARGUMENT cell — it writes
          // its value BACK into the argument cell (which the result then aliases).
          // The synthetic interpreter node has no per-output write-back machinery,
          // so this would be silently dropped → result reads `{}`. Record the
          // dedicated marker so the runner falls back via `argument_writeback`.
          unrecognized.add(ARGUMENT_WRITEBACK_MARKER);
        } else if (
          node.outputs && typeof node.outputs === "object" &&
          Object.hasOwn(node.outputs as object, "$alias") &&
          !isLegacyAlias(node.outputs)
        ) {
          // FAIL CLOSED: the output bears a `$alias` key but is not a canonical
          // alias (malformed payload, e.g. `{$alias:"str"}`). Its internal name
          // can't be resolved, so any `internal` ref to this node's output would
          // silently resolve to `undefined` (interpret.ts) with no throw — a
          // silent mis-eval the dry-run probe can't catch. Record it so the
          // pattern is ineligible → legacy fallback. (Canonical builder outputs
          // are always `{$alias:{partialCause,…}}`, so this never fires on a real
          // pattern.)
          unrecognized.add(MALFORMED_ALIAS_MARKER);
        }
      }

      // Leaf nodes (and the conservative-default leaf) receive a SINGLE
      // structured input — reconstruct it losslessly (synthesizing construct
      // ops for object/array shapes) so the evaluator passes the leaf the exact
      // value legacy passes. Collection/control/pattern carry their meaningful
      // refs in `detail`, so their flat `inputs` stays empty (the `detail` refs
      // alone drive ordering + read-set derivation). EFFECT (boundary) ops carry
      // no `detail` refs, so we populate their flat `inputs` with the FLAT list
      // of value-producer alias leaves from the raw input tree (event streams
      // excluded) — the `boundary←producer` edges the partitioner (§4.2) and the
      // CFC read-through (§4.5) need. The interpreter never evaluates an effect
      // op (it throws `NotInterpretedHere`), so these refs only ADD edges to the
      // ROG; they change no eligible-pattern evaluation.
      const inputs = c.kind === "leaf"
        ? inputRefs(
          node.inputs,
          unrecognized,
          ops,
          nextSynthId,
          bump,
          expectedDefer,
        )
        : c.kind === "effect"
        ? effectInputRefs(node.inputs, unrecognized, expectedDefer)
        : [];
      const op: Op = {
        id: i,
        kind: c.kind,
        impl: c.impl,
        inputs,
        // deno-lint-ignore no-explicit-any
        outSchema: (node.module as any)?.resultSchema ?? true as any,
        detail: { kind: "leaf" } as Op["detail"],
      };

      if (c.kind === "collection") {
        // The op's element pattern is the `op` input (inline Pattern in memory,
        // or a $patternRef once serialized). Recurse if inline.
        const inObj = (node.inputs ?? {}) as Record<string, unknown>;
        const listRef = inObj.list === undefined
          ? ({ kind: "const", value: undefined } as ValueRef)
          : buildStructuredRef(
            inObj.list,
            unrecognized,
            ops,
            nextSynthId,
            bump,
            expectedDefer,
          );
        let elementImpl: ImplRef = { identity: "<inline>", symbol: "op" };
        if (isPatternLike(inObj.op)) {
          nested++;
          // Recurse for COVERAGE only — the element graph is interpreted by the
          // collection element evaluator (re-extracted fresh at depth 0), not
          // inlined here, so the returned sub-Rog is intentionally discarded.
          build(inObj.op as RawPattern, depth + 1);
        } else if (
          inObj.op && typeof inObj.op === "object" &&
          (inObj.op as { $patternRef?: ImplRef }).$patternRef
        ) {
          elementImpl = (inObj.op as { $patternRef: ImplRef }).$patternRef;
        }
        op.detail = {
          kind: "collection",
          op: c.collOp!,
          elementRog: elementImpl,
          listInput: listRef,
        };
      } else if (c.kind === "control") {
        const inObj = (node.inputs ?? {}) as Record<string, unknown>;
        const branchRef = (v: unknown): ValueRef =>
          v === undefined
            ? ({ kind: "const", value: undefined } as ValueRef)
            : buildStructuredRef(
              v,
              unrecognized,
              ops,
              nextSynthId,
              bump,
              expectedDefer,
            );
        // Pick a branch source by the FIRST key PRESENT (own-key), not by `??`
        // coalescing: a legitimate literal `null` branch value (`ifFalse: null`)
        // must survive — `null ?? undefined === undefined` would collapse it to
        // `const undefined`, so `ifElse(false, x, null)` would wrongly yield
        // `undefined` instead of `null` (CT-1158). `branchRef` already routes a
        // literal `null` to `{kind:"const",value:null}`.
        const pickBranch = (...keys: string[]): unknown => {
          for (const k of keys) {
            if (Object.hasOwn(inObj, k)) return inObj[k];
          }
          return undefined;
        };
        const pred = branchRef(pickBranch("condition", "if"));
        // Branches must be exactly [then, else] in that order — NOT the flat
        // `inputs` list (which also carries the condition). The builder names
        // the inputs per builtin (verified empirically against the real
        // builder, built-in.ts):
        //   - ifElse(condition, ifTrue, ifFalse) → {condition, ifTrue, ifFalse}
        //   - when(condition, value)             → {condition, value}
        //     (semantics: cond ? value : cond — THEN is `value`, ELSE = pred)
        //   - unless(condition, fallback)        → {condition, fallback}
        //     (semantics: cond ? cond : fallback — THEN = pred, ELSE = `fallback`)
        // So the THEN ref is the value/ifTrue branch and the ELSE ref is the
        // fallback/ifFalse branch. The interpreter uses `pred` for the
        // condition-returning branch of when/unless. (then/else are legacy
        // ifElse fallbacks.)
        const thenRef = branchRef(pickBranch("ifTrue", "then", "value"));
        const elseRef = branchRef(pickBranch("ifFalse", "else", "fallback"));
        op.detail = {
          kind: "control",
          op: c.ctrlOp!,
          pred,
          branches: [thenRef, elseRef],
        };
      } else if (c.kind === "pattern") {
        // Reconstruct the BOUND argument the parent passes the sub-pattern — the
        // pattern node's `inputs`, resolved losslessly in the PARENT frame
        // (`expectedDefer = depth`). This is the lossless leaf-input path; the
        // evaluator resolves it and hands the value to the sub-Rog as its
        // `argument`. An empty/undefined input tree → `const undefined`.
        const argumentRef = node.inputs === undefined || node.inputs === null
          ? ({ kind: "const", value: undefined } as ValueRef)
          : buildStructuredRef(
            node.inputs,
            unrecognized,
            ops,
            nextSynthId,
            bump,
            expectedDefer,
          );
        // The in-memory nested pattern's live sub-Pattern (with `.nodes`) lives
        // at `module.implementation` (an inline Pattern object). A SERIALIZED
        // nested pattern has no live sub-Pattern there (only a `$patternRef`),
        // so `inlined` stays undefined → the interpreter throws
        // NotInterpretedHere → fail closed → legacy (which models serialized /
        // deferred resolution).
        const childPattern =
          (node.module as { implementation?: unknown } | undefined)
            ?.implementation;
        let inlined: { rog: Rog; internalToOp: Map<string, OpId> } | undefined;
        if (isPatternLike(childPattern)) {
          nested++; // coverage sees the sub-graph (Change A; load-bearing w/ E)
          // RECURSE and KEEP the returned Rog (unlike the collection branch,
          // which discards it). The recursion at `depth + 1` makes the closure-
          // level `byKind`/`nested` counters account for the sub-pattern's
          // op-kinds — which `rog.ops` is BLIND to (each build returns a fresh
          // ops[]). The gate (Change E) reads those counters, so this recursion
          // and the gate are MUTUALLY LOAD-BEARING (R1).
          inlined = build(childPattern as RawPattern, depth + 1);
        }
        op.detail = {
          kind: "pattern",
          impl: c.impl,
          argument: argumentRef,
          inlined,
        };
      } else if (c.kind === "effect") {
        // Carry the I/O-vs-handler discrimination (07 §4.7) so the F4 write-back
        // gate fires only for handler sinks; an I/O-builtin (`fetchData`/`llm`/…)
        // output read by a downstream segment is a sound `bnd→seg` dataflow edge.
        op.detail = { kind: "effect", sink: c.effectSink ?? "handler" };
      }
      ops.push(op);
    }

    // The pattern result is usually an object/array literal of refs (a
    // construct), not a single alias. Reconstruct it losslessly (the same
    // structured-ref synthesis leaf inputs use) so the result resolves instead
    // of silently dropping to const — and any non-representable result leaf is
    // recorded as unrecognized, not dropped.
    const resultRef = p.result === undefined
      ? ({ kind: "const", value: undefined } as ValueRef)
      : buildStructuredRef(
        p.result,
        unrecognized,
        ops,
        nextSynthId,
        bump,
        expectedDefer,
      );
    return {
      rog: {
        // deno-lint-ignore no-explicit-any
        argumentSchema: (p.argumentSchema ?? true) as any,
        // deno-lint-ignore no-explicit-any
        resultSchema: (p.resultSchema ?? true) as any,
        result: resultRef,
        ops,
      },
      internalToOp,
    };
  }

  const { rog, internalToOp } = build(pattern, 0);
  return {
    rog,
    coverage: {
      nodes: nodeCount,
      classified,
      byKind,
      unrecognizedAliases: [...unrecognized],
      topFrameUnrecognizedAliases: [...topFrameUnrecognized],
      nested,
    },
    internalToOp,
  };
}

/**
 * Resolve leaf op implementations for an **in-memory** built pattern (the
 * factory result), so an extracted ROG can be evaluated end-to-end.
 *
 * For an in-memory `type: "javascript"` module the builder keeps the lift body
 * as a live callable at `module.implementation` (verified against builder
 * output); we wrap it as a `LeafImpl`. This relies on op id == node index (the
 * extraction invariant for top-level nodes). Once a pattern is *serialized*,
 * `module.implementation` is a source string and only the `$implRef` survives —
 * resolving THAT requires the session implementation index (the SES sandbox),
 * which is the W1b-sandbox boundary, not handled here.
 *
 * Returns the map plus the set of leaf op ids that could NOT be resolved to a
 * callable (so callers can assert the boundary honestly instead of silently
 * getting a wrong/missing value).
 */
/**
 * Resolver for a *serialized* leaf, by its content-addressed `$implRef`. Backed
 * by the runtime harness's `getVerifiedImplementation` — the session-lifetime
 * index that survives serialization (a graph passed through a node `op` input
 * loses its live `module.implementation` callable but keeps `$implRef`). This is
 * a real lookup of the actually-registered verified implementation, not a
 * hardcoded body. Returns undefined if the ref is not resolvable in this
 * session (the genuine SES/serialized boundary).
 */
export type ImplRefResolver = (
  identity: string,
  symbol: string,
) => ((input: unknown) => unknown) | undefined;

/**
 * Trust gate for a LIVE leaf implementation (a `module.implementation` that is
 * still a callable, not a serialized source string). SECURITY-RELEVANT: the
 * interpreter runs a resolved leaf impl as a RAW host closure against the real
 * host globals — it does NOT route it through the SES sandbox. So an UNTRUSTED
 * in-memory callback (a test-built / never-verified `cf.lift((..)=>..)` whose
 * function carries no verified provenance and no resolvable entry ref) must NOT
 * be resolved here: legacy routes such callbacks through the SES fallback
 * (`getFallbackJavaScriptImplementation`, recompiled from `fn.toString()` so
 * captured closures are stripped and `Proxy` is absent). Resolving it as a leaf
 * would defeat that sandboxing invariant (`typeof Proxy === "function"`, a
 * captured `secret.factor` resolves) — so an untrusted live leaf is treated as
 * UNRESOLVED, which trips the caller's `unresolved_leaf` gate and falls the
 * whole pattern back to the legacy (SES) path. Mirrors `resolveJavaScript
 * Function`'s `liveTrusted` test in runner.ts. Returns true iff the live
 * function is trusted (verified provenance OR a harness-resolvable entry ref).
 */
export type LiveLeafTrustCheck = (
  impl: (input: unknown) => unknown,
) => boolean;

/**
 * True iff a leaf's argument schema anywhere requires a LIVE Cell/Stream handle
 * — i.e. it carries an `asCell` or `asStream` annotation (the builder writes
 * `{asCell: [...]}` / `{asStream: [...]}` onto the schema property the lift
 * receives as a Cell). The interpreter deep-resolves the argument to a PLAIN
 * value before calling the leaf, so any such leaf would call a Cell method on a
 * plain value and throw. Scans recursively (the annotation may sit on a nested
 * property/items schema), but does NOT descend into the literal `default` value
 * (a default is data, not schema, and could spuriously contain those keys).
 */
export function schemaNeedsCellContext(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (Array.isArray(schema)) {
    return schema.some((s) => schemaNeedsCellContext(s));
  }
  const obj = schema as Record<string, unknown>;
  if (obj.asCell !== undefined || obj.asStream !== undefined) return true;
  for (const [k, v] of Object.entries(obj)) {
    // `default` holds an authored VALUE, not a sub-schema — skip it so a literal
    // payload that happens to carry an `asCell` key cannot trip the gate.
    if (k === "default") continue;
    if (schemaNeedsCellContext(v)) return true;
  }
  return false;
}

/**
 * Path-aware refinement of {@link schemaNeedsCellContext}: true iff navigating
 * the argument `schema` along `path` (the `.key(...)` chain a segment's
 * `argument` ValueRef carries) passes THROUGH or TERMINATES AT an
 * `asCell`/`asStream` node — i.e. the segment's deep-resolved `$arg` read would
 * surface a live Cell/Stream HANDLE at that path rather than the unwrapped value
 * (the §4.5 segment hazard). Used to gate the coalescing partition per-SEGMENT
 * (07 §4.7): a segment that reads only PLAIN argument paths is sound even when a
 * SIBLING argument field is a `Cell`/`Stream` handed to a handler boundary (a
 * `Stream` arg passed only to `.send()` is never in any pure segment, so it must
 * not fall the whole pattern back). The walk is conservative:
 *   - an `asCell`/`asStream` AT or ABOVE the navigated node ⇒ true (reading a
 *     sub-path of a Cell still surfaces the handle root);
 *   - `properties[key]` / `items` are followed by the path step;
 *   - a step into an `additionalProperties` / unknown sub-schema that ITSELF (or
 *     anything below it) needs cell context ⇒ true (we cannot prove the concrete
 *     key is handle-free, so fall back — sound);
 *   - a path that runs off a concrete value schema (no further sub-schema) ⇒
 *     false (it reached a plain leaf).
 * PURE — read-only structural walk.
 */
export function argumentPathNeedsCellContext(
  schema: unknown,
  path: readonly PathStep[],
): boolean {
  if (!schema || typeof schema !== "object") return false;
  const obj = schema as Record<string, unknown>;
  // A handle annotation AT this level dominates: every sub-path reads the handle.
  if (obj.asCell !== undefined || obj.asStream !== undefined) return true;
  if (path.length === 0) {
    // The segment reads THIS node directly (deep-resolved) — only a handle here
    // surfaces a Cell/Stream, which we already checked. A plain object/array
    // node deep-resolves to a plain value, so it is safe.
    return false;
  }
  const [step, ...rest] = path;
  // Object property navigation.
  const props = obj.properties as Record<string, unknown> | undefined;
  if (props && Object.hasOwn(props, step)) {
    return argumentPathNeedsCellContext(props[step], rest);
  }
  // Array index navigation (a numeric step into `items`).
  if (obj.items !== undefined && /^\d+$/.test(step)) {
    if (Array.isArray(obj.items)) {
      const idx = Number(step);
      return argumentPathNeedsCellContext(obj.items[idx], rest);
    }
    return argumentPathNeedsCellContext(obj.items, rest);
  }
  // `additionalProperties` / open record: we cannot prove the concrete key is
  // handle-free, so fall back if that sub-schema needs cell context anywhere.
  const addl = obj.additionalProperties;
  if (addl && typeof addl === "object") {
    return schemaNeedsCellContext(addl);
  }
  // No declared sub-schema for this step: the path reached an untyped / plain
  // region. Be conservative ONLY if the WHOLE remaining schema below needs a
  // handle (it cannot, since we have no sub-schema), so this is a plain leaf.
  return false;
}

/** Bare-identifier names a leaf body may CALL that are pure host globals — a call
 * to one of these is NOT a pattern/sub-computation instantiation, so it must not
 * trip the structural pattern-instantiation gate below. Members (`Array.from`,
 * `JSON.parse`, `x.sample()`) are already excluded by the `(?<![.\w$])` lookbehind
 * (they are preceded by `.`); this set covers the BARE forms (`Array(`, `Number(`,
 * `parseInt(`, …) a pure lift legitimately calls and returns. Deliberately broad
 * on the SAFE side: a name that is NOT here and is called bare is treated as a
 * possible factory/lift application → fall back (always sound). */
const PURE_GLOBAL_CALLEES = new Set([
  // constructors / coercions
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  // numeric / parsing host functions
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "structuredClone",
  // control-flow keywords that the regex could see as `name(` (e.g. `if (`,
  // `for (`, `while (`, `switch (`, `catch (`, `return (`, `typeof(`). These are
  // NOT calls; excluding them keeps the gate precise.
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "typeof",
  "await",
  "function",
  "do",
  "else",
]);

/**
 * True iff a leaf module's declared `resultSchema` pins a CONCRETE JSON VALUE
 * shape — a `type` keyword, an `enum`/`const`, a `$ref`, or an `anyOf`/`allOf`/
 * `oneOf` of such schemas. A leaf whose output the builder typed this way
 * provably produces that VALUE, not a Pattern/Cell/OpaqueRef: a pattern/lift
 * factory application has no statically-known value shape, so the builder leaves
 * such a lift's resultSchema EMPTY/absent/`true` (verified empirically: every
 * pattern-returning `lift(fn)` carries `resultSchema === {}`, while every pure
 * value-lift in the corpus carries a concrete `type`/`enum`/`$ref`/`anyOf`
 * schema). We use this as the PRECISE discriminator for the bare-call gate below:
 * a typed value-producer leaf may freely call a closed-over PURE helper
 * (`sanitizeAmount(...)`, `summarizeSelection(...)`) without tripping the gate.
 *
 * Conservative by construction: an EMPTY/`true`/absent schema returns false (the
 * bare-call gate stays armed), so the only leaves freed are those the builder
 * explicitly typed as value producers. A `type` that is itself `"null"` is still
 * a concrete value (never a Pattern), so it counts.
 */
function resultSchemaDeclaresValueType(schema: unknown): boolean {
  if (schema === true) return false; // `true` = "any" — not a pinned value type.
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const s = schema as Record<string, unknown>;
  // An ARRAY type only pins a concrete VALUE producer when its ELEMENT schema is
  // itself a pinned value type. The builder emits `items: true` (or omits `items`)
  // when the element type is statically unknown — the signature of a lift that
  // returns a collection of PATTERNS / OpaqueRefs (e.g.
  // `entries.map(() => childPattern(...))`, whose result schema is
  // `{type:"array", items:true}`). Treating that as a value producer would SUPPRESS
  // the bare-call pattern-instantiation gate and wrongly interpret a launched-child
  // lift. Require the element schema to declare a value type so an untyped-array
  // lift stays gated (→ legacy). A `prefixItems` tuple counts when every entry is a
  // value type. (Conservative: a genuine `unknown[]` value lift also stays gated —
  // an always-sound extra legacy fallback, never a mis-eval.)
  if (s.type === "array") {
    if (resultSchemaDeclaresValueType(s.items)) return true;
    const prefix = s.prefixItems;
    if (
      Array.isArray(prefix) && prefix.length > 0 &&
      prefix.every((p) => resultSchemaDeclaresValueType(p))
    ) {
      return true;
    }
    return false;
  }
  if (typeof s.type === "string") return true;
  if (Array.isArray(s.type) && s.type.length > 0) return true; // type union
  if (Array.isArray(s.enum) && s.enum.length > 0) return true;
  if (Object.prototype.hasOwnProperty.call(s, "const")) return true;
  if (typeof s.$ref === "string") return true;
  for (const key of ["anyOf", "allOf", "oneOf"] as const) {
    const branch = s[key];
    if (
      Array.isArray(branch) && branch.length > 0 &&
      branch.every((b) => resultSchemaDeclaresValueType(b))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * STRUCTURAL signal that a LIVE leaf body CAN return a Pattern / sub-computation /
 * Promise the interpreter cannot store — a `pattern(...)`/`lift(...)` factory
 * application, a cross-space/scope `.inSpace(...)`/`.asScope(...)` child
 * instantiation, or an `async` body (Promise return). The eligibility dry-run runs
 * in PROBE MODE (interpret.ts `probe:true`) and NEVER invokes a leaf body, so the
 * dry-run value guard (runner.ts: `isPattern`/`isCell`/`isOpaqueRef`/thenable on
 * the evaluated values) can no longer see the returned Pattern/Cell/Promise — this
 * structural source scan is the catcher. (It also covered the pre-probe-mode case
 * where the value guard missed a pattern returned only on SOME committed arguments,
 * the run-gate having skipped the body.) Calling such a factory at the synthetic
 * node's RUNTIME (no builder frame) throws / materializes empty; an async leaf
 * returns a Promise legacy AWAITS. These need the real reactive child
 * instantiation / await legacy performs (D-EMISSION-SCOPE: permanent fallback).
 *
 * We detect it from the leaf's live function SOURCE (`fn.toString()`, real source
 * for a trusted in-memory function):
 *  - a `.inSpace(`/`.asScope(` member call (cross-space/scope routing);
 *  - a leading `async` keyword (Promise-returning body);
 *  - a BARE-identifier call expression `name(` (a `pattern`/`lift` factory closed
 *    over by the body) that is NOT a member call (`x.foo(`) and NOT a known pure
 *    host global (`Array(`, `parseInt(`, …). Member calls and pure-global calls are
 *    how an ordinary value-lift legitimately produces a value, so they do NOT trip
 *    the bare-call gate; only a bare call to a closed-over factory/lift identifier
 *    does.
 *
 * PRECISION (the bare-call branch only): a bare call to a closed-over PURE HELPER
 * (`(input) => summarizeSelection(input.a, input.b)`) is SYNTACTICALLY identical to
 * a bare call to a closed-over PATTERN factory (`({value}) => childPattern({value})`)
 * — no source signal distinguishes them. The DISCRIMINATOR is the leaf module's
 * declared `resultSchema`: a pattern-returning lift has no statically-known value
 * shape, so the builder leaves its schema EMPTY/absent/`true`, whereas a pure
 * value-lift carries a concrete `type`/`enum`/`$ref`/`anyOf` schema. So when the
 * caller passes a resultSchema that `resultSchemaDeclaresValueType` recognizes, the
 * bare-call branch is SUPPRESSED (the leaf provably produces a value, not a Pattern)
 * — freeing pure-helper lifts to interpret. The `.inSpace`/`.asScope`/`async`
 * detectors stay UNCONDITIONAL: an async lift can declare a value resultSchema (the
 * awaited type) yet still return a Promise, and a cross-space child is always a
 * permanent fallback regardless of schema.
 *
 * Conservative by construction: a false positive only causes an extra
 * (always-sound) legacy fallback, never a mis-eval.
 */
function liveLeafCanInstantiatePattern(
  impl: (input: unknown) => unknown,
  resultSchema?: unknown,
): boolean {
  let src: string;
  try {
    src = Function.prototype.toString.call(impl);
  } catch {
    // A function whose source is unavailable (bound/native) cannot be statically
    // inspected — do NOT gate on it here (other gates / the value guard cover it).
    return false;
  }
  // CROSS-SPACE / SCOPE-ROUTING factory member calls (`.inSpace(` / `.asScope(`):
  // `Child.inSpace(name)({...})` / `Child.asScope("user")({...})` instantiate a
  // child pattern routed to another space / non-default scope. These are MEMBER
  // calls (so the bare-identifier scan below misses them) and the outer
  // application is on a parenthesized member-call result (no leading identifier),
  // so neither sub-call trips the bare-call regex. Per D-EMISSION-SCOPE
  // cross-space/.inSpace/.asScope is permanent legacy fallback — detect it
  // structurally here (the probe no longer executes leaf bodies, so the dry-run
  // value guard can no longer see the returned cross-space Pattern).
  if (/\.(inSpace|asScope)\s*\(/.test(src)) return true;
  // ASYNC lift: an `async` body returns a Promise the interpreter cannot store
  // (legacy AWAITS async leaves). The probe no longer runs the body, so the
  // dry-run thenable guard can no longer see the Promise — detect the `async`
  // keyword on the function source. Match `async` only as a leading keyword
  // (arrow `async (`/`async x =>` or `async function`), not as an identifier
  // substring. Sound: a false positive only adds a (correct) legacy fallback.
  if (/^async[\s(]/.test(src.trimStart())) return true;
  // BARE-CALL branch (the over-broad one). A bare call to a closed-over factory
  // is indistinguishable in source from a bare call to a closed-over pure helper,
  // so we suppress this branch ONLY when the leaf's declared `resultSchema` pins a
  // concrete VALUE type — proof the builder typed this leaf as a value producer,
  // not a Pattern factory (a pattern-returning lift carries an EMPTY schema). An
  // empty/absent/`true` schema keeps the branch armed (the conservative default).
  if (resultSchemaDeclaresValueType(resultSchema)) return false;
  // TRANSPILED INDIRECT-CALL form. A pattern/lift factory IMPORTED from another
  // module compiles to the CommonJS interop call `(0, exports.childPattern)(...)`
  // or `(0, mod.childPattern)(...)` (the `(0, <expr>)` sequence strips the method
  // receiver so the member is called as a plain function). The bare-identifier
  // regex below MISSES this — the factory name sits behind a `.` (member access)
  // and the application `(` follows a `)`, not an identifier. Match the interop
  // call head `(0, …)(` explicitly so a closed-over factory invoked through the
  // transpiler's indirect call is caught. Conservative & schema-gated exactly like
  // the bare-call branch
  // (already suppressed above when the result schema pins a value type), so a
  // value-producing helper called this way still interprets; only an
  // untyped/`items:true`-result indirect call (the launched-child-collection lift
  // `entries.map(() => (0, exports.childPattern)(...))`) trips it.
  if (/\(\s*0\s*,[^)]*\)\s*\(/.test(src)) return true;
  // Match a BARE-identifier call: an identifier not preceded by `.` or another
  // identifier char (so `a.b(` and `xb(` inside `foox(` do not match the `x`),
  // immediately followed by `(`. The `(?<![.\w$])` lookbehind excludes member
  // expressions and mid-identifier matches.
  const callRe = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of src.matchAll(callRe)) {
    const name = m[1];
    if (!PURE_GLOBAL_CALLEES.has(name)) return true;
  }
  return false;
}

/**
 * STRUCTURAL signal that a LIVE leaf body needs a BUILDER FRAME / runtime context
 * the interpreter's frameless synthetic node does not provide — specifically a
 * `Cell.for(...)` named-cell mint (or any `.for(` factory used to create a named
 * cell). Such a body calls `getTopFrame()` (cell.ts) which throws "Can't invoke
 * Cell.for() outside of a pattern/handler/lift context" at the synthetic node's
 * RUNTIME. The eligibility dry-run can MISS this because the probe happens to run
 * inside the ambient setup builder frame (so `Cell.for` succeeds at probe time)
 * while the scheduler action does not — the throw surfaces only at runtime. This
 * complements `schemaNeedsCellContext` (which catches asCell/asStream INPUT
 * handles): Cell.for mints a NEW named cell and is not visible on the argument
 * schema, so it needs its own structural detector. Detected from the leaf source
 * (`.for(` member call), a context-requiring lift → permanent legacy fallback.
 */
function liveLeafNeedsBuilderContext(
  impl: (input: unknown) => unknown,
): boolean {
  let src: string;
  try {
    src = Function.prototype.toString.call(impl);
  } catch {
    return false;
  }
  // `Cell.for(` / `.for(` is the named-cell mint that requires a builder frame.
  // The leading `.` distinguishes it from a bare `for (` control-flow keyword.
  return /\.for\s*\(/.test(src);
}

/**
 * SECURITY/SOUNDNESS gate for a LIVE leaf whose argument schema needs cell
 * context (`schemaNeedsCellContext`): does the body call any WRITE method on its
 * Cell/Stream input handle? The interpreter may hand a context-requiring leaf a
 * read-only Cell VIEW so a PURE lift/computed (one that only `.get()`/`.sample()`s
 * its input) interprets instead of falling back to legacy. A leaf that MUTATES
 * its input (`.set`/`.send`/`.update`/`.push`/`.setRaw`/`.setRawUntyped`/
 * `.setMetaRaw`/`.exec`) is EFFECTFUL — it must STAY a legacy fallback boundary
 * (the interpreter only ever claims to evaluate read-only leaves). Detected from
 * the leaf source by a `.method(` member-call scan (mirrors
 * `liveLeafNeedsBuilderContext`'s `.for(` scan).
 *
 * Conservative on the UNSAFE side: any match → write-capable → fall back (a false
 * positive only adds a correct legacy fallback). This is the PRIMARY write gate;
 * the cell-view freeze guard (cell.ts `throwIfReadOnly`) is the defense-in-depth
 * backstop if the scan ever misses a write (it then throws and the per-op
 * isolation degrades it to a correct error-isolated node, never a wrong write).
 */
export function liveLeafWritesCellInput(
  impl: (input: unknown) => unknown,
): boolean {
  let src: string;
  try {
    src = Function.prototype.toString.call(impl);
  } catch {
    // Source unreadable: be conservative and treat as write-capable (fall back).
    return true;
  }
  // Member-call writes on the handle (the leading `.` excludes bare identifiers
  // and confines the match to method invocations on the input Cell/Stream).
  return /\.\s*(set|send|update|push|setRaw|setRawUntyped|setMetaRaw|exec)\s*\(/
    .test(src);
}

export function resolveLeafImpls(
  pattern: RawPattern,
  rog: Rog,
  /** Optional fallback for serialized leaves whose `module.implementation` is no
   * longer a live callable but whose `$implRef` is resolvable (W1b-bridge over a
   * graph read back via `getRaw()`). */
  implRefResolver?: ImplRefResolver,
  /** SECURITY trust gate for a LIVE leaf impl. When provided, a live function
   * that does NOT pass this check is treated as UNRESOLVED (→ `unresolved_leaf`
   * fallback → legacy SES path), so an untrusted in-memory callback never runs
   * as a raw host closure inside the interpreter. The RUNNER'S eligibility probe
   * ALWAYS passes it, so production patterns are gated. When omitted (direct
   * unit-test calls / the runtime element-eval path that already cleared the
   * runner's gate), live functions resolve as before — the trust decision is the
   * runner probe's responsibility, made before any interpretation runs. */
  liveLeafTrustCheck?: LiveLeafTrustCheck,
  /** OPT-IN: the TOP-LEVEL leaf op ids the runner has PROVEN eligible to engage
   * as READ-ONLY context-requiring leaves (asCell/asStream INPUT to a pure lift/
   * computed). A leaf whose argument schema needs cell context
   * (`schemaNeedsCellContext`) is resolved as a NORMAL leaf — invoked with the
   * live Cell/Stream VIEW the interpreter surfaces — only if its op id is in this
   * set. The runner populates it ONLY for leaves whose asCell inputs are fed by
   * PATTERN-ARGUMENT refs (the only place a live handle is available in the
   * deep-resolved arg tree) AND whose source does not write the input
   * (`liveLeafWritesCellInput`). When omitted/empty (every existing caller —
   * flag-off runner, unit tests, the element evaluator), ALL context-requiring
   * leaves stay UNRESOLVED — byte-for-byte the prior behavior. Sound: the runner
   * freezes the surfaced view, so a missed write throws and is error-isolated,
   * never a silent mis-write. The set is the PARENT op-id space only; inlined
   * nested-pattern leaves (their own id space) are never matched, so a nested
   * context leaf stays a legacy boundary (out of scope for this increment). */
  readOnlyCellLeafOps?: ReadonlySet<OpId>,
): { leafImpls: Map<OpId, LeafImpl>; unresolvedLeafOps: OpId[] } {
  const leafImpls = new Map<OpId, LeafImpl>();
  const unresolvedLeafOps: OpId[] = [];
  const nodes = pattern.nodes ?? [];
  for (const op of rog.ops) {
    // INLINED nested pattern: resolve the child's live leaf impls against the
    // child's OWN `module.implementation.nodes`, and attach them to the child's
    // detail. PER-DETAIL — the child's leaf op ids start at 0 just like the
    // parent's, so they must NEVER merge into this flat parent map (R2). A child
    // with any unresolved leaf bubbles up here (we surface ONE sentinel for this
    // pattern op) so the caller's `unresolved_leaf` gate falls the whole pattern
    // back to legacy. Serialized child leaves hit this same boundary.
    if (op.detail.kind === "pattern" && op.detail.inlined) {
      const node = op.id >= 0 ? nodes[op.id] : undefined;
      const childPattern =
        (node?.module as { implementation?: unknown } | undefined)
          ?.implementation;
      const childResolved = resolveLeafImpls(
        (childPattern ?? {}) as RawPattern,
        op.detail.inlined.rog,
        implRefResolver,
        liveLeafTrustCheck,
        // The eligible set is the PARENT op-id space; a child has its own ids.
        // Nested context leaves stay legacy boundaries (out of scope).
        undefined,
      );
      // Attach the child's resolved leaf impls onto its inlined detail (the
      // evaluator reads them from there, NOT from the parent map).
      op.detail.inlined.leafImpls = childResolved.leafImpls;
      if (childResolved.unresolvedLeafOps.length > 0) {
        // Surface the pattern op's id as the unresolved sentinel (the parent's
        // own id space), so the `unresolved_leaf` gate trips on a child boundary
        // without conflating child and parent op ids in the flat map.
        unresolvedLeafOps.push(op.id);
      }
      continue;
    }
    if (op.detail.kind !== "leaf") continue;
    // Synthesized ops (id < 0) are never leaves; real leaf ops map 1:1 to nodes.
    const node = op.id >= 0 ? nodes[op.id] : undefined;
    const module = node?.module as RawModule | undefined;
    const impl = module?.implementation;
    // STRUCTURAL CONTEXT GATE (only when a trust check is supplied = the runner's
    // eligibility probe; NOT the partition probe / unit-test callers that omit
    // it and count unresolved leaves as boundaries). A leaf whose argument schema
    // carries an `asCell`/`asStream` annotation expects a LIVE Cell/Stream handle
    // (it calls `.get()`/`.key()`/`.sample()`/`.set()` on its input). The
    // interpreter feeds the leaf a deep-resolved PLAIN value, so those Cell
    // methods are undefined and the leaf throws — UNLESS the interpreter hands it
    // the live VIEW (the `allowReadOnlyCellLeaves` increment).
    //
    // SPLIT: a READ-ONLY context leaf the runner PROVED argument-fed (its op id is
    // in `readOnlyCellLeafOps`) and whose source does not WRITE its input
    // (`liveLeafWritesCellInput` is false) FALLS THROUGH to normal resolution: the
    // runner surfaces the asCell/asStream handle in the deep-resolved argument
    // tree (a live Cell bound to the segment tx), freezes it read-only, and the
    // leaf interprets by calling `.get()`/`.sample()` on it (reads journal through
    // the tx → CFC + reactivity parity). A WRITE-capable context leaf (effectful),
    // a leaf whose asCell input is internal/opOut-fed (no handle available — 2(b),
    // deferred), or any leaf the runner did not vet stays UNRESOLVED → legacy. When
    // the set is empty (every existing caller), EVERY context leaf stays
    // UNRESOLVED — byte-for-byte the prior behavior. Recurses into nested-pattern
    // leaves via the inlined-pattern branch above.
    if (liveLeafTrustCheck && schemaNeedsCellContext(module?.argumentSchema)) {
      const readOnlyEligible = readOnlyCellLeafOps?.has(op.id) === true &&
        typeof impl === "function" &&
        !liveLeafWritesCellInput(impl as (input: unknown) => unknown);
      if (!readOnlyEligible) {
        unresolvedLeafOps.push(op.id);
        continue;
      }
      // read-only context leaf: fall through to the shared resolution path below
      // (the pattern-instantiation / builder-frame / trust gates still apply).
    }
    // STRUCTURAL PATTERN-INSTANTIATION / CONTEXT GATES (runner probe only, gated on
    // `liveLeafTrustCheck`). Read off the leaf's live source, BEFORE resolving it as
    // a callable leaf, so a body that CAN return a pattern/lift instantiation
    // (`liveLeafCanInstantiatePattern`) or needs a builder frame (`Cell.for` —
    // `liveLeafNeedsBuilderContext`) falls back even when the eligibility dry-run's
    // value guard misses it (the conditional/recursive pattern branch is gated out
    // at probe time on an undefined snapshot argument; `Cell.for` happens to run
    // inside the ambient setup frame at probe time but throws at the frameless
    // synthetic node at runtime). Per D-EMISSION-SCOPE these are permanent legacy
    // fallback. Treat as UNRESOLVED → `unresolved_leaf` gate → legacy. Recurses into
    // nested-pattern leaves via the inlined-pattern branch above. Always sound: a
    // false positive only adds a (correct) legacy fallback, never a mis-eval.
    if (
      liveLeafTrustCheck && typeof impl === "function" &&
      (liveLeafCanInstantiatePattern(
        impl as (input: unknown) => unknown,
        module?.resultSchema,
      ) ||
        liveLeafNeedsBuilderContext(impl as (input: unknown) => unknown))
    ) {
      unresolvedLeafOps.push(op.id);
      continue;
    }
    if (typeof impl === "function") {
      // SECURITY: only a TRUSTED live function may run as a raw leaf inside the
      // interpreter (see `LiveLeafTrustCheck`). An untrusted in-memory callback
      // is treated as UNRESOLVED → `unresolved_leaf` fallback → legacy SES path,
      // so it never bypasses the sandbox. The RUNNER'S eligibility probe ALWAYS
      // passes the strict check, so a production pattern with an untrusted leaf
      // falls back. When NO check is supplied (direct unit-test calls / the
      // runtime element-eval path that already ran behind the runner's gate),
      // the live function is trusted — preserving the established resolution
      // contract for those callers without weakening the runner's gate.
      if (
        !liveLeafTrustCheck ||
        liveLeafTrustCheck(impl as (input: unknown) => unknown)
      ) {
        leafImpls.set(op.id, impl as LeafImpl);
      } else {
        unresolvedLeafOps.push(op.id);
      }
      continue;
    }
    // Serialized leaf: try the `$implRef` index (the verified-implementation
    // registry the harness exposes). This is the path a graph read back from a
    // cell (`getRaw()`) takes — `module.implementation` is gone, but the live
    // function is still resolvable by its content-addressed ref.
    const ref = module?.$implRef;
    const resolved = ref && implRefResolver
      ? implRefResolver(ref.identity, ref.symbol)
      : undefined;
    if (typeof resolved === "function") {
      leafImpls.set(op.id, resolved as LeafImpl);
    } else {
      unresolvedLeafOps.push(op.id);
    }
  }
  return { leafImpls, unresolvedLeafOps };
}
