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
export type EffectSink = "render" | "pull" | "handler";

/** Kind-specific detail. */
export type KindDetail =
  | { kind: "leaf" }
  | { kind: "pattern"; rog: ImplRef }
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

/** ValueRefs an op reads, for ordering / read-set derivation. */
export function inputsOf(op: Op): ValueRef[] {
  const extra: ValueRef[] = [];
  if (op.detail.kind === "collection") extra.push(op.detail.listInput);
  if (op.detail.kind === "control") {
    extra.push(op.detail.pred, ...op.detail.branches);
  }
  return [...op.inputs, ...extra];
}
