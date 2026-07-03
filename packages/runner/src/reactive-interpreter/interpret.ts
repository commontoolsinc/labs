/**
 * ROG v2 evaluator core — the reactive-skeleton evaluation logic.
 *
 * The *pure* interpreter: given a Rog, an argument value, and the live
 * side-car state (leaf impls, inlined children), it evaluates the
 * non-collection vocabulary and produces the result value. Deliberately
 * decoupled from the runtime, the scheduler, and CFC — those are the
 * dispatch integration's job (04-execution.md). Purity keeps it
 * unit-testable and is the substrate segments wrap.
 *
 * Semantics ported faithfully from PR #4298's interpret.ts (v1), which
 * matched them empirically to legacy per-node materialization:
 *
 * - PER-OP ERROR ISOLATION: a throwing op's value is `undefined`, downstream
 *   still computes, the error is surfaced for scheduler.onError parity.
 *   `NotInterpretedHere` is STRUCTURAL and always re-throws (→ legacy
 *   fallback before any write).
 * - UNDEFINED-ARGUMENT RUN-GATE for LEAVES ONLY (legacy gates node bodies on
 *   `argument !== undefined`); native interpolate/expr ops deliberately have
 *   NO gate — their bodies coerce undefined exactly as the lift bodies they
 *   replace did (`str\`${undefined}\`` → "undefined", `-undefined` → NaN).
 * - PROBE MODE never invokes leaf bodies (pure-structural eligibility; the
 *   v1 D-PROBE-MEMOIZE lesson — a body-executing probe double-runs
 *   side-effecting lifts on re-instantiation).
 * - CONTROL is fully normalized in the IR (then/else each "value-or-pred"),
 *   so evaluation is ONE rule: `truthy(pred) ? side(then) : side(else)`
 *   with `"pred"` resolving to the (unwrapped) predicate value. This
 *   reproduces the builtins exactly: ifElse(c,a,b)=c?a:b, when(c,v)=c?v:c,
 *   unless(c,f)=c?c:f.
 */

import {
  type ExprOp,
  type InternalDecl,
  type Op,
  type OpId,
  type PathStep,
  type Rog,
  type ValueRef,
} from "./rog.ts";
import type { BuiltRog } from "./from-builder.ts";

export interface EvalContext {
  /** The pattern argument value. */
  argument: unknown;
  /** Live leaf implementations by op id (from the BuiltRog side-car). */
  leafImpls: Map<OpId, (input: unknown) => unknown>;
  /** Inlined nested patterns' BuiltRogs by `pattern` op id. */
  children?: Map<OpId, BuiltRog>;
  /**
   * SEED of pre-computed op values (segment evaluation): a segment's refs may
   * name producers OUTSIDE the segment (an upstream boundary's output, an
   * earlier segment's output). The dispatch feeds those values here keyed by
   * op id, so `resolve` finds them from the start.
   */
  seed?: Map<OpId, unknown>;
  /**
   * SEED by INTERNALS-TABLE INDEX: values of internal cells no op in this
   * (sub-)graph produces — handler-written `cell(...)` state and
   * derivedInternalCells defaults, read through the tx by the dispatch.
   */
  seedByInternal?: Map<number, unknown>;
  /** SEED by EXTERNALS-TABLE INDEX: values of externally-identified cells
   * (`external` ValueRefs), read through the tx by the dispatch. */
  seedByExternal?: Map<number, unknown>;
  /** PROBE MODE: never invoke leaf bodies; verdicts are structural only. */
  probe?: boolean;
  /** Unwrap a live Cell HANDLE to its value for control predicates (an
   * `ifElse(enabledCell, …)` predicate must see the boolean, not the always-
   * truthy handle). Identity when absent. Reads journal through the caller's
   * tx (CFC + reactivity parity). */
  unwrapCellForValue?: (value: unknown) => unknown;
  /** Read-only Cell view overlay for producer-fed context leaves (v1 2(b)):
   * op id → input field names to wrap via `wrapReadOnlyValue`. */
  inputCellViews?: Map<OpId, ReadonlySet<string>>;
  /**
   * PRE-RESOLVED leaf inputs (fully-external leaves): the dispatch reads a
   * leaf's ORIGINAL input alias tree through the leaf's own argumentSchema
   * (legacy `readJavaScriptArgument` semantics — schema defaults,
   * validation), and hands the value here. Present ⇒ the leaf skips
   * ref-resolution and uses this value (run-gate still applies).
   */
  leafInputOverrides?: Map<OpId, unknown>;
  /** Wrap a plain value in a read-only Cell view (runner-supplied). */
  wrapReadOnlyValue?: (value: unknown) => unknown;
}

/** Structural "this op cannot be interpreted here" — always propagates to
 * the dispatch (→ legacy fallback), never isolated to `undefined`. */
export class NotInterpretedHere extends Error {
  constructor(kind: string, message?: string) {
    super(message ?? `ROG evaluator does not handle op kind "${kind}"`);
    this.name = "NotInterpretedHere";
  }
}

/** Navigate a value by a path of keys (the lowered `.key(...)` chain). */
export function navigate(value: unknown, path: readonly PathStep[]): unknown {
  let cur = value;
  for (const step of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[step];
  }
  return cur;
}

/**
 * Apply a native `expr` operator to its RESOLVED operands with EXACT JS
 * semantics — each arm is the literal JS operator so coercion is JS's own,
 * byte-for-byte the lift body it replaces (ported verbatim from v1).
 */
// deno-lint-ignore no-explicit-any
export function applyExprOp(op: ExprOp, operands: unknown[]): any {
  // deno-lint-ignore no-explicit-any
  const a = operands[0] as any;
  // deno-lint-ignore no-explicit-any
  const b = operands[1] as any;
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "%":
      return a % b;
    case "**":
      return a ** b;
    case "&":
      return a & b;
    case "|":
      return a | b;
    case "^":
      return a ^ b;
    case "<<":
      return a << b;
    case ">>":
      return a >> b;
    case ">>>":
      return a >>> b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
    case "==":
      return a == b;
    case "===":
      return a === b;
    case "!=":
      return a != b;
    case "!==":
      return a !== b;
    case "u-":
      return -a;
    case "u+":
      return +a;
    case "u~":
      return ~a;
    case "u!":
      return !a;
  }
}

/** Producer op of an `internal` ref, from the Rog's own internals table. */
function internalProducer(
  internals: InternalDecl[],
  cell: number,
): OpId | undefined {
  return internals[cell]?.producedBy;
}

/**
 * Topologically order ops so dependencies precede consumers. The builder
 * emits nodes in graph-walk order (construct ops appended after), so sorting
 * is defensive; cycles (malformed graph) fall back to declared order via the
 * on-stack guard. `internal` refs order through the internals table's
 * `producedBy`.
 */
export function topoOrder(ops: Op[], internals: InternalDecl[]): Op[] {
  const byId = new Map<OpId, Op>(ops.map((o) => [o.id, o]));
  const visited = new Set<OpId>();
  const onStack = new Set<OpId>();
  const out: Op[] = [];
  const depsOf = (op: Op): OpId[] => {
    const ids: OpId[] = [];
    const collect = (r: ValueRef | "pred") => {
      if (r === "pred") return;
      if (r.kind === "opOut" && byId.has(r.op)) ids.push(r.op);
      else if (r.kind === "internal") {
        const producer = internalProducer(internals, r.cell);
        if (producer !== undefined && byId.has(producer)) ids.push(producer);
      }
    };
    for (const r of op.inputs) collect(r);
    const d = op.detail;
    if (d.kind === "collection") collect(d.listInput);
    if (d.kind === "pattern") collect(d.argument);
    if (d.kind === "control") {
      collect(d.pred);
      collect(d.then);
      collect(d.else);
    }
    if (d.kind === "construct") {
      const t = d.template;
      const refs = t.shape === "object" ? Object.values(t.fields) : t.items;
      refs.forEach(collect);
    }
    return ids;
  };
  const visit = (op: Op) => {
    if (visited.has(op.id)) return;
    if (onStack.has(op.id)) return; // cycle guard
    onStack.add(op.id);
    for (const dep of depsOf(op)) {
      const depOp = byId.get(dep);
      if (depOp) visit(depOp);
    }
    onStack.delete(op.id);
    visited.add(op.id);
    out.push(op);
  };
  for (const op of ops) visit(op);
  return out;
}

/** Evaluate a Rog to its result value, plus the per-op value map and the
 * isolated runtime errors (for scheduler.onError parity). */
export function evalRog(
  rog: Rog,
  ctx: EvalContext,
): {
  result: unknown;
  opValues: Map<OpId, unknown>;
  errors: Array<{ opId: OpId; error: unknown }>;
} {
  const opValues = new Map<OpId, unknown>(ctx.seed ?? []);
  const errors: Array<{ opId: OpId; error: unknown }> = [];

  const resolve = (ref: ValueRef): unknown => {
    switch (ref.kind) {
      case "const":
        return ref.value;
      case "argument":
        return navigate(ctx.argument, ref.path);
      case "opOut":
        return navigate(opValues.get(ref.op), ref.path);
      case "internal": {
        const producer = internalProducer(rog.internals, ref.cell);
        if (producer !== undefined && opValues.has(producer)) {
          return navigate(opValues.get(producer), ref.path);
        }
        if (ctx.seedByInternal?.has(ref.cell)) {
          return navigate(ctx.seedByInternal.get(ref.cell), ref.path);
        }
        return undefined;
      }
      case "external":
        return navigate(ctx.seedByExternal?.get(ref.cell), ref.path);
      case "result":
        // Result-self-reference: needs the dispatch's materialized result
        // cell (the value is only complete after this evaluation). Not
        // evaluable in the pure core — structural fallback.
        throw new NotInterpretedHere(
          "result",
          "result-self-reference needs dispatch support",
        );
    }
  };

  const evalOp = (op: Op): unknown => {
    const d = op.detail;
    switch (d.kind) {
      case "leaf": {
        const impl = ctx.leafImpls.get(op.id);
        // Missing impl = STRUCTURAL wiring failure — fail closed, never
        // silently isolate to `undefined` (defense-in-depth; the dispatch
        // gates on the census before ever getting here).
        if (!impl) {
          throw new NotInterpretedHere(
            "leaf",
            `no leaf impl for op ${op.id} (unresolved)`,
          );
        }
        if (ctx.probe) return undefined;
        // A leaf takes its SINGLE structured input; none ⇒ called with
        // undefined (legacy's no-argument lift runs and may produce a
        // constant).
        const hasOverride = ctx.leafInputOverrides?.has(op.id) ?? false;
        if (!hasOverride && op.inputs.length === 0) return impl(undefined);
        let input = hasOverride
          ? ctx.leafInputOverrides!.get(op.id)
          : resolve(op.inputs[0]);
        const fieldsToWrap = ctx.inputCellViews?.get(op.id);
        if (
          fieldsToWrap && fieldsToWrap.size > 0 && ctx.wrapReadOnlyValue &&
          input !== null && typeof input === "object" && !Array.isArray(input)
        ) {
          const overlaid: Record<string, unknown> = {
            ...(input as Record<string, unknown>),
          };
          for (const field of fieldsToWrap) {
            if (Object.hasOwn(overlaid, field)) {
              overlaid[field] = ctx.wrapReadOnlyValue(overlaid[field]);
            }
          }
          input = overlaid;
        }
        // UNDEFINED-ARGUMENT RUN-GATE (legacy parity; leaves ONLY — see
        // module doc). Chained lifts: an upstream throw isolates to
        // `undefined`, and the downstream leaf must NOT execute against it.
        // `ungated` = the legacy `argumentSchema === false` bypass (the
        // transformer's capture-less computeds run with undefined).
        if (input === undefined && !d.ungated) return undefined;
        return impl(input);
      }
      case "interpolate": {
        // BYTE-FOR-BYTE the framework `interpolatedString` body. NO
        // undefined-run-gate: `+` coercion must see undefined→"undefined".
        const { strings } = d;
        const n = op.inputs.length;
        let out = "";
        for (let i = 0; i < strings.length; i++) {
          out = out + strings[i] + (i < n ? resolve(op.inputs[i]) : "");
        }
        return out;
      }
      case "expr":
        // EAGER by design (JS operators don't short-circuit); NO
        // undefined-run-gate (operator coercion is the body).
        return applyExprOp(d.op, op.inputs.map(resolve));
      case "call":
        throw new NotInterpretedHere("call"); // W6 (fn/stdlib invocation)
      case "access":
        return navigate(resolve(op.inputs[0]), d.path);
      case "construct": {
        const t = d.template;
        if (t.shape === "object") {
          const obj: Record<string, unknown> = {};
          for (const [k, ref] of Object.entries(t.fields)) {
            obj[k] = resolve(ref);
          }
          return obj;
        }
        return t.items.map(resolve);
      }
      case "control": {
        // ONE rule over normalized tags (see module doc): the predicate is
        // unwrapped from a live Cell handle when the hook is supplied — and
        // a "pred" side returns that UNWRAPPED value (legacy returns the
        // condition VALUE, not a handle).
        const unwrap = ctx.unwrapCellForValue ?? ((v: unknown) => v);
        const cond = unwrap(resolve(d.pred));
        const side = (s: ValueRef | "pred"): unknown =>
          s === "pred" ? cond : resolve(s);
        return cond ? side(d.then) : side(d.else);
      }
      case "collection":
        throw new NotInterpretedHere("collection"); // W4 dispatch path
      case "pattern": {
        // INLINED pure-computation nested pattern: evaluate its sub-Rog in
        // this same action against the parent-resolved bound argument — no
        // child docs (the doc-explosion cost being removed). Without an
        // inlined child (boundary / plain-JSON pattern) → fallback.
        const childBuilt = ctx.children?.get(op.id);
        if (!childBuilt || childBuilt.rog.incomplete?.length) {
          throw new NotInterpretedHere("pattern");
        }
        const { result } = evalRog(childBuilt.rog, {
          argument: resolve(d.argument),
          leafImpls: childBuilt.leafImpls,
          children: childBuilt.children,
          probe: ctx.probe,
          unwrapCellForValue: ctx.unwrapCellForValue,
        });
        return result;
      }
      case "effect":
        throw new NotInterpretedHere("effect");
    }
  };

  for (const op of topoOrder(rog.ops, rog.internals)) {
    // PER-OP ERROR ISOLATION (legacy parity — see module doc).
    let value: unknown;
    try {
      value = evalOp(op);
    } catch (e) {
      if (e instanceof NotInterpretedHere) throw e;
      errors.push({ opId: op.id, error: e });
      value = undefined;
    }
    opValues.set(op.id, value);
  }

  return { result: resolve(rog.result), opValues, errors };
}
