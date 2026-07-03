/**
 * Reactive Operation Graph (ROG) v2 — the runtime IR the Reactive Interpreter
 * executes as data (design: docs/specs/reactive-interpreter-v2/02-ir.md).
 *
 * This module defines the IR *types* plus small structural helpers — no
 * execution and no construction (the builder front-end records ops during
 * pattern construction; see 02-ir.md §2 and D-V2-SEQ).
 *
 * Lineage: evolved from PR #4298's rog.ts (the v1 IR). v2 deltas, per
 * 02-ir.md: tagged control branches (no positional-array convention), effect
 * ops carrying their full contract (inputs in `Op.inputs`, write-back targets
 * in `detail.writeTargets` — the F1/F4 edges by construction), leaf capability
 * annotations (compiler/builder-emitted, fail-closed hints only per NG-2),
 * inline collection element graphs (no runtime re-resolution), `fn`/`call`
 * (define-once helper functions + the curated pure-method stdlib), and a
 * `result` ValueRef kind (result self-references, v1's `__patternResult`
 * fallback class).
 */

import type { JSONSchema } from "../builder/types.ts";

/** An opaque schema reference. Carried inline for now; interning to a hashed
 * schema table is a planned artifact-size/perf optimization (02-ir.md §2.7),
 * deliberately not load-bearing for correctness. */
export type SchemaHandle = JSONSchema;

/**
 * Content-addressed handle to an opaque leaf implementation (`lift` /
 * `computed` body) or a nested pattern — the existing `$implRef` /
 * `$patternRef` sigil payload (`{ identity, symbol }`), resolved through the
 * session implementation index. Mirrors builder/json-utils serialization.
 */
export interface ImplRef {
  /** Content-addressed module identity (e.g. `cf:module/<hash>`). */
  identity: string;
  /** Export / `__cfReg` key naming the implementation within the module. */
  symbol: string;
}

export type OpId = number;

/** Id of a `FnDef` within the same Rog's `fns` table. */
export type FnId = number;

/** A path of static keys into a value (the lowered `.key(...)`). */
export type PathStep = string;

/** A reference into the graph's value space (02-ir.md §1/§2.3).
 *
 * `internal` refs point INTO this Rog's `internals` table by index
 * (D-V2-INTERNALS-TABLE) — never by stringified cause. Nested Rogs carry
 * their own table, so frame scoping falls out structurally. */
export type ValueRef =
  | { kind: "argument"; path: PathStep[] }
  | { kind: "opOut"; op: OpId; path: PathStep[] }
  | { kind: "const"; value: unknown }
  | { kind: "internal"; cell: number; path: PathStep[] }
  /** A read of an EXTERNALLY-identified cell (the builder saw
   * `export().external` — a pre-existing/well-known cell referenced in the
   * pattern body). Indexes this Rog's `externals` table; the dispatch binds
   * the stored reference and seeds the value (a plain external input, like
   * an argument — no producer). */
  | { kind: "external"; cell: number; path: PathStep[] }
  /** A reference to the pattern's own egress/result tree at `path` — the
   * result-self-reference shape (v1 fell back `unrecognized_alias` on it). */
  | { kind: "result"; path: PathStep[] };

/** A declared internal cell (a `cell()` / derived internal): its verbatim
 * partial cause (the existing deterministic naming scheme — a string name or
 * a `{ $generated: N, $kind? }` object) plus its schema when declared. The
 * cell may be written by an op (its producer) or only by boundaries
 * (handler-written state); the producer, if any, is `producedBy`. */
export interface InternalDecl {
  partialCause: unknown;
  schema?: SchemaHandle;
  producedBy?: OpId;
}

export type OpKind =
  | "leaf"
  | "pattern"
  | "collection"
  | "control"
  | "access"
  | "construct"
  | "interpolate"
  | "expr"
  | "call"
  | "effect";

export type CollectionOp = "map" | "filter" | "flatMap";
export type ControlOp = "ifElse" | "when" | "unless";
export type EffectSink = "render" | "pull" | "handler" | "io";

/**
 * The CLOSED set of JS operators the native `expr` op evaluates (carried
 * verbatim from v1 rog.ts / design 08 §2-3; the fail-closed allow-list E-2).
 * This is exactly the set whose JS semantics the evaluator reproduces
 * byte-for-byte and the differential oracle verifies — anything not here
 * stays a `leaf`.
 *
 * BINARY are all EAGER (both operands resolved) — arithmetic/comparison have
 * no short-circuit in JS. Bitwise/shift carry JS's int32/uint32 coercion;
 * `+` carries number/string coercion; `**` is exponentiation.
 *
 * UNARY are prefix-disambiguated from binary `-`/`+` by the `u` prefix
 * (`u-`/`u+`/`u~`/`u!`). `typeof` is DELIBERATELY EXCLUDED (v1 review E-3):
 * it clashes with the evaluator's `undefined`-on-unresolved convention.
 *
 * `&&`/`||`/`?:` are NOT here — logical/ternary remain `control` ops with the
 * exact operand-return + short-circuit semantics (v1 review E-1).
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

/** Runtime-readable allow-list mirroring the `ExprOp` union. Emitters and
 * the evaluator both consult this — an op not in the set falls back to the
 * leaf path (fail-closed on both sides of the artifact boundary). */
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

/**
 * Compiler/builder-emitted capability annotations on an opaque leaf
 * (02-ir.md §2.5). NG-2 discipline: these are FAIL-CLOSED HINTS — a set bit
 * can only force a boundary / fallback / read-only wrapping, never grant a
 * capability. A missing hazard bit degrades loudly (e.g. "Cannot store
 * Promise"), not silently.
 */
export interface LeafCaps {
  /** Body is `async` / returns a Promise. */
  async?: boolean;
  /** Body may instantiate a pattern (factory call). */
  instantiatesPattern?: boolean;
  /** Body writes into a cell handle it receives (asCell mutation). */
  writesInput?: boolean;
  /** Body needs a live Cell/Stream handle argument (asCell/asStream). */
  needsCellContext?: boolean;
}

/** A pure IR-level function: define once, invoke via `call` (02-ir.md §2.6).
 * The body Rog's `argument` space is the parameter tuple: parameter `i`
 * resolves as `{kind:"argument", path:[params[i]]}`. Pure by construction —
 * lowering refuses anything effectful (03-compiler-emission.md §3). */
export interface FnDef {
  id: FnId;
  params: string[];
  body: Rog;
}

/** Kind-specific detail. */
export type KindDetail =
  | {
    kind: "leaf";
    caps?: LeafCaps;
    /** Legacy `argumentSchema === false` bypass: the node runs even when its
     * resolved input is `undefined` (the no-argument lift the transformer
     * emits for capture-less computeds — `lift(() => ..., false)`). Without
     * this, the undefined-argument run-gate would starve constant
     * producers. */
    ungated?: true;
  }
  | {
    kind: "pattern";
    /** Serialized nested pattern's content-addressed handle (when known). */
    impl?: ImplRef;
    /** The bound argument the parent passes the sub-pattern, as a single
     * ValueRef in the PARENT frame. */
    argument: ValueRef;
    /** Present iff the nested pattern's graph is known at construction time
     * and inlined; absent ⇒ boundary (real child instantiation). */
    child?: Rog;
  }
  | {
    kind: "collection";
    op: CollectionOp;
    /** The element graph, INLINE (02-ir.md §2.1) — built once at pattern
     * construction; the interpreter never re-parses pattern bytes. */
    element?: Rog;
    /** Content-addressed element pattern ref (always recorded when known;
     * the fallback identity when `element` is absent). */
    elementRef?: ImplRef;
    listInput: ValueRef;
  }
  | {
    kind: "control";
    op: ControlOp;
    pred: ValueRef;
    /** Value when the predicate is TRUTHY. The literal `"pred"` means "the
     * predicate's own value" — fully normalized semantics, so the evaluator
     * has ONE rule (`truthy(pred) ? then : else`) and never special-cases
     * per op name (02-ir.md §2.2; v1 encoded this positionally and got it
     * wrong once). ifElse: {then: a, else: b} · when(c,v): {then: v,
     * else: "pred"} · unless(c,f): {then: "pred", else: f}. */
    then: ValueRef | "pred";
    /** Value when the predicate is FALSY (same "pred" convention). */
    else: ValueRef | "pred";
  }
  | { kind: "access"; path: PathStep[] }
  | { kind: "construct"; template: ConstructTemplate }
  /**
   * Native string interpolation — the lowered `str\`...\`` builtin (carried
   * from v1). The evaluator concatenates the static `strings` segments with
   * the resolved `values` byte-for-byte per the framework `interpolatedString`
   * body. `values` are MIRRORED in `op.inputs` (so inputsOf/topo/partition
   * surface them with no extra clause).
   */
  | { kind: "interpolate"; strings: string[]; values: ValueRef[] }
  /**
   * Native JS OPERATOR expression (carried from v1). `op` is one of the
   * closed `ExprOp` allow-list; operand refs are POSITIONAL in `inputs`
   * (binary = [left, right], unary = [operand]) and mirrored in `op.inputs`.
   */
  | { kind: "expr"; op: ExprOp; inputs: ValueRef[] }
  /**
   * Invocation of an IR-level function (02-ir.md §2.6): either a same-bundle
   * `FnDef` by id, or a curated pure-method stdlib entry by registry id
   * (e.g. "string.slice"). Args are MIRRORED in `op.inputs`. Exactly one of
   * `callee`/`builtin` is set; both/neither is malformed (validation
   * rejects). Unknown `builtin` ids are refused by the evaluator
   * (fail-closed across registry-version skew).
   */
  | { kind: "call"; callee?: FnId; builtin?: string; args: ValueRef[] }
  /**
   * A boundary op the interpreter never evaluates: I/O builtins, handlers,
   * render/pull sinks. Carries its FULL contract (02-ir.md §2.4): data
   * inputs ride in `op.inputs` (the F1 partition-cut + CFC read-through
   * edges); `writeTargets` are the cells this effect writes back into (the
   * F4 `S → handler → S` cycle-cut edges) — a WRITE edge class, surfaced via
   * `writesOf`, never via `inputsOf`.
   */
  | {
    kind: "effect";
    sink: EffectSink;
    /** Builtin ref name when the effect is a named builtin (fetchData,
     * generateText, ...). */
    builtin?: string;
    /** The materialized event-stream link name for handler sinks. */
    streamLink?: string;
    writeTargets: ValueRef[];
  };

/** Object/array assembly from sub-results. Leaves of the template are
 * ValueRefs. */
export type ConstructTemplate =
  | { shape: "object"; fields: Record<string, ValueRef> }
  | { shape: "array"; items: ValueRef[] };

export interface Op {
  id: OpId;
  kind: OpKind;
  /** Content-addressed impl for `leaf`; absent otherwise (pattern/collection
   * refs live in their detail). */
  impl?: ImplRef;
  /** Explicit, minimal READ inputs (no hidden lexical capture). The
   * producer-edge view: leaf ops carry their single structured input here;
   * interpolate/expr/call mirror their detail refs here; effect ops carry
   * their data inputs here. */
  inputs: ValueRef[];
  /** Result schema of this op (drives traversal / capability / label
   * structure). */
  outSchema: SchemaHandle;
  detail: KindDetail;
}

/**
 * The Reactive Operation Graph: the data form of a `Pattern`. `ops` are
 * topologically sortable; `result` is the returned value (the egress root).
 * Serialized as a versioned optional field on the pattern JSON — identity-
 * neutral (MUST NOT feed pattern hashing; D-V2-SEQ).
 */
export interface Rog {
  /** IR format version; bump on any shape change. */
  v: number;
  argumentSchema: SchemaHandle;
  resultSchema: SchemaHandle;
  /** The returned value expression (the egress root). */
  result: ValueRef;
  ops: Op[];
  /** Declared internal cells, referenced by `internal` ValueRefs by index. */
  internals: InternalDecl[];
  /** Externally-identified cells referenced by `external` ValueRefs by
   * index. Each entry is the cell's serialized external REFERENCE, exactly
   * what legacy `toJSONWithLegacyAliases` writes for it (json-utils: "if
   * external, copy the reference as is"). */
  externals?: unknown[];
  /** Same-bundle lowered helper functions, invoked via `call` ops. */
  fns?: FnDef[];
  /** Set when construction met a shape it could not represent: the ROG is
   * PARTIAL and flag-on dispatch must fall back to legacy for this pattern
   * (fail-closed). The reasons feed the construction census. */
  incomplete?: string[];
}

/** Current IR format version (see `Rog.v`). */
export const ROG_VERSION = 2;

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
  "call",
  "effect",
]);

/**
 * ValueRefs an op READS, for ordering / read-set derivation / CFC.
 *
 * `op.inputs` is the flat read list (leaf single input; interpolate values;
 * expr operands; call args; effect data inputs). Structural kinds carry their
 * meaningful refs in `detail`, unioned here: collection.listInput,
 * pattern.argument, control pred/then/else. Construct refs live in the
 * template (walked by `constructRefs`) — `inputsOf` is the producer-edge
 * view, not a full ref walk; callers needing template refs union
 * `constructRefs` explicitly (as v1 topoOrder did).
 *
 * Effect `writeTargets` are deliberately NOT here — they are a WRITE edge
 * class (`writesOf`), and conflating them would create false read
 * dependencies (and hide the F4 cycle the partition must cut on).
 */
export function inputsOf(op: Op): ValueRef[] {
  const extra: ValueRef[] = [];
  const d = op.detail;
  if (d.kind === "collection") extra.push(d.listInput);
  if (d.kind === "pattern") extra.push(d.argument);
  if (d.kind === "control") {
    extra.push(d.pred);
    if (d.then !== "pred") extra.push(d.then);
    if (d.else !== "pred") extra.push(d.else);
  }
  return [...op.inputs, ...extra];
}

/** ValueRefs an op WRITES outside its own output slot (effect write-back
 * targets — the F4 cut edges). Empty for every pure op. */
export function writesOf(op: Op): ValueRef[] {
  return op.detail.kind === "effect" ? op.detail.writeTargets : [];
}

/** The ValueRefs at the leaves of a construct template. */
export function constructRefs(template: ConstructTemplate): ValueRef[] {
  return template.shape === "object"
    ? Object.values(template.fields)
    : template.items;
}

/** Structural validation of a `call` detail: exactly one callee form. */
export function isWellFormedCall(
  d: Extract<KindDetail, { kind: "call" }>,
): boolean {
  return (d.callee !== undefined) !== (d.builtin !== undefined);
}
