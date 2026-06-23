/**
 * W1a — ROG evaluator core, unit-tested on hand-built ROGs.
 *
 * Verifies the non-collection evaluation semantics (leaf / access / construct /
 * control), value-ref resolution (argument / const / opOut / internal), and
 * defensive topological ordering, against expected values computed in plain JS.
 * Leaves are injected (W1b backs them with the sandbox).
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  evalRog,
  type LeafImpl,
  NotInterpretedHere,
  topoOrder,
} from "../../src/reactive-interpreter/interpret.ts";
import type { Op, Rog } from "../../src/reactive-interpreter/rog.ts";

const T = true as unknown as Rog["resultSchema"];

describe("W1a ROG evaluator core", () => {
  it("leaf consuming a construct of argument fields", () => {
    // ROG for: ({a,b}) => ({ sum: add({x:a, y:b}) })
    //   op0 construct {x: arg.a, y: arg.b}
    //   op1 leaf add(op0)
    //   result construct { sum: op1 }
    const ops: Op[] = [
      {
        id: 0,
        kind: "construct",
        inputs: [],
        outSchema: T,
        detail: {
          kind: "construct",
          template: {
            shape: "object",
            fields: {
              x: { kind: "argument", path: ["a"] },
              y: { kind: "argument", path: ["b"] },
            },
          },
        },
      },
      {
        id: 1,
        kind: "leaf",
        inputs: [{ kind: "opOut", op: 0, path: [] }],
        outSchema: T,
        detail: { kind: "leaf" },
      },
      {
        id: 2,
        kind: "construct",
        inputs: [],
        outSchema: T,
        detail: {
          kind: "construct",
          template: {
            shape: "object",
            fields: { sum: { kind: "opOut", op: 1, path: [] } },
          },
        },
      },
    ];
    const rog: Rog = {
      argumentSchema: T,
      resultSchema: T,
      result: { kind: "opOut", op: 2, path: [] },
      ops,
    };
    const add: LeafImpl = (input) => {
      const { x, y } = input as { x: number; y: number };
      return x + y;
    };
    const { result } = evalRog(rog, {
      argument: { a: 3, b: 4 },
      leafImpls: new Map([[1, add]]),
    });
    expect(result).toEqual({ sum: 7 });
  });

  it("multi-input leaf receives the structured (keyed) value, not a positional array", () => {
    // Mirrors extraction output for `add({a,b})`: a synthesized object construct
    // (negative id) re-keys {a,b}, and the leaf's SINGLE input is that construct.
    // The leaf body reads i.a / i.b — a positional array would yield NaN.
    const ops: Op[] = [
      {
        id: -1,
        kind: "construct",
        inputs: [],
        outSchema: T,
        detail: {
          kind: "construct",
          template: {
            shape: "object",
            fields: {
              a: { kind: "argument", path: ["a"] },
              b: { kind: "argument", path: ["b"] },
            },
          },
        },
      },
      {
        id: 0,
        kind: "leaf",
        inputs: [{ kind: "opOut", op: -1, path: [] }],
        outSchema: T,
        detail: { kind: "leaf" },
      },
    ];
    const rog: Rog = {
      argumentSchema: T,
      resultSchema: T,
      result: { kind: "opOut", op: 0, path: [] },
      ops,
    };
    const add: LeafImpl = (input) => {
      const { a, b } = input as { a: number; b: number };
      return a + b;
    };
    const { result } = evalRog(rog, {
      argument: { a: 3, b: 4 },
      leafImpls: new Map([[0, add]]),
    });
    expect(result).toBe(7); // NOT NaN
  });

  it("zero-input leaf is called with undefined (not an empty array)", () => {
    const rog: Rog = {
      argumentSchema: T,
      resultSchema: T,
      result: { kind: "opOut", op: 0, path: [] },
      ops: [{
        id: 0,
        kind: "leaf",
        inputs: [],
        outSchema: T,
        detail: { kind: "leaf" },
      }],
    };
    const probe: LeafImpl = (input) => input === undefined ? "undef" : "other";
    const { result } = evalRog(rog, {
      argument: {},
      leafImpls: new Map([[0, probe]]),
    });
    expect(result).toBe("undef");
  });

  it("access navigates a nested path", () => {
    const rog: Rog = {
      argumentSchema: T,
      resultSchema: T,
      result: { kind: "opOut", op: 0, path: [] },
      ops: [{
        id: 0,
        kind: "access",
        inputs: [{ kind: "argument", path: ["user"] }],
        outSchema: T,
        detail: { kind: "access", path: ["name"] },
      }],
    };
    const { result } = evalRog(rog, {
      argument: { user: { name: "ada" } },
      leafImpls: new Map(),
    });
    expect(result).toBe("ada");
  });

  it("ifElse / when / unless select the right branch by predicate", () => {
    const mk = (op: "ifElse" | "when" | "unless"): Rog => ({
      argumentSchema: T,
      resultSchema: T,
      result: { kind: "opOut", op: 0, path: [] },
      ops: [{
        id: 0,
        kind: "control",
        inputs: [],
        outSchema: T,
        detail: {
          kind: "control",
          op,
          pred: { kind: "argument", path: ["show"] },
          branches: [{ kind: "const", value: "yes" }, {
            kind: "const",
            value: "no",
          }],
        },
      }],
    });
    const run = (rog: Rog, show: boolean) =>
      evalRog(rog, { argument: { show }, leafImpls: new Map() }).result;

    // Real builtin semantics (built-in.ts), with branches=[then="yes",
    // else="no"] and pred=`show`:
    //   ifElse(cond, then, else) = cond ? then : else
    //   when(cond, value=then)   = cond ? then : cond  (ELSE returns the COND)
    //   unless(cond, fallback=else) = cond ? cond : else  (THEN returns the COND)
    // The previous expectations encoded the WRONG semantics (off-branch =>
    // undefined), which silently mis-evaluated when/unless vs legacy.
    expect(run(mk("ifElse"), true)).toBe("yes");
    expect(run(mk("ifElse"), false)).toBe("no");
    expect(run(mk("when"), true)).toBe("yes");
    expect(run(mk("when"), false)).toBe(false); // ELSE returns the condition
    expect(run(mk("unless"), true)).toBe(true); // THEN returns the condition
    expect(run(mk("unless"), false)).toBe("no"); // ELSE = elseRef ("no")
  });

  it("resolves `internal` refs via internalToOp wiring", () => {
    const rog: Rog = {
      argumentSchema: T,
      resultSchema: T,
      result: { kind: "internal", name: "doubled", path: [] },
      ops: [{
        id: 5,
        kind: "leaf",
        inputs: [{ kind: "argument", path: ["x"] }],
        outSchema: T,
        detail: { kind: "leaf" },
      }],
    };
    const { result } = evalRog(rog, {
      argument: { x: 21 },
      leafImpls: new Map([[5, (n) => (n as number) * 2]]),
      internalToOp: new Map([["doubled", 5]]),
    });
    expect(result).toBe(42);
  });

  it("topoOrder puts dependencies before dependents regardless of declared order", () => {
    // op1 depends on op0, but declared op1 first.
    const ops: Op[] = [
      {
        id: 1,
        kind: "leaf",
        inputs: [{ kind: "opOut", op: 0, path: [] }],
        outSchema: T,
        detail: { kind: "leaf" },
      },
      {
        id: 0,
        kind: "leaf",
        inputs: [{ kind: "argument", path: ["x"] }],
        outSchema: T,
        detail: { kind: "leaf" },
      },
    ];
    const ordered = topoOrder(ops).map((o) => o.id);
    expect(ordered.indexOf(0)).toBeLessThan(ordered.indexOf(1));

    const rog: Rog = {
      argumentSchema: T,
      resultSchema: T,
      result: { kind: "opOut", op: 1, path: [] },
      ops,
    };
    const { result } = evalRog(rog, {
      argument: { x: 10 },
      leafImpls: new Map<number, LeafImpl>([
        [0, (n) => (n as number) + 1],
        [1, (n) => (n as number) * 10],
      ]),
    });
    expect(result).toBe(110); // (10+1)*10
  });

  it("collection / pattern / effect throw NotInterpretedHere (the W1 boundary)", () => {
    const rog: Rog = {
      argumentSchema: T,
      resultSchema: T,
      result: { kind: "opOut", op: 0, path: [] },
      ops: [{
        id: 0,
        kind: "collection",
        inputs: [],
        outSchema: T,
        detail: {
          kind: "collection",
          op: "map",
          elementRog: { identity: "x", symbol: "y" },
          listInput: { kind: "argument", path: ["xs"] },
        },
      }],
    };
    expect(() => evalRog(rog, { argument: { xs: [] }, leafImpls: new Map() }))
      .toThrow(NotInterpretedHere);
  });
});
