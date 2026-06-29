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
  | "interpolate"
  | "expr"
  | "effect";

export type CollectionOp = "map" | "filter" | "flatMap";
export type ControlOp = "ifElse" | "when" | "unless";
export type EffectSink = "render" | "pull" | "handler" | "io";

/**
 * The CLOSED set of JS operators the native `expr` op evaluates (design
 * 08-expression-interpretation §2/§3; the fail-closed allow-list E-2). This is
 * exactly the set whose JS semantics the evaluator reproduces byte-for-byte and
 * the differential oracle verifies — anything not here stays a `leaf` fallback.
 *
 * BINARY are all EAGER (both operands resolved) — arithmetic/comparison have no
 * short-circuit in JS. The bitwise/shift ops carry JS's int32/uint32 coercion;
 * `+` carries number/string coercion; `**` is exponentiation.
 *
 * UNARY are prefix-disambiguated from the binary `-`/`+` by the `u` prefix
 * (`u-`/`u+`/`u~`/`u!`). `typeof` is DELIBERATELY EXCLUDED from v1 (review E-3):
 * it clashes with the evaluator's `undefined`-on-unresolved convention.
 *
 * `&&`/`||`/`?:` are NOT here — logical/ternary remain `control` ops (the
 * builtin `when`/`unless`/`ifElse` lowering), which already interpret natively
 * with the exact operand-return + short-circuit semantics (interpret.ts
 * `control` case). Adding redundant `expr` kinds for them would only duplicate
 * machinery (resolves OQ-E3: keep `control`).
 */
export type ExprBinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "&"
  | "|"
  | "^"
  | "<<"
  | ">>"
  | ">>>"
  | "<"
  | ">"
  | "<="
  | ">="
  | "=="
  | "==="
  | "!="
  | "!==";
export type ExprUnOp = "u-" | "u+" | "u~" | "u!";
export type ExprOp = ExprBinOp | ExprUnOp;

/** The runtime-readable allow-list (mirrors the `ExprOp` union, since a `Set`
 * cannot be derived from a type). The recognizer (extract.ts) and the evaluator
 * (interpret.ts) both consult this — a brand whose `op` is NOT in this set falls
 * back to the leaf path (fail-closed). */
export const EXPR_BIN_OPS: ReadonlySet<ExprBinOp> = new Set<ExprBinOp>([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
  "<",
  ">",
  "<=",
  ">=",
  "==",
  "===",
  "!=",
  "!==",
]);
export const EXPR_UN_OPS: ReadonlySet<ExprUnOp> = new Set<ExprUnOp>([
  "u-",
  "u+",
  "u~",
  "u!",
]);

/** Is `op` a member of the closed `ExprOp` allow-list? */
export function isExprOp(op: string): op is ExprOp {
  return EXPR_BIN_OPS.has(op as ExprBinOp) || EXPR_UN_OPS.has(op as ExprUnOp);
}

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
  /**
   * Native string interpolation — the lowered `str\`...${x}...\`` builtin (the
   * first concrete `expr`-family op, design 08-expression-interpretation §2).
   * Replaces the `str` SES leaf-over-construct: the evaluator concatenates the
   * static `strings` segments with the resolved `values` BYTE-FOR-BYTE per the
   * framework `interpolatedString` body (built-in.ts). `strings` is carried
   * INLINE (a fully static literal array — the universal transformer-emitted
   * template shape); `values` are the `${...}` ValueRefs, MIRRORED here AND in
   * `op.inputs` (so `inputsOf`/`topoOrder`/partition surface them with no extra
   * code). An op is emitted only for a recognized static-template `str` leaf;
   * any other str shape falls back to the leaf path (extract.ts
   * `recognizeStrLeaf`). Never a `leaf`, so `resolveLeafImpls` skips it — no
   * `$implRef`/SES round-trip (the serialized-boundary shrink + the perf win).
   */
  | { kind: "interpolate"; strings: string[]; values: ValueRef[] }
  /**
   * Native JS OPERATOR expression — the lowered arithmetic / comparison / unary
   * operator the transformer auto-wraps (design 08-expression-interpretation
   * §2/§3). Replaces the opaque lift leaf the transformer emits for `a + b`,
   * `x === y`, `!flag`, `-n`, etc.: the evaluator applies the operator to its
   * resolved operands with EXACT JS semantics (interpret.ts `expr` case) — no
   * `$implRef`/SES round-trip (the serialized-boundary shrink + perf win).
   *
   * `op` is one of the closed `ExprOp` allow-list. The operand refs are carried
   * POSITIONALLY in `inputs` (binary = `[left, right]`, unary = `[operand]`) AND
   * MIRRORED into `op`'s own `inputs` field (so `inputsOf`/`topoOrder`/partition/
   * CFC surface them with no extra clause — exactly the interpolate pattern).
   *
   * An op is emitted ONLY for a recognized branded (`$builtin: "expr:<op>"`) lift
   * leaf whose operator is in the allow-list AND whose operand refs reconstruct
   * cleanly; any other shape falls back to the leaf path (extract.ts
   * `recognizeExprLeaf`). Never a `leaf`, so `resolveLeafImpls` skips it.
   */
  | { kind: "expr"; op: ExprOp; inputs: ValueRef[] }
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
  "interpolate",
  "expr",
  "effect",
]);

/** ValueRefs an op reads, for ordering / read-set derivation.
 *
 * `op.inputs` is the flat input list: leaf ops carry their single structured
 * input there, INTERPOLATE ops carry their `${...}` value refs there, EXPR ops
 * carry their positional operand refs there (so the partition/topo/CFC machinery
 * surfaces them with no extra clause), and EFFECT
 * (boundary) ops carry the flat list of value-producer alias leaves the boundary
 * reads (extraction's `effectInputRefs`, event streams excluded) — the
 * `boundary←producer` edges the partitioner (§4.2) and the CFC read-through
 * (§4.5) consume. The structural op kinds carry their meaningful
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
