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
}

export class NotInterpretedHere extends Error {
  constructor(kind: string) {
    super(`ROG evaluator (W1a) does not handle op kind "${kind}" yet`);
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
 * Topologically order ops so an op's `opOut` dependencies precede it. The
 * builder already emits nodes in a valid order, but control-flow/data edits can
 * perturb it, so we sort defensively. Cycles (shouldn't occur in a well-formed
 * ROG) fall back to declared order.
 */
export function topoOrder(ops: Op[]): Op[] {
  const byId = new Map<OpId, Op>(ops.map((o) => [o.id, o]));
  const visited = new Set<OpId>();
  const onStack = new Set<OpId>();
  const out: Op[] = [];
  const depsOf = (op: Op): OpId[] => {
    const ids: OpId[] = [];
    const collect = (r: ValueRef) => {
      if (r.kind === "opOut" && byId.has(r.op)) ids.push(r.op);
    };
    for (const r of op.inputs) collect(r);
    if (op.detail.kind === "collection") collect(op.detail.listInput);
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
): { result: unknown; opValues: Map<OpId, unknown> } {
  const opValues = new Map<OpId, unknown>();

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
        if (!impl) throw new Error(`no leaf impl for op ${op.id}`);
        // A leaf takes its single structured input (built by a preceding
        // construct, or a direct ref). With no inputs it takes undefined.
        const input = op.inputs.length === 1
          ? resolve(op.inputs[0])
          : op.inputs.map(resolve);
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
        switch (op.detail.op) {
          case "ifElse":
            return cond ? resolve(thenRef) : resolve(elseRef);
          case "when":
            return cond ? resolve(thenRef) : undefined;
          case "unless":
            return cond ? undefined : resolve(thenRef);
        }
        return undefined;
      }
      case "collection":
        throw new NotInterpretedHere("collection"); // W3
      case "pattern":
        throw new NotInterpretedHere("pattern"); // W5
      case "effect":
        throw new NotInterpretedHere("effect");
    }
  };

  for (const op of topoOrder(rog.ops)) {
    if (op.id < 0) {
      // synthesized result construct (from extraction) — evaluate it too.
    }
    opValues.set(op.id, evalOp(op));
  }

  return { result: resolve(rog.result), opValues };
}
