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

import type { CellScope } from "../builder/types.ts";
import { scopeRank } from "../scope.ts";
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
  /** TRANSIENT collection ops admitted for in-memory evaluation
   * (D-V2-TRANSIENT-COLLECTIONS): op id → the element's BuiltRog plus which
   * child-argument fields its ROG actually reads. Absent for an op ⇒ the
   * op is a boundary here (structural fallback, as before). */
  collections?: Map<OpId, {
    elementBuilt: BuiltRog;
    usage: {
      usesElement: boolean;
      usesIndex: boolean;
      usesArray: boolean;
      usesParams: boolean;
    };
  }>;
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
  /**
   * SCOPE FLOW-TRACKING (per-op narrowest-read-scope): the scopes at which
   * the segment's SEED reads resolved, per input class. When present, the
   * evaluator propagates a per-op scope through the dataflow (an op's scope
   * = the NARROWEST scope among the values it consumed) and returns it in
   * `opScopes` — the segment's write seam routes each op's output at that
   * scope, reproducing legacy's PER-NODE-ACTION scope routing (one ambient
   * tx-wide scope would over-narrow siblings that never read scoped data).
   */
  scopes?: {
    argument?: CellScope;
    byOp?: Map<OpId, CellScope>;
    byInternal?: Map<number, CellScope>;
    byExternal?: Map<number, CellScope>;
    byLeafInput?: Map<OpId, CellScope>;
  };
  /**
   * Bracket ONE op's execution for scope observation (dispatch-supplied,
   * tx-backed). Leaf inputs are LAZY (query-result proxies): the deref of a
   * scoped link often happens inside the leaf BODY, not during the seed
   * read — so each op run is bracketed and the observed scope folds into
   * that op's derived scope. `onScope` fires in a finally (observed even
   * when fn throws); the fn's throw propagates unchanged.
   */
  runScoped?: <T>(fn: () => T, onScope: (scope: CellScope) => void) => T;
  /**
   * DEMAND-DRIVEN evaluation (native control emission, W8): when present,
   * ops evaluate on demand from these roots (memoized recursion) instead of
   * the full forward pass, and a `control` op demands its predicate plus the
   * TAKEN side only — R-CONTROL-READS: the run's read-set never exceeds
   * predicate-inputs ∪ active-branch-inputs. Ops reachable only through an
   * untaken side never run: no reads, no errors, no scope. Absent ⇒ the
   * eager forward pass (byte-identical legacy-parity semantics, both
   * branches evaluated — elements and probe callers stay on this).
   */
  demandRoots?: readonly OpId[];
  /**
   * LAZY input readers (fused segments): branch-gated seed keys are carved
   * OUT of the segment's eager input read and land here as thunks that read
   * through the tx at demand time — inside the demanding op's scope bracket,
   * journaled only when actually consumed. Memoized per key (one read per
   * run, matching the eager path's read-once). `argumentByPath` replaces the
   * whole-argument value with per-path reads (an untaken branch's argument
   * link is never dereferenced).
   */
  lazy?: {
    argumentByPath?: (path: readonly PathStep[]) => unknown;
    byOp?: Map<OpId, () => unknown>;
    byInternal?: Map<number, () => unknown>;
    byExternal?: Map<number, () => unknown>;
    byLeafInput?: Map<OpId, () => unknown>;
  };
  /**
   * Fused control ops whose RETAINED output prefers a REFERENCE write: when
   * the taken side is a bare ref (external cell / argument path / upstream
   * alias / externally-written internal), `handleFor` builds the live cell
   * handle (identity reads only — never content) and the evaluator records
   * it in `controlHandles`; the write seam forwards it as a link, exactly
   * legacy's reference-passthrough. A computed/const side has no handle and
   * materializes by value instead.
   */
  controlRefOutputs?: {
    ids: ReadonlySet<OpId>;
    handleFor: (ref: ValueRef) => unknown;
  };
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
    if (d.kind === "collection") {
      collect(d.listInput);
      if (d.params) collect(d.params);
    }
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
  /** Per-op derived scope (present iff `ctx.scopes` was supplied). */
  opScopes: Map<OpId, CellScope>;
  /** Reference handles for fused control outputs (`ctx.controlRefOutputs`):
   * op id → the live cell of the TAKEN side, to be written as a link. */
  controlHandles: Map<OpId, unknown>;
} {
  const opValues = new Map<OpId, unknown>(ctx.seed ?? []);
  const errors: Array<{ opId: OpId; error: unknown }> = [];
  const controlHandles = new Map<OpId, unknown>();
  const byId = new Map<OpId, Op>(rog.ops.map((o) => [o.id, o]));
  const demandMode = ctx.demandRoots !== undefined;
  /** Which side a demand-mode control actually took (for scope folding —
   * the static fold would join the UNTAKEN side's scope). */
  const controlTaken = new Map<OpId, ValueRef | "pred">();
  // Lazy-read memos (one read per run, like the eager bulk read).
  const lazyMemo = {
    byOp: new Map<OpId, unknown>(),
    byInternal: new Map<number, unknown>(),
    byExternal: new Map<number, unknown>(),
    byLeafInput: new Map<OpId, unknown>(),
    argumentByPath: new Map<string, unknown>(),
  };
  const lazyRead = <K>(
    memo: Map<K, unknown>,
    thunks: Map<K, () => unknown> | undefined,
    key: K,
  ): { present: boolean; value?: unknown } => {
    if (memo.has(key)) return { present: true, value: memo.get(key) };
    const thunk = thunks?.get(key);
    if (!thunk) return { present: false };
    const value = thunk();
    memo.set(key, value);
    return { present: true, value };
  };

  // --- scope flow-tracking (see EvalContext.scopes) -------------------------
  const trackScopes = ctx.scopes !== undefined;
  const opScopes = new Map<OpId, CellScope>();
  const narrower = (a: CellScope, b: CellScope): CellScope =>
    scopeRank(b) > scopeRank(a) ? b : a;
  const scopeOfRef = (ref: ValueRef): CellScope => {
    switch (ref.kind) {
      case "const":
        return "space";
      case "argument":
        return ctx.scopes?.argument ?? "space";
      case "opOut":
        return opScopes.get(ref.op) ?? ctx.scopes?.byOp?.get(ref.op) ??
          "space";
      case "internal": {
        const producer = internalProducer(rog.internals, ref.cell);
        if (producer !== undefined && opScopes.has(producer)) {
          return opScopes.get(producer)!;
        }
        return ctx.scopes?.byInternal?.get(ref.cell) ?? "space";
      }
      case "external":
        return ctx.scopes?.byExternal?.get(ref.cell) ?? "space";
      case "result":
        return "space";
    }
  };
  const opScopeOf = (op: Op): CellScope => {
    const d = op.detail;
    // An override-fed leaf consumed EXACTLY that read (its refs were not
    // resolved) — the read's own scope is the op's scope.
    if (d.kind === "leaf" && ctx.leafInputOverrides?.has(op.id)) {
      return ctx.scopes?.byLeafInput?.get(op.id) ?? "space";
    }
    let s: CellScope = "space";
    const fold = (ref: ValueRef | "pred") => {
      if (ref !== "pred") s = narrower(s, scopeOfRef(ref));
    };
    for (const ref of op.inputs) fold(ref);
    if (d.kind === "collection") {
      fold(d.listInput);
      if (d.params) fold(d.params);
    }
    if (d.kind === "pattern") fold(d.argument);
    if (d.kind === "control") {
      fold(d.pred);
      // Demand mode: fold the TAKEN side only — the static both-sides fold
      // would join the untaken side's scope into the write (legacy scopes a
      // control result by what the action actually read).
      const taken = controlTaken.get(op.id);
      if (demandMode) {
        if (taken !== undefined && taken !== "pred") fold(taken);
      } else {
        fold(d.then);
        fold(d.else);
      }
    }
    if (d.kind === "construct") {
      const t = d.template;
      const refs = t.shape === "object" ? Object.values(t.fields) : t.items;
      for (const ref of refs) fold(ref);
    }
    return s;
  };

  const resolve = (ref: ValueRef): unknown => {
    switch (ref.kind) {
      case "const":
        return ref.value;
      case "argument": {
        // Per-path lazy argument (fused segments): dereference exactly the
        // consumed path, at demand time — an untaken branch's argument link
        // is never followed.
        if (ctx.lazy?.argumentByPath) {
          const key = JSON.stringify(ref.path);
          if (!lazyMemo.argumentByPath.has(key)) {
            lazyMemo.argumentByPath.set(
              key,
              ctx.lazy.argumentByPath(ref.path),
            );
          }
          return lazyMemo.argumentByPath.get(key);
        }
        return navigate(ctx.argument, ref.path);
      }
      case "opOut": {
        if (byId.has(ref.op)) {
          demand(ref.op);
          return navigate(opValues.get(ref.op), ref.path);
        }
        if (opValues.has(ref.op)) {
          return navigate(opValues.get(ref.op), ref.path);
        }
        const lazy = lazyRead(lazyMemo.byOp, ctx.lazy?.byOp, ref.op);
        return lazy.present ? navigate(lazy.value, ref.path) : undefined;
      }
      case "internal": {
        const producer = internalProducer(rog.internals, ref.cell);
        if (producer !== undefined && byId.has(producer)) {
          demand(producer);
          return navigate(opValues.get(producer), ref.path);
        }
        if (producer !== undefined && opValues.has(producer)) {
          return navigate(opValues.get(producer), ref.path);
        }
        if (ctx.seedByInternal?.has(ref.cell)) {
          return navigate(ctx.seedByInternal.get(ref.cell), ref.path);
        }
        const lazy = lazyRead(
          lazyMemo.byInternal,
          ctx.lazy?.byInternal,
          ref.cell,
        );
        return lazy.present ? navigate(lazy.value, ref.path) : undefined;
      }
      case "external": {
        if (ctx.seedByExternal?.has(ref.cell)) {
          return navigate(ctx.seedByExternal.get(ref.cell), ref.path);
        }
        const lazy = lazyRead(
          lazyMemo.byExternal,
          ctx.lazy?.byExternal,
          ref.cell,
        );
        return lazy.present ? navigate(lazy.value, ref.path) : undefined;
      }
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
        const lazyOverride = !ctx.leafInputOverrides?.has(op.id) &&
            ctx.lazy?.byLeafInput?.has(op.id)
          ? lazyRead(lazyMemo.byLeafInput, ctx.lazy.byLeafInput, op.id)
          : undefined;
        const hasOverride = (ctx.leafInputOverrides?.has(op.id) ?? false) ||
          (lazyOverride?.present ?? false);
        if (!hasOverride && op.inputs.length === 0) return impl(undefined);
        let input = lazyOverride?.present
          ? lazyOverride.value
          : hasOverride
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
        //
        // Demand mode resolves the TAKEN side only (R-CONTROL-READS): the
        // untaken side's producer never runs, its lazy inputs are never
        // read. Eager mode is unchanged — both producers already ran in the
        // forward pass; `resolve` is a memo lookup.
        const unwrap = ctx.unwrapCellForValue ?? ((v: unknown) => v);
        const cond = unwrap(resolve(d.pred));
        const taken = cond ? d.then : d.else;
        controlTaken.set(op.id, taken);
        // Retained fused control: forward the taken side as a REFERENCE
        // when it is a bare ref (identity-only handle; the write seam links
        // it — legacy passthrough). The VALUE below is still the in-memory
        // semantics for any consumer op.
        if (ctx.controlRefOutputs?.ids.has(op.id)) {
          const ref = taken === "pred" ? d.pred : taken;
          if (isBareRef(ref)) {
            const handle = ctx.controlRefOutputs.handleFor(ref);
            if (handle !== undefined) controlHandles.set(op.id, handle);
          }
        }
        return taken === "pred" ? cond : resolve(taken);
      }
      case "collection": {
        // TRANSIENT (segment-resident) collections only — the dispatch
        // admits an op here iff its output is value-consumed (never
        // retained). Everything else stays a boundary node.
        const inline = ctx.collections?.get(op.id);
        if (!inline) throw new NotInterpretedHere("collection");
        if (ctx.probe) return undefined;
        const rawList = resolve(d.listInput);
        // Legacy containers SEED [] for an undefined input list — the
        // downstream reader's view is [], so the in-memory view matches.
        if (rawList === undefined) return [];
        if (!Array.isArray(rawList)) {
          throw new Error(`${d.op} currently only supports arrays`);
        }
        const params = d.params !== undefined ? resolve(d.params) : undefined;
        const { elementBuilt, usage } = inline;
        const evalElement = (item: unknown, index: number): unknown => {
          const argument: Record<string, unknown> = {};
          if (usage.usesElement) argument.element = item;
          if (usage.usesIndex) argument.index = index;
          if (usage.usesParams) argument.params = params;
          if (usage.usesArray) argument.array = rawList;
          const child = evalRog(elementBuilt.rog, {
            argument,
            leafImpls: elementBuilt.leafImpls,
            children: elementBuilt.children,
            probe: ctx.probe,
            unwrapCellForValue: ctx.unwrapCellForValue,
          });
          // Element errors isolate PER ELEMENT (legacy child parity) and
          // surface on THIS op's error channel.
          for (const err of child.errors) {
            errors.push({ opId: op.id, error: err.error });
          }
          return child.result;
        };
        // Sparse holes: legacy coordinators SKIP holes (no run, no slot
        // write) — the container keeps the hole, and a doc round-trip
        // renders it as an absent entry. In memory, map preserves the hole
        // (skipped index), filter/flatMap simply contribute nothing.
        if (d.op === "map") {
          const out = new Array<unknown>(rawList.length);
          for (let i = 0; i < rawList.length; i++) {
            if (!(i in rawList)) continue;
            out[i] = evalElement(rawList[i], i);
          }
          return out;
        }
        if (d.op === "filter") {
          const out: unknown[] = [];
          for (let i = 0; i < rawList.length; i++) {
            if (!(i in rawList)) continue;
            if (evalElement(rawList[i], i)) out.push(rawList[i]);
          }
          return out;
        }
        // flatMap (legacy contribute parity, byte-for-byte the builtin's
        // `elemResult.forEach((v) => out.push(v))`): array → forEach
        // (SKIPS holes in the returned array — a spread would materialize
        // them as `undefined` — and no spread argument-limit blowup on
        // large results); defined non-array → push the value itself;
        // undefined → contributes nothing (legacy's "pending" has no
        // meaning in a one-pass in-memory evaluation).
        {
          const out: unknown[] = [];
          for (let i = 0; i < rawList.length; i++) {
            if (!(i in rawList)) continue;
            const piece = evalElement(rawList[i], i);
            if (Array.isArray(piece)) piece.forEach((v) => out.push(v));
            else if (piece !== undefined) out.push(piece);
          }
          return out;
        }
      }
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

  /** Bare ref = names an addressable cell outside this evaluation (never a
   * value computed in-memory here): eligible for reference-passthrough. */
  const isBareRef = (ref: ValueRef): boolean => {
    if (ref.kind === "external" || ref.kind === "argument") return true;
    if (ref.kind === "opOut") return !byId.has(ref.op);
    if (ref.kind === "internal") {
      const producer = internalProducer(rog.internals, ref.cell);
      return producer === undefined || !byId.has(producer);
    }
    return false;
  };

  const bracket = trackScopes ? ctx.runScoped : undefined;
  const evaluated = new Set<OpId>();
  const evaluating = new Set<OpId>();

  /** Evaluate op `id` once (memoized), with PER-OP ERROR ISOLATION (legacy
   * parity — see module doc). In the eager pass this runs in topo order so
   * `resolve` never recurses (producers are memo hits); in demand mode it
   * recurses producers-first, brackets nesting (inner scopes propagate out
   * through the bracket's finally). */
  function demand(id: OpId): unknown {
    if (evaluated.has(id)) return opValues.get(id);
    const op = byId.get(id);
    if (!op || evaluating.has(id)) return opValues.get(id); // seeded / cycle
    evaluating.add(id);
    let value: unknown;
    let runScope: CellScope = "space";
    try {
      try {
        value = bracket
          ? bracket(() => evalOp(op), (s) => runScope = s)
          : evalOp(op);
      } catch (e) {
        if (e instanceof NotInterpretedHere) throw e;
        errors.push({ opId: op.id, error: e });
        value = undefined;
      }
    } finally {
      evaluating.delete(id);
    }
    evaluated.add(id);
    opValues.set(op.id, value);
    // Scope derives from CONSUMED refs + the reads the op's own execution
    // performed (lazy leaf-input derefs) — independent of the op's outcome
    // (an isolated error still writes `undefined` at the op's derived
    // scope, exactly like the legacy per-node action would).
    if (trackScopes) {
      const derived = opScopeOf(op);
      opScopes.set(
        op.id,
        scopeRank(runScope) > scopeRank(derived) ? runScope : derived,
      );
    }
    return value;
  }

  /** Root-drive a handle-preferred fused control WITHOUT forcing its value:
   * evaluate the predicate, pick the side, build the bare-ref handle. Only
   * when the side is computed (no handle possible) does the value
   * materialize via a full demand. */
  function demandControlHandle(id: OpId): void {
    const op = byId.get(id);
    if (!op || op.detail.kind !== "control") {
      demand(id);
      return;
    }
    const d = op.detail;
    let runScope: CellScope = "space";
    let handled = false;
    try {
      const run = () => {
        const unwrap = ctx.unwrapCellForValue ?? ((v: unknown) => v);
        const cond = unwrap(resolve(d.pred));
        const taken = cond ? d.then : d.else;
        controlTaken.set(op.id, taken);
        const ref = taken === "pred" ? d.pred : taken;
        if (isBareRef(ref)) {
          const handle = ctx.controlRefOutputs!.handleFor(ref);
          if (handle !== undefined) {
            controlHandles.set(op.id, handle);
            return true;
          }
        }
        return false;
      };
      handled = bracket ? bracket(run, (s) => runScope = s) : run();
    } catch (e) {
      if (e instanceof NotInterpretedHere) throw e;
      errors.push({ opId: op.id, error: e });
      // A throwing predicate isolates exactly like the eager path: the op's
      // slot materializes as `undefined` below.
      handled = false;
    }
    if (handled) {
      if (trackScopes) {
        const derived = opScopeOf(op);
        opScopes.set(
          op.id,
          scopeRank(runScope) > scopeRank(derived) ? runScope : derived,
        );
      }
      return;
    }
    demand(id); // computed side (or isolated error): materialize by value.
  }

  if (demandMode) {
    for (const id of ctx.demandRoots!) {
      if (ctx.controlRefOutputs?.ids.has(id)) demandControlHandle(id);
      else demand(id);
    }
  } else {
    for (const op of topoOrder(rog.ops, rog.internals)) demand(op.id);
  }

  return {
    result: resolve(rog.result),
    opValues,
    errors,
    opScopes,
    controlHandles,
  };
}
