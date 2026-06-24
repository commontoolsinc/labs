/**
 * ROG evaluator core (W1a) — the reactive-skeleton evaluation logic.
 *
 * This is the *pure* interpreter: given a ROG, an argument value, and a way to
 * run leaf implementations, it evaluates the non-collection vocabulary
 * (leaf / access / construct / control) and produces the result value. It is
 * deliberately decoupled from the runtime, the SES sandbox, the scheduler, and
 * CFC labels — those are the W1b *integration* (run real sandboxed leaves,
 * register reads, compute labels, materialize). Keeping the evaluation logic
 * pure makes it unit-testable in isolation and is the substrate W1b wraps.
 *
 * Not handled here (by design): `collection` (W3), nested `pattern` (W5), and
 * `effect` value production — those throw `NotInterpretedHere` so callers can
 * see the boundary explicitly rather than get a silent wrong value.
 *
 * Status: W1a. Verified by interpret.test.ts on hand-built ROGs.
 */

import type { Op, OpId, PathStep, Rog, ValueRef } from "./rog.ts";

/** A leaf implementation: receives its (single, structured) input, returns its
 * output. In W1b this is backed by the sandboxed lift; here it is injected. */
export type LeafImpl = (input: unknown) => unknown;

export interface EvalContext {
  /** The pattern argument value. */
  argument: unknown;
  /** Resolve a leaf op to its implementation (by op id). */
  leafImpls: Map<OpId, LeafImpl>;
  /** Optional: map an internal cell name to the op that produces it, so
   * `internal` refs resolve to that op's output (populated by extraction
   * wiring; absent in pure hand-built tests that use `opOut` directly). */
  internalToOp?: Map<string, OpId>;
  /**
   * Optional SEED of pre-computed op values (coalescing partition, step 3). When
   * a ROG is evaluated as a SEGMENT — a sub-op-set of a larger graph — some of
   * its `internal`/`opOut` refs name producers that live OUTSIDE the segment (an
   * upstream boundary's output, or an earlier segment's materialized output). The
   * partition dispatch feeds those external values in here keyed by their op id,
   * so `resolve`'s `internal`/`opOut` lookups find them in `opValues` from the
   * start (the segment never re-derives a producer it does not own). Empty /
   * absent for the whole-pattern interpreter and pure hand-built tests — fully
   * backward-compatible (no current caller passes a seed).
   */
  seed?: Map<OpId, unknown>;
  /**
   * PROBE MODE (eligibility dry-run only). When true, leaf BODIES are NOT
   * invoked — every leaf op resolves to `undefined`. The eligibility verdict is
   * reached purely structurally (coverage gates + `resolveLeafImpls`'
   * structural pattern/context gates); the leaf bodies then run exactly ONCE in
   * the first real node action. This preserves legacy laziness on a RE-
   * INSTANTIATION (the pattern-watcher re-instantiating a child pattern with an
   * already-COMMITTED argument): legacy never runs a lift body during
   * instantiation, so a body-executing probe would spuriously re-run a
   * side-effecting lift (doubling `runCount`). The non-probe call (first real
   * run) executes bodies normally and feeds the result through. The
   * already-present structural gates (`liveLeafCanInstantiatePattern`,
   * schema/Cell-context, async/Promise/Cell return-value nets on the first real
   * run) catch the cases the dry-run's value guard used to.
   */
  probe?: boolean;
}

export class NotInterpretedHere extends Error {
  constructor(kind: string, message?: string) {
    super(
      message ?? `ROG evaluator (W1a) does not handle op kind "${kind}" yet`,
    );
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
 * Topologically order ops so an op's dependencies precede it. The builder
 * already emits nodes in a valid order, but control-flow/data edits — and, in
 * the coalescing partition, the per-segment op REGROUPING — can perturb it, so
 * we sort defensively. Cycles (shouldn't occur in a well-formed ROG) fall back
 * to declared order.
 *
 * `internalToOp` (optional) lets an `internal` ref's PRODUCER op be ordered
 * before its consumer. Without it, two leaves both reading the SAME upstream op
 * via a NAMED internal alias (e.g. `str` interpolating `${branchKind}` and
 * `${branchVariant}`, where each is a `computed` materialized under an internal
 * cell) are ordered only by declared appearance — so a consumer that appears
 * before its producer in `ops` resolves the producer's value as `undefined`.
 * (The partition can place a `str` construct before a sibling computed it reads.)
 */
export function topoOrder(
  ops: Op[],
  internalToOp?: Map<string, OpId>,
): Op[] {
  const byId = new Map<OpId, Op>(ops.map((o) => [o.id, o]));
  const visited = new Set<OpId>();
  const onStack = new Set<OpId>();
  const out: Op[] = [];
  const depsOf = (op: Op): OpId[] => {
    const ids: OpId[] = [];
    const collect = (r: ValueRef) => {
      if (r.kind === "opOut" && byId.has(r.op)) ids.push(r.op);
      else if (r.kind === "internal" && internalToOp) {
        const producer = internalToOp.get(r.name);
        if (producer !== undefined && byId.has(producer)) ids.push(producer);
      }
    };
    for (const r of op.inputs) collect(r);
    if (op.detail.kind === "collection") collect(op.detail.listInput);
    if (op.detail.kind === "pattern") collect(op.detail.argument);
    if (op.detail.kind === "control") {
      collect(op.detail.pred);
      op.detail.branches.forEach(collect);
    }
    if (op.detail.kind === "construct") {
      const t = op.detail.template;
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
      const d = byId.get(dep);
      if (d) visit(d);
    }
    onStack.delete(op.id);
    visited.add(op.id);
    out.push(op);
  };
  for (const op of ops) visit(op);
  return out;
}

/** Evaluate a ROG to its result value, plus the per-op value map (for tests
 * and, later, incremental reuse). */
export function evalRog(
  rog: Rog,
  ctx: EvalContext,
): {
  result: unknown;
  opValues: Map<OpId, unknown>;
  /** Runtime errors caught (each isolated to `undefined`) per throwing op. The
   * interpreter node reports these to `scheduler.onError` so a throwing leaf
   * fires onError exactly as legacy's per-node materialization does (downstream
   * still reads `undefined`). `NotInterpretedHere` is NOT collected here — it
   * re-throws and routes to legacy fallback. */
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
        const opId = ctx.internalToOp?.get(ref.name);
        if (opId === undefined) return undefined; // unwired internal (W1a)
        return navigate(opValues.get(opId), ref.path);
      }
    }
  };

  const evalOp = (op: Op): unknown => {
    switch (op.detail.kind) {
      case "leaf": {
        const impl = ctx.leafImpls.get(op.id);
        // A missing leaf impl is a STRUCTURAL "cannot interpret this op" wiring
        // failure, not a runtime error — propagate it as NotInterpretedHere so
        // the per-op isolation re-throws it and the caller falls back to legacy
        // (never silently isolates it to `undefined`). Unreachable in production
        // (resolveLeafImpls + the `unresolved_leaf` gate pre-empt it), but
        // defense-in-depth: a wiring bug must fail closed, not mis-evaluate.
        if (!impl) {
          throw new NotInterpretedHere(
            "leaf",
            `no leaf impl for op ${op.id} (unresolved)`,
          );
        }
        // PROBE MODE: never invoke a leaf body. The eligibility verdict is
        // structural; the body runs exactly once in the first real run. Skipping
        // execution here preserves legacy laziness on a re-instantiation (a
        // pattern-watcher re-instantiating a child pattern whose argument is
        // already committed) — a body-executing probe would spuriously re-run a
        // side-effecting lift. A still-missing-or-throwing impl is caught above /
        // by the first-real-run nets; structural pattern/context/async gates
        // (resolveLeafImpls + dry-value backstops) cover the rest.
        if (ctx.probe) return undefined;
        // A leaf takes its SINGLE structured input — the exact resolved value
        // legacy passes (a keyed object/array assembled by a preceding
        // synthesized construct, or a direct ref). Extraction guarantees a leaf
        // has at most one input ref; with none, the leaf is called with
        // undefined. NEVER a positional array (that would feed `add({a,b})` an
        // array and silently yield NaN/`{}`).
        // A leaf with NO input ref legitimately accepts `undefined` (legacy's
        // `argumentSchema === false` bypass: a no-argument lift runs and may
        // produce a constant); call it as before.
        if (op.inputs.length === 0) return impl(undefined);
        const input = resolve(op.inputs[0]);
        // UNDEFINED-ARGUMENT RUN-GATE (legacy parity). Legacy gates each node on
        // `isValidArgument = argument !== undefined` (runner.ts `if
        // (isValidArgument)`) before invoking, so a node whose resolved input is
        // strictly `undefined` is gated OUT and stays `undefined` WITHOUT running
        // its body. This matters for CHAINED lifts: when an upstream leaf throws
        // (its op value isolated to `undefined`), the downstream leaf reading it
        // must NOT execute against `undefined` (which would yield e.g.
        // `healthy: undefined`); it must stay `undefined` too. This does NOT
        // regress error isolation (R4): a leaf reading a DEFINED input still runs
        // and a genuine throw is still caught + reported below.
        if (input === undefined) return undefined;
        return impl(input);
      }
      case "access":
        return navigate(resolve(op.inputs[0]), op.detail.path);
      case "construct": {
        const t = op.detail.template;
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
        const cond = resolve(op.detail.pred);
        const [thenRef, elseRef] = op.detail.branches;
        // Real builtin semantics (built-in.ts):
        //   ifElse(condition, ifTrue, ifFalse) = cond ? ifTrue : ifFalse
        //   when(condition, value)   = cond ? value : condition
        //   unless(condition, fallback) = cond ? condition : fallback
        // thenRef = ifTrue/value branch, elseRef = ifFalse/fallback branch.
        // The off-branch of when/unless returns the CONDITION (the resolved
        // `pred`), NOT undefined.
        switch (op.detail.op) {
          case "ifElse":
            return cond ? resolve(thenRef) : resolve(elseRef);
          case "when":
            return cond ? resolve(thenRef) : cond;
          case "unless":
            return cond ? cond : resolve(elseRef);
        }
        return undefined;
      }
      case "collection":
        throw new NotInterpretedHere("collection"); // W3
      case "pattern": {
        // INLINED, in-memory, PURE-COMPUTATION nested pattern: evaluate its
        // sub-Rog directly, in this same action, against the parent-resolved
        // bound argument. No child docs are minted (the doc-explosion legacy
        // cost being removed) — the value flows through the parent's single
        // result egress. A SERIALIZED ($patternRef, no `.nodes`) nested pattern
        // has `inlined === undefined`: throw NotInterpretedHere so it propagates
        // (the per-op isolation RE-THROWS NotInterpretedHere) → legacy fallback
        // before any write, exactly as before.
        const { inlined, argument } = op.detail;
        if (!inlined) throw new NotInterpretedHere("pattern");
        const { result } = evalRog(inlined.rog, {
          argument: resolve(argument),
          leafImpls: inlined.leafImpls ?? new Map(),
          internalToOp: inlined.internalToOp,
          probe: ctx.probe,
        });
        return result;
      }
      case "effect":
        throw new NotInterpretedHere("effect");
    }
  };

  for (const op of topoOrder(rog.ops, ctx.internalToOp)) {
    if (op.id < 0) {
      // synthesized result construct (from extraction) — evaluate it too.
    }
    // PER-OP ERROR ISOLATION (legacy parity). Legacy materializes each node
    // separately, so when a leaf/computed body THROWS a runtime error the
    // failure is contained to that node: its value resolves to `undefined`,
    // downstream nodes that read it get `undefined`, and the rest of the
    // pattern still computes (verified empirically against legacy: an
    // independent `safe` leaf still produces its value while the throwing
    // `poisoned` leaf yields `undefined`). The interpreter evaluates the whole
    // ROG in one action, so without this catch a single throwing leaf would
    // throw the entire node and corrupt/miss the whole result. We mirror legacy
    // by isolating the throw to this op's value (`undefined`) and continuing.
    //
    // CRITICAL: `NotInterpretedHere` is NOT a runtime error — it is a
    // STRUCTURAL signal that this op kind cannot be interpreted (collection /
    // pattern / effect, or an unexpected kind). It MUST propagate so the caller
    // falls back to legacy. We re-throw it rather than isolate it.
    let value: unknown;
    try {
      value = evalOp(op);
    } catch (e) {
      if (e instanceof NotInterpretedHere) throw e;
      // Runtime error from a leaf body: isolate the op VALUE to `undefined`
      // (downstream parity) AND surface the error so the interpreter node reports
      // it to scheduler.onError — matching legacy per-node containment + error
      // reporting (a throwing computed fires onError; downstream reads undefined).
      errors.push({ opId: op.id, error: e });
      value = undefined;
    }
    opValues.set(op.id, value);
  }

  return { result: resolve(rog.result), opValues, errors };
}
