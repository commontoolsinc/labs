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
  ImplRef,
  Op,
  OpId,
  OpKind,
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
  isEffect?: boolean;
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
const EFFECT_REFS = new Set(["navigateTo", "streamData"]);

export interface CoverageReport {
  /** Total nodes seen (this graph + nested element graphs). */
  nodes: number;
  /** Nodes whose module classified into a known OpKind. */
  classified: number;
  /** Per-kind counts. */
  byKind: Record<OpKind | "unknown", number>;
  /** Distinct `$alias` shapes that were NOT recognized (for follow-up). */
  unrecognizedAliases: string[];
  /** Nested element graphs recursed into. */
  nested: number;
}

function isPatternLike(m: unknown): m is RawPattern {
  return !!m && typeof m === "object" && Array.isArray((m as RawPattern).nodes);
}

function classifyModule(
  module: RawModule | RawPattern | undefined,
): { kind: OpKind; impl?: ImplRef; collOp?: CollectionOp; ctrlOp?: ControlOp } {
  if (isPatternLike(module)) return { kind: "pattern" };
  const m = (module ?? {}) as RawModule;
  if (m.$patternRef) return { kind: "pattern", impl: m.$patternRef };
  if (m.type === "pattern") return { kind: "pattern", impl: m.$patternRef };
  if (m.type === "javascript") {
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
    if (EFFECT_REFS.has(ref)) return { kind: "effect" };
    // Other builtins (fetch, llm, sqlite, str, ...) are opaque leaves.
    return { kind: "leaf" };
  }
  return { kind: "leaf" }; // conservative default; recorded as classified-leaf
}

/** Map a single `$alias` payload to a ValueRef, or null if unrecognized. */
function aliasToValueRef(
  alias: Record<string, unknown>,
  unrecognized: Set<string>,
): ValueRef | null {
  // FAIL CLOSED on `defer` — a non-zero defer level means the alias resolves
  // through one or more levels of nested-pattern indirection that the
  // interpreter does NOT model (see builder/json-utils.ts:87-98, where `defer`
  // is incremented during shadow-ref / nested-pattern serialization). Resolving
  // it as if it were a level-0 (non-deferred) ref would silently point at the
  // WRONG cell (not a throw, so the eligibility probe would not catch it).
  // Record it as unrecognized so the pattern falls back to the legacy path,
  // which handles deferred resolution.
  //
  // NOTE on `scope`: the fresh in-memory builder attaches `scope` to ordinary
  // top-level argument/internal aliases (builder/pattern.ts:349) at the
  // ELIGIBLE tier; that scope is the ambient/default frame the interpreter
  // already resolves against, and the prod-wire oracle confirms those patterns
  // interpret correctly. Failing closed on `scope` would regress real eligible
  // patterns, so we do NOT — only `defer` is the unmodeled, production-reachable
  // indirection that must fail closed here. `defer` is never emitted by the
  // fresh top-level builder, so this never regresses a currently-eligible
  // pattern.
  // Type-agnostic: any present, non-zero `defer` fails closed (the builder only
  // ever emits it as a number `(defer ?? 0) + 1`, but a hand-built / arbitrarily
  // serialized alias could carry a non-number `defer` — that too must not be
  // resolved as level-0).
  if ("defer" in alias && alias.defer !== 0) {
    unrecognized.add(JSON.stringify(Object.keys(alias).sort()));
    return null;
  }
  const path = ((alias.path as string[]) ?? []).map(String);
  if (alias.cell === "argument") return { kind: "argument", path };
  if (typeof alias.partialCause === "string") {
    return { kind: "internal", name: alias.partialCause, path };
  }
  if (
    alias.partialCause && typeof alias.partialCause === "object" &&
    "$generated" in (alias.partialCause as object)
  ) {
    const g = (alias.partialCause as { $generated: number }).$generated;
    return { kind: "internal", name: `$generated:${g}`, path };
  }
  unrecognized.add(JSON.stringify(Object.keys(alias).sort()));
  return null;
}

/** Marker recorded into `unrecognized` for a value that bears a `$alias` key but
 * is NOT a canonical legacy alias (non-record / non-array-path payload) or that
 * mixes `$alias` with sibling keys. Either makes the value unrepresentable as a
 * structured input. Recorded → the pattern is ineligible → legacy fallback. */
const MALFORMED_ALIAS_MARKER = '["$alias:malformed"]';

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
    return aliasToValueRef(obj.$alias as Record<string, unknown>, unrecognized);
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
): ValueRef {
  const direct = valueToRef(v, unrecognized);
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
      buildStructuredRef(el, unrecognized, ops, nextSynthId, bump)
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
    fields[k] = buildStructuredRef(el, unrecognized, ops, nextSynthId, bump);
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
): ValueRef[] {
  if (inputs === undefined || inputs === null) return [];
  const ref = buildStructuredRef(inputs, unrecognized, ops, nextSynthId, bump);
  return [ref];
}

/** Map an `outputs` alias to the internal-cell name it writes (the producing
 * op's output alias), matching `aliasToValueRef`'s `internal` naming so the
 * evaluator's `internalToOp` lookup keys line up. Returns null if the output is
 * not a recognizable internal alias. */
function outputInternalName(outputs: unknown): string | null {
  if (!outputs || typeof outputs !== "object") return null;
  const alias = (outputs as { $alias?: Record<string, unknown> }).$alias;
  if (!alias || typeof alias !== "object") return null;
  if (typeof alias.partialCause === "string") return alias.partialCause;
  if (
    alias.partialCause && typeof alias.partialCause === "object" &&
    "$generated" in (alias.partialCause as object)
  ) {
    return `$generated:${
      (alias.partialCause as { $generated: number }).$generated
    }`;
  }
  return null;
}

export interface ExtractResult {
  rog: Rog;
  coverage: CoverageReport;
  /** Internal-cell name (a node's output `partialCause`) → producing op id, so
   * the evaluator can resolve `internal` ValueRefs to `opOut`. Only the
   * top-level pattern's nodes are wired (nested element graphs are W3). */
  internalToOp: Map<string, OpId>;
}

export function extractRog(pattern: RawPattern): ExtractResult {
  const unrecognized = new Set<string>();
  const byKind = {} as Record<OpKind | "unknown", number>;
  const internalToOp = new Map<string, OpId>();
  let nodeCount = 0;
  let classified = 0;
  let nested = 0;

  const bump = (k: OpKind | "unknown") => {
    byKind[k] = (byKind[k] ?? 0) + 1;
  };

  // Synthesized ops (result construct + per-leaf structured-input constructs)
  // are NOT Pattern nodes; they get unique negative ids so they never collide
  // with node ids (== node index, >= 0) in the topo/byId maps.
  let synthCounter = 0;
  const nextSynthId = (): OpId => --synthCounter; // -1, -2, -3, ...

  function build(p: RawPattern, depth: number): Rog {
    const ops: Op[] = [];
    const nodes = p.nodes ?? [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      nodeCount++;
      const c = classifyModule(node.module);
      bump(c.kind);
      classified++; // every node classifies (leaf is the sound default)

      // Wire this node's output alias → its op id (top-level only for now), so
      // `internal` ValueRefs (result/input refs to derived cells) resolve.
      if (depth === 0) {
        const outName = outputInternalName(node.outputs);
        if (outName !== null) {
          internalToOp.set(outName, i);
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
      // value legacy passes. Collection/control/pattern/effect carry their
      // meaningful refs in `detail`, so their flat `inputs` stays empty (the
      // `detail` refs alone drive ordering + read-set derivation).
      const inputs = (c.kind === "leaf")
        ? inputRefs(node.inputs, unrecognized, ops, nextSynthId, bump)
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
          );
        let elementImpl: ImplRef = { identity: "<inline>", symbol: "op" };
        if (isPatternLike(inObj.op)) {
          nested++;
          build(inObj.op as RawPattern, depth + 1); // recurse for coverage
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
            : buildStructuredRef(v, unrecognized, ops, nextSynthId, bump);
        const pred = branchRef(inObj.condition ?? inObj.if);
        // Branches must be exactly [then, else] in that order — NOT the flat
        // `inputs` list (which also carries the condition). The builder names
        // them ifTrue/ifFalse (with then/else as legacy fallbacks).
        const thenRef = branchRef(inObj.ifTrue ?? inObj.then);
        const elseRef = branchRef(inObj.ifFalse ?? inObj.else);
        op.detail = {
          kind: "control",
          op: c.ctrlOp!,
          pred,
          branches: [thenRef, elseRef],
        };
      } else if (c.kind === "pattern") {
        op.detail = {
          kind: "pattern",
          rog: c.impl ?? { identity: "<inline>", symbol: "pattern" },
        };
      } else if (c.kind === "effect") {
        op.detail = { kind: "effect", sink: "handler" };
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
      : buildStructuredRef(p.result, unrecognized, ops, nextSynthId, bump);
    return {
      // deno-lint-ignore no-explicit-any
      argumentSchema: (p.argumentSchema ?? true) as any,
      // deno-lint-ignore no-explicit-any
      resultSchema: (p.resultSchema ?? true) as any,
      result: resultRef,
      ops,
    };
  }

  const rog = build(pattern, 0);
  return {
    rog,
    coverage: {
      nodes: nodeCount,
      classified,
      byKind,
      unrecognizedAliases: [...unrecognized],
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

export function resolveLeafImpls(
  pattern: RawPattern,
  rog: Rog,
  /** Optional fallback for serialized leaves whose `module.implementation` is no
   * longer a live callable but whose `$implRef` is resolvable (W1b-bridge over a
   * graph read back via `getRaw()`). */
  implRefResolver?: ImplRefResolver,
): { leafImpls: Map<OpId, LeafImpl>; unresolvedLeafOps: OpId[] } {
  const leafImpls = new Map<OpId, LeafImpl>();
  const unresolvedLeafOps: OpId[] = [];
  const nodes = pattern.nodes ?? [];
  for (const op of rog.ops) {
    if (op.detail.kind !== "leaf") continue;
    // Synthesized ops (id < 0) are never leaves; real leaf ops map 1:1 to nodes.
    const node = op.id >= 0 ? nodes[op.id] : undefined;
    const module = node?.module as RawModule | undefined;
    const impl = module?.implementation;
    if (typeof impl === "function") {
      leafImpls.set(op.id, impl as LeafImpl);
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
