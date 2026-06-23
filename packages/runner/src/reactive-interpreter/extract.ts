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
  OpKind,
  Rog,
  ValueRef,
} from "./rog.ts";

// The in-memory Pattern shape we read (a structural subset; see builder/types).
interface RawModule {
  type?: string;
  implementation?: string;
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
    const ref = m.implementation ?? "";
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

export interface ExtractResult {
  rog: Rog;
  coverage: CoverageReport;
}

export function extractRog(pattern: RawPattern): ExtractResult {
  const unrecognized = new Set<string>();
  const byKind = {} as Record<OpKind | "unknown", number>;
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
        op.detail = { kind: "control", op: c.ctrlOp!, pred, branches: inputs };
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
  };
}
