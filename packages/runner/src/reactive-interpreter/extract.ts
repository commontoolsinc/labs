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

/** Best-effort: pull the first recognizable ValueRef out of a value/alias tree. */
function valueToRef(
  v: unknown,
  unrecognized: Set<string>,
): ValueRef | null {
  if (v === null || typeof v !== "object") {
    return { kind: "const", value: v };
  }
  const obj = v as Record<string, unknown>;
  if (obj.$alias && typeof obj.$alias === "object") {
    return aliasToValueRef(obj.$alias as Record<string, unknown>, unrecognized);
  }
  return null; // structured input (object/array of refs) — W1 handles templates
}

/** Collect ValueRefs from a node's input tree (one level of object/alias). */
function inputRefs(inputs: unknown, unrecognized: Set<string>): ValueRef[] {
  const out: ValueRef[] = [];
  if (!inputs || typeof inputs !== "object") return out;
  const top = valueToRef(inputs, unrecognized);
  if (top) return [top];
  for (const v of Object.values(inputs as Record<string, unknown>)) {
    const r = valueToRef(v, unrecognized);
    if (r) out.push(r);
  }
  return out;
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
        if (outName !== null) internalToOp.set(outName, i);
      }

      const inputs = inputRefs(node.inputs, unrecognized);
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
        const listRef = valueToRef(inObj.list, unrecognized) ??
          ({ kind: "const", value: undefined } as ValueRef);
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
        const pred = valueToRef(inObj.condition ?? inObj.if, unrecognized) ??
          ({ kind: "const", value: undefined } as ValueRef);
        // Branches must be exactly [then, else] in that order — NOT the flat
        // `inputs` list (which also carries the condition). The builder names
        // them ifTrue/ifFalse (with then/else as legacy fallbacks).
        const thenRef = valueToRef(inObj.ifTrue ?? inObj.then, unrecognized) ??
          ({ kind: "const", value: undefined } as ValueRef);
        const elseRef = valueToRef(inObj.ifFalse ?? inObj.else, unrecognized) ??
          ({ kind: "const", value: undefined } as ValueRef);
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
    // construct), not a single alias. Recognize that and synthesize a construct
    // op so the result resolves instead of silently dropping to const.
    const resultRef = buildResultRef(p.result, ops, unrecognized);
    return {
      // deno-lint-ignore no-explicit-any
      argumentSchema: (p.argumentSchema ?? true) as any,
      // deno-lint-ignore no-explicit-any
      resultSchema: (p.resultSchema ?? true) as any,
      result: resultRef,
      ops,
    };
  }

  function buildResultRef(
    result: unknown,
    ops: Op[],
    unrecognized: Set<string>,
  ): ValueRef {
    const direct = valueToRef(result, unrecognized);
    if (direct) return direct;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const fields: Record<string, ValueRef> = {};
      for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
        fields[k] = valueToRef(v, unrecognized) ??
          ({ kind: "const", value: undefined } as ValueRef);
      }
      const id = -1; // synthesized result construct (not a Pattern node)
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
    if (Array.isArray(result)) {
      const items = result.map((v) =>
        valueToRef(v, unrecognized) ??
          ({ kind: "const", value: undefined } as ValueRef)
      );
      const id = -1;
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
    return { kind: "const", value: result };
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
export function resolveLeafImpls(
  pattern: RawPattern,
  rog: Rog,
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
    } else {
      unresolvedLeafOps.push(op.id);
    }
  }
  return { leafImpls, unresolvedLeafOps };
}
