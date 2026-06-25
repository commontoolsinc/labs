/**
 * Reactive Operation Graph (ROG) — the runtime IR the Reactive Interpreter
 * executes as data (design: docs/specs/reactive-interpreter/02-design.md §1.1).
 *
 * This module defines the IR *type* only — no execution (that is W1+) and no
 * extraction (that is `extract.ts`, W0.4). It is the data form of the operation
 * graph the transformer already produces: a flat, schema-annotated graph over a
 * small closed vocabulary, with leaf computations referenced by content-
 * addressed identity (the existing `$implRef` / `$patternRef` sigils) and kept
 * opaque.
 *
 * Status: W0 scaffolding. The shape tracks 02-design §1.1; fields may tighten as
 * the extraction (W0.4) and interpreter (W1+) pin down what is actually needed.
 */

import type { JSONSchema } from "../builder/types.ts";

/** An opaque, hashed schema reference. For W0 we carry the schema inline (the
 * transformer already inlines them); a later pass may intern to a hash handle. */
export type SchemaHandle = JSONSchema;

/**
 * Content-addressed handle to a leaf implementation (`lift`/`computed` body) or
 * a nested pattern — the existing `$implRef` / `$patternRef` sigil payload
 * (`{ identity, symbol }`), resolved through the session implementation index.
 * Mirrors builder/json-utils serialization; not re-derived here.
 */
export interface ImplRef {
  /** Content-addressed module identity (e.g. `cf:module/<hash>`). */
  identity: string;
  /** Export / `__cfReg` key naming the implementation within the module. */
  symbol: string;
}

export type OpId = number;

/** A path of static or known-symbol keys into a value (the lowered `.key(...)`). */
export type PathStep = string;

/** A reference into the graph's value space (02-design §1.1). */
export type ValueRef =
  | { kind: "argument"; path: PathStep[] }
  | { kind: "opOut"; op: OpId; path: PathStep[] }
  | { kind: "const"; value: unknown }
  | { kind: "internal"; name: string; path: PathStep[] };

export type OpKind =
  | "leaf"
  | "pattern"
  | "collection"
  | "control"
  | "access"
  | "construct"
  | "effect";

export type CollectionOp = "map" | "filter" | "flatMap";
export type ControlOp = "ifElse" | "when" | "unless";
export type EffectSink = "render" | "pull" | "handler" | "io";

/** An inlined, in-memory nested pattern: the sub-pattern's own ROG plus the
 * local wiring needed to evaluate it in isolation against a resolved argument.
 * `internalToOp` is LOCAL to the sub-Rog (its internal-cell names resolve within
 * the child's own node space, never the parent's). `leafImpls` is filled in by
 * the `resolveLeafImpls` pass (per-detail; parent + child op ids both start at 0
 * — they are never merged into one flat map). Absent (`undefined` on the detail)
 * ⇒ the nested pattern was serialized ($patternRef, no in-memory `.nodes`) ⇒
 * fail closed → legacy. */
export interface InlinedPattern {
  rog: Rog;
  /** Internal-cell name → producing op id, LOCAL to this sub-Rog's nodes. */
  internalToOp: Map<string, OpId>;
  /** Leaf op id → its live implementation (the LeafImpl shape), filled by the
   * resolve pass. Structurally `(input: unknown) => unknown` to avoid a cyclic
   * import from the evaluator; identical to `interpret.ts`'s `LeafImpl`. */
  leafImpls?: Map<OpId, (input: unknown) => unknown>;
}

/** Kind-specific detail. */
export type KindDetail =
  | { kind: "leaf" }
  | {
    kind: "pattern";
    /** Serialized nested pattern's content-addressed handle (when not inlined). */
    impl?: ImplRef;
    /** The bound argument the parent passes the sub-pattern (the pattern node's
     * `inputs`, reconstructed losslessly as a single ValueRef in the PARENT
     * frame). Resolved by the evaluator and handed to the sub-Rog as its
     * `argument`. */
    argument: ValueRef;
    /** Present iff the nested pattern is an in-memory PURE computation that was
     * inlined; absent ⇒ serialized / out-of-scope ⇒ fail closed. */
    inlined?: InlinedPattern;
  }
  | {
    kind: "collection";
    op: CollectionOp;
    elementRog: ImplRef;
    listInput: ValueRef;
  }
  | { kind: "control"; op: ControlOp; pred: ValueRef; branches: ValueRef[] }
  | { kind: "access"; path: PathStep[] }
  | { kind: "construct"; template: ConstructTemplate }
  | { kind: "effect"; sink: EffectSink; link?: string };

/** Object/array assembly from sub-results (the object-property / array-element
 * lowering sites). Leaves of the template are ValueRefs. */
export type ConstructTemplate =
  | { shape: "object"; fields: Record<string, ValueRef> }
  | { shape: "array"; items: ValueRef[] };

export interface Op {
  id: OpId;
  kind: OpKind;
  /** Content-addressed impl for `leaf` / `pattern`; absent otherwise. */
  impl?: ImplRef;
  /** Explicit, minimal inputs (no hidden lexical capture). */
  inputs: ValueRef[];
  /** Result schema of this op (drives traversal / capability / label structure). */
  outSchema: SchemaHandle;
  detail: KindDetail;
}

/**
 * The Reactive Operation Graph: the data form of a `Pattern`. `ops` are
 * topologically sortable; `result` is the returned value (the root of the
 * materialization closure). Corresponds to the normalized authored graph the
 * CFC formalization models.
 */
export interface Rog {
  argumentSchema: SchemaHandle;
  resultSchema: SchemaHandle;
  /** The returned value expression (the egress root). */
  result: ValueRef;
  ops: Op[];
}

// --- Small total helpers (no execution; structural only) -------------------

/** Operation kinds the interpreter interprets directly (everything else is a
 * `leaf` — opaque sandboxed JS). */
export const INTERPRETED_KINDS: ReadonlySet<OpKind> = new Set([
  "pattern",
  "collection",
  "control",
  "access",
  "construct",
  "effect",
]);

/** ValueRefs an op reads, for ordering / read-set derivation.
 *
 * `op.inputs` is the flat input list: leaf ops carry their single structured
 * input there, and EFFECT (boundary) ops carry the flat list of value-producer
 * alias leaves the boundary reads (extraction's `effectInputRefs`, event streams
 * excluded) — the `boundary←producer` edges the partitioner (§4.2) and the CFC
 * read-through (§4.5) consume. The structural op kinds carry their meaningful
 * refs in `detail` instead, so we union those in: collection.listInput,
 * pattern.argument, control.pred + branches. (construct refs live in the
 * template; topoOrder reads them directly, so they are intentionally not
 * surfaced here — `inputsOf` is the producer-edge view, not a full ref walk.) */
export function inputsOf(op: Op): ValueRef[] {
  const extra: ValueRef[] = [];
  if (op.detail.kind === "collection") extra.push(op.detail.listInput);
  if (op.detail.kind === "pattern") extra.push(op.detail.argument);
  if (op.detail.kind === "control") {
    extra.push(op.detail.pred, ...op.detail.branches);
  }
  return [...op.inputs, ...extra];
}
