/**
 * Coverage-focused UNIT tests for interpret.ts — the pure ROG v2 evaluator.
 *
 * These drive the EXPORTED pure functions directly with hand-crafted Rog /
 * EvalContext objects (no Runtime harness needed): applyExprOp over every
 * operator, navigate over object/undefined paths, topoOrder incl. cycles and
 * internal-ref producer ordering, and evalRog over every op kind, the error
 * isolation / probe / seed / override / cell-view overlay paths, the
 * NotInterpretedHere fail-closed cases, and the scope flow-tracking branches.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { CellScope } from "../../src/builder/types.ts";
import {
  applyExprOp,
  type EvalContext,
  evalRog,
  navigate,
  NotInterpretedHere,
  topoOrder,
} from "../../src/reactive-interpreter/interpret.ts";
import type {
  ExprOp,
  InternalDecl,
  Op,
  OpId,
  Rog,
  ValueRef,
} from "../../src/reactive-interpreter/rog.ts";

// --- tiny Rog builders -----------------------------------------------------

const anySchema = true as unknown as Rog["argumentSchema"];

function rog(partial: Partial<Rog> & { result: ValueRef; ops: Op[] }): Rog {
  return {
    v: 2,
    argumentSchema: anySchema,
    resultSchema: anySchema,
    internals: [],
    ...partial,
  };
}

function baseCtx(partial: Partial<EvalContext> = {}): EvalContext {
  return {
    argument: undefined,
    leafImpls: new Map(),
    ...partial,
  };
}

const arg = (...path: string[]): ValueRef => ({ kind: "argument", path });
const opOut = (op: OpId, ...path: string[]): ValueRef => ({
  kind: "opOut",
  op,
  path,
});
const konst = (value: unknown): ValueRef => ({ kind: "const", value });

// =========================================================================
// applyExprOp — every operator (lines 153-208)
// =========================================================================
describe("applyExprOp — every operator arm", () => {
  const cases: Array<[ExprOp, unknown[], unknown]> = [
    ["+", [3, 4], 7],
    ["+", ["a", "b"], "ab"],
    ["-", [10, 4], 6],
    ["*", [3, 4], 12],
    ["/", [12, 4], 3],
    ["%", [10, 3], 1],
    ["**", [2, 5], 32],
    ["&", [6, 3], 2],
    ["|", [4, 1], 5],
    ["^", [5, 1], 4],
    ["<<", [1, 4], 16],
    [">>", [-8, 1], -4],
    [">>>", [-1, 28], 15],
    ["<", [1, 2], true],
    [">", [1, 2], false],
    ["<=", [2, 2], true],
    [">=", [1, 2], false],
    ["==", [1, "1"], true],
    ["===", [1, "1"], false],
    ["!=", [1, "1"], false],
    ["!==", [1, "1"], true],
    ["u-", [5], -5],
    ["u+", ["3"], 3],
    ["u~", [0], -1],
    ["u!", [0], true],
  ];

  for (const [op, operands, expected] of cases) {
    it(`${op}(${operands.join(",")}) === ${String(expected)}`, () => {
      assertEquals(applyExprOp(op, operands), expected);
    });
  }
});

// =========================================================================
// navigate (lines 138-144)
// =========================================================================
describe("navigate", () => {
  it("descends nested object keys", () => {
    assertEquals(navigate({ a: { b: { c: 42 } } }, ["a", "b", "c"]), 42);
  });
  it("empty path returns the value itself", () => {
    const v = { a: 1 };
    assertEquals(navigate(v, []), v);
  });
  it("short-circuits to undefined on a null/undefined mid-path", () => {
    assertEquals(navigate({ a: null }, ["a", "b"]), undefined);
    assertEquals(navigate({ a: undefined }, ["a", "b"]), undefined);
    assertEquals(navigate(undefined, ["a"]), undefined);
  });
});

// =========================================================================
// topoOrder (lines 225-273) — including cycles + internal-ref ordering
// =========================================================================
describe("topoOrder", () => {
  it("orders a consumer after its producer (opOut dep)", () => {
    const producer: Op = {
      id: 1,
      kind: "expr",
      inputs: [konst(2), konst(3)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [konst(2), konst(3)] },
    };
    const consumer: Op = {
      id: 2,
      kind: "expr",
      inputs: [opOut(1), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [opOut(1), konst(1)] },
    };
    // Feed in reverse dependency order; topo must reorder producer first.
    const ordered = topoOrder([consumer, producer], []);
    assertEquals(ordered.map((o) => o.id), [1, 2]);
  });

  it("orders through an internal-ref producer (internals table)", () => {
    // internal cell 0 is produced by op 5; op 6 reads it.
    const internals: InternalDecl[] = [{ partialCause: "x", producedBy: 5 }];
    const producer: Op = {
      id: 5,
      kind: "expr",
      inputs: [konst(1), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [konst(1), konst(1)] },
    };
    const internalRef: ValueRef = { kind: "internal", cell: 0, path: [] };
    const consumer: Op = {
      id: 6,
      kind: "expr",
      inputs: [internalRef, konst(0)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [internalRef, konst(0)] },
    };
    const ordered = topoOrder([consumer, producer], internals);
    assertEquals(ordered.map((o) => o.id), [5, 6]);
  });

  it("cycle guard: mutual refs fall back to declared order without hanging", () => {
    const a: Op = {
      id: 1,
      kind: "construct",
      inputs: [opOut(2)],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: { shape: "object", fields: { x: opOut(2) } },
      },
    };
    const b: Op = {
      id: 2,
      kind: "construct",
      inputs: [opOut(1)],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: { shape: "array", items: [opOut(1)] },
      },
    };
    const ordered = topoOrder([a, b], []);
    // Both survive; no infinite loop (the on-stack guard breaks the cycle).
    assertEquals(new Set(ordered.map((o) => o.id)), new Set([1, 2]));
    assertEquals(ordered.length, 2);
  });

  it("walks collection/pattern/control deps for ordering", () => {
    const list: Op = {
      id: 1,
      kind: "construct",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: { shape: "array", items: [konst(1)] },
      },
    };
    const paramsProducer: Op = {
      id: 2,
      kind: "expr",
      inputs: [konst(1), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [konst(1), konst(1)] },
    };
    const coll: Op = {
      id: 3,
      kind: "collection",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "collection",
        op: "map",
        listInput: opOut(1),
        params: opOut(2),
      },
    };
    const predProducer: Op = {
      id: 4,
      kind: "expr",
      inputs: [konst(1), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "<", inputs: [konst(1), konst(1)] },
    };
    const ctrl: Op = {
      id: 5,
      kind: "control",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "control",
        op: "ifElse",
        pred: opOut(4),
        then: konst("t"),
        else: "pred",
      },
    };
    const ordered = topoOrder(
      [coll, ctrl, list, paramsProducer, predProducer],
      [],
    );
    const pos = (id: OpId) => ordered.findIndex((o) => o.id === id);
    assert(pos(1) < pos(3), "list producer before collection");
    assert(pos(2) < pos(3), "params producer before collection");
    assert(pos(4) < pos(5), "pred producer before control");
  });
});

// =========================================================================
// evalRog — expr / interpolate / access / construct / control
// =========================================================================
describe("evalRog — native op kinds", () => {
  it("expr op resolves operands and applies the operator", () => {
    const op: Op = {
      id: 1,
      kind: "expr",
      inputs: [arg("a"), arg("b")],
      outSchema: anySchema,
      detail: { kind: "expr", op: "*", inputs: [arg("a"), arg("b")] },
    };
    const { result, opValues, errors } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({ argument: { a: 6, b: 7 } }),
    );
    assertEquals(result, 42);
    assertEquals(opValues.get(1), 42);
    assertEquals(errors.length, 0);
  });

  it("interpolate concatenates strings with resolved values", () => {
    const op: Op = {
      id: 1,
      kind: "interpolate",
      inputs: [arg("name")],
      outSchema: anySchema,
      detail: {
        kind: "interpolate",
        strings: ["Hi ", "!"],
        values: [arg("name")],
      },
    };
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({ argument: { name: "Ada" } }),
    );
    assertEquals(result, "Hi Ada!");
    // Undefined coerces to "undefined" (no run-gate).
    const { result: r2 } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({ argument: {} }),
    );
    assertEquals(r2, "Hi undefined!");
  });

  it("access navigates into a resolved input", () => {
    const op: Op = {
      id: 1,
      kind: "access",
      inputs: [arg("obj")],
      outSchema: anySchema,
      detail: { kind: "access", path: ["deep", "val"] },
    };
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({ argument: { obj: { deep: { val: 99 } } } }),
    );
    assertEquals(result, 99);
  });

  it("construct assembles object and array templates", () => {
    const objOp: Op = {
      id: 1,
      kind: "construct",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: { shape: "object", fields: { a: arg("x"), b: konst(2) } },
      },
    };
    const arrOp: Op = {
      id: 2,
      kind: "construct",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: { shape: "array", items: [konst("p"), arg("x")] },
      },
    };
    const resultOp: Op = {
      id: 3,
      kind: "construct",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: { shape: "object", fields: { o: opOut(1), a: opOut(2) } },
      },
    };
    const { result } = evalRog(
      rog({ ops: [objOp, arrOp, resultOp], result: opOut(3) }),
      baseCtx({ argument: { x: 1 } }),
    );
    assertEquals(result, { o: { a: 1, b: 2 }, a: ["p", 1] });
  });

  it("control ifElse/when/unless with the normalized pred convention", () => {
    const mk = (
      id: OpId,
      op: "ifElse" | "when" | "unless",
      then: ValueRef | "pred",
      els: ValueRef | "pred",
    ): Op => ({
      id,
      kind: "control",
      inputs: [],
      outSchema: anySchema,
      detail: { kind: "control", op, pred: arg("flag"), then, else: els },
    });
    const ifElseOp = mk(1, "ifElse", konst("A"), konst("B"));
    const whenOp = mk(2, "when", konst("V"), "pred");
    const unlessOp = mk(3, "unless", "pred", konst("F"));
    const resultOp: Op = {
      id: 4,
      kind: "construct",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: {
          shape: "object",
          fields: { i: opOut(1), w: opOut(2), u: opOut(3) },
        },
      },
    };
    const build = () =>
      rog({ ops: [ifElseOp, whenOp, unlessOp, resultOp], result: opOut(4) });

    assertEquals(
      evalRog(build(), baseCtx({ argument: { flag: true } })).result,
      {
        i: "A",
        w: "V",
        u: true,
      },
    );
    // Falsy-but-defined: when returns the CONDITION VALUE (0).
    assertEquals(evalRog(build(), baseCtx({ argument: { flag: 0 } })).result, {
      i: "B",
      w: 0,
      u: "F",
    });
  });

  it("control unwraps a live cell handle for the predicate (unwrapCellForValue)", () => {
    const handle = { __isHandle: true, value: false };
    const ctrl: Op = {
      id: 1,
      kind: "control",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "control",
        op: "ifElse",
        pred: arg("cond"),
        then: konst("T"),
        else: konst("E"),
      },
    };
    const { result } = evalRog(
      rog({ ops: [ctrl], result: opOut(1) }),
      baseCtx({
        argument: { cond: handle },
        unwrapCellForValue: (v) =>
          (v as { __isHandle?: boolean })?.__isHandle
            ? (v as { value: unknown }).value
            : v,
      }),
    );
    // Handle is always truthy; unwrap sees false → else branch.
    assertEquals(result, "E");
  });
});

// =========================================================================
// evalRog — leaf paths (impl, override, no-input, run-gate, cell-view)
// =========================================================================
describe("evalRog — leaf paths", () => {
  const leafOp = (id: OpId, inputs: ValueRef[], ungated?: true): Op => ({
    id,
    kind: "leaf",
    inputs,
    outSchema: anySchema,
    detail: ungated ? { kind: "leaf", ungated } : { kind: "leaf" },
  });

  it("invokes the leaf impl with the resolved single input", () => {
    const op = leafOp(1, [arg("v")]);
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { v: 10 },
        leafImpls: new Map([[1, (x) => (x as number) + 1]]),
      }),
    );
    assertEquals(result, 11);
  });

  it("no-input leaf is called with undefined (constant producer)", () => {
    const op = leafOp(1, []);
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({ leafImpls: new Map([[1, () => "constant"]]) }),
    );
    assertEquals(result, "constant");
  });

  it("undefined-argument run-gate: undefined input skips the body", () => {
    let ran = false;
    const op = leafOp(1, [arg("missing")]);
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: {},
        leafImpls: new Map([[1, () => {
          ran = true;
          return "ran";
        }]]),
      }),
    );
    assertEquals(result, undefined);
    assertEquals(ran, false);
  });

  it("ungated leaf runs even with undefined input", () => {
    const op = leafOp(1, [arg("missing")], true);
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: {},
        leafImpls: new Map([[1, (x) => `saw:${String(x)}`]]),
      }),
    );
    assertEquals(result, "saw:undefined");
  });

  it("leafInputOverrides bypasses ref-resolution", () => {
    const op = leafOp(1, [arg("v")]);
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { v: "ignored" },
        leafImpls: new Map([[1, (x) => x]]),
        leafInputOverrides: new Map([[1, "override"]]),
      }),
    );
    assertEquals(result, "override");
  });

  it("inputCellViews wraps named object fields via wrapReadOnlyValue", () => {
    const op = leafOp(1, [arg("obj")]);
    const seen: Record<string, unknown> = {};
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { obj: { wrapped: 5, plain: 6 } },
        leafImpls: new Map([[1, (x) => {
          Object.assign(seen, x as Record<string, unknown>);
          return x;
        }]]),
        inputCellViews: new Map([[1, new Set(["wrapped"])]]),
        wrapReadOnlyValue: (v) => ({ ro: v }),
      }),
    );
    assertEquals((result as Record<string, unknown>).wrapped, { ro: 5 });
    assertEquals((result as Record<string, unknown>).plain, 6);
  });

  it("probe mode never invokes a leaf body", () => {
    let ran = false;
    const op = leafOp(1, [arg("v")]);
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { v: 1 },
        leafImpls: new Map([[1, () => {
          ran = true;
          return 2;
        }]]),
        probe: true,
      }),
    );
    assertEquals(ran, false);
    assertEquals(result, undefined);
  });

  it("missing leaf impl throws NotInterpretedHere (fail-closed)", () => {
    const op = leafOp(1, [arg("v")]);
    assertThrows(
      () =>
        evalRog(
          rog({ ops: [op], result: opOut(1) }),
          baseCtx({ argument: { v: 1 } }),
        ),
      NotInterpretedHere,
    );
  });
});

// =========================================================================
// evalRog — per-op error isolation
// =========================================================================
describe("evalRog — error isolation", () => {
  it("throwing leaf isolates to undefined; siblings survive; error surfaced", () => {
    const poison: Op = {
      id: 1,
      kind: "leaf",
      inputs: [arg("n")],
      outSchema: anySchema,
      detail: { kind: "leaf" },
    };
    const safe: Op = {
      id: 2,
      kind: "expr",
      inputs: [arg("n"), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [arg("n"), konst(1)] },
    };
    const resultOp: Op = {
      id: 3,
      kind: "construct",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: { shape: "object", fields: { p: opOut(1), s: opOut(2) } },
      },
    };
    const { result, errors, opValues } = evalRog(
      rog({ ops: [poison, safe, resultOp], result: opOut(3) }),
      baseCtx({
        argument: { n: 5 },
        leafImpls: new Map([[1, () => {
          throw new Error("boom");
        }]]),
      }),
    );
    assertEquals(result, { p: undefined, s: 6 });
    assertEquals(opValues.get(1), undefined);
    assertEquals(errors.length, 1);
    assertEquals(errors[0].opId, 1);
    assert(errors[0].error instanceof Error);
  });
});

// =========================================================================
// evalRog — ValueRef resolution: internal / external / seed
// =========================================================================
describe("evalRog — ref resolution & seeds", () => {
  it("resolves an internal ref through its op producer", () => {
    const internals: InternalDecl[] = [{ partialCause: "c", producedBy: 1 }];
    const producer: Op = {
      id: 1,
      kind: "expr",
      inputs: [konst(20), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [konst(20), konst(1)] },
    };
    const internalRef: ValueRef = { kind: "internal", cell: 0, path: [] };
    const consumer: Op = {
      id: 2,
      kind: "expr",
      inputs: [internalRef, konst(0)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [internalRef, konst(0)] },
    };
    const { result } = evalRog(
      rog({ ops: [producer, consumer], internals, result: opOut(2) }),
      baseCtx(),
    );
    assertEquals(result, 21);
  });

  it("resolves an internal ref from seedByInternal when no producer wrote it", () => {
    const internals: InternalDecl[] = [{ partialCause: "state" }];
    const ref: ValueRef = { kind: "internal", cell: 0, path: ["k"] };
    const op: Op = {
      id: 1,
      kind: "access",
      inputs: [ref],
      outSchema: anySchema,
      detail: { kind: "access", path: [] },
    };
    const { result } = evalRog(
      rog({ ops: [op], internals, result: opOut(1) }),
      baseCtx({ seedByInternal: new Map([[0, { k: "seeded" }]]) }),
    );
    assertEquals(result, "seeded");
  });

  it("unresolvable internal ref (no producer, no seed) resolves undefined", () => {
    const internals: InternalDecl[] = [{ partialCause: "state" }];
    const ref: ValueRef = { kind: "internal", cell: 0, path: [] };
    const op: Op = {
      id: 1,
      kind: "access",
      inputs: [ref],
      outSchema: anySchema,
      detail: { kind: "access", path: [] },
    };
    const { result } = evalRog(
      rog({ ops: [op], internals, result: opOut(1) }),
      baseCtx(),
    );
    assertEquals(result, undefined);
  });

  it("resolves an external ref from seedByExternal", () => {
    const ref: ValueRef = { kind: "external", cell: 0, path: ["field"] };
    const op: Op = {
      id: 1,
      kind: "access",
      inputs: [ref],
      outSchema: anySchema,
      detail: { kind: "access", path: [] },
    };
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({ seedByExternal: new Map([[0, { field: "ext" }]]) }),
    );
    assertEquals(result, "ext");
  });

  it("seed pre-populates op values consumed by later ops", () => {
    const op: Op = {
      id: 2,
      kind: "expr",
      inputs: [opOut(1), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [opOut(1), konst(1)] },
    };
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(2) }),
      baseCtx({ seed: new Map([[1, 100]]) }),
    );
    assertEquals(result, 101);
  });

  it("result self-reference throws NotInterpretedHere", () => {
    const resultRef: ValueRef = { kind: "result", path: [] };
    assertThrows(
      () => evalRog(rog({ ops: [], result: resultRef }), baseCtx()),
      NotInterpretedHere,
    );
  });
});

// =========================================================================
// evalRog — collection ops (map / filter / flatMap)
// =========================================================================
describe("evalRog — collections", () => {
  // Element BuiltRog: identity-ish rog that returns an expr over `element`.
  function elementBuilt(
    elemRog: Rog,
    leafImpls: Map<OpId, (i: unknown) => unknown> = new Map(),
  ) {
    return {
      rog: elemRog,
      leafImpls,
      children: new Map(),
      leafArgSchemas: new Map(),
      collectionElements: new Map(),
    } as never;
  }

  const usage = {
    usesElement: true,
    usesIndex: false,
    usesArray: false,
    usesParams: false,
  };

  function collOp(id: OpId, op: "map" | "filter" | "flatMap"): Op {
    return {
      id,
      kind: "collection",
      inputs: [],
      outSchema: anySchema,
      detail: { kind: "collection", op, listInput: arg("list") },
    };
  }

  it("map applies the element rog to each item", () => {
    // element rog: element * 2
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "expr",
        inputs: [arg("element"), konst(2)],
        outSchema: anySchema,
        detail: {
          kind: "expr",
          op: "*",
          inputs: [arg("element"), konst(2)],
        },
      }],
      result: opOut(10),
    });
    const op = collOp(1, "map");
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: [1, 2, 3] },
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog) as never,
          usage,
        }]]),
      }),
    );
    assertEquals(result, [2, 4, 6]);
  });

  it("filter preserves holes (skips them) and keeps truthy items", () => {
    const sparse: number[] = [];
    sparse[0] = 1;
    sparse[2] = 5; // index 1 is a hole
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "expr",
        inputs: [arg("element"), konst(2)],
        outSchema: anySchema,
        detail: { kind: "expr", op: ">", inputs: [arg("element"), konst(2)] },
      }],
      result: opOut(10),
    });
    const op = collOp(1, "filter");
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: sparse },
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog) as never,
          usage,
        }]]),
      }),
    );
    assertEquals(result, [5]); // hole contributes nothing, 1 filtered out
  });

  it("flatMap skips holes in the source array", () => {
    const sparse: number[] = [];
    sparse[0] = 1;
    sparse[2] = 2; // index 1 is a hole
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "expr",
        inputs: [arg("element"), konst(10)],
        outSchema: anySchema,
        detail: { kind: "expr", op: "*", inputs: [arg("element"), konst(10)] },
      }],
      result: opOut(10),
    });
    const op = collOp(1, "flatMap");
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: sparse },
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog) as never,
          usage,
        }]]),
      }),
    );
    assertEquals(result, [10, 20]); // hole skipped, scalars pushed
  });

  it("filter keeps items whose element rog is truthy", () => {
    // element rog: element > 2
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "expr",
        inputs: [arg("element"), konst(2)],
        outSchema: anySchema,
        detail: {
          kind: "expr",
          op: ">",
          inputs: [arg("element"), konst(2)],
        },
      }],
      result: opOut(10),
    });
    const op = collOp(1, "filter");
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: [1, 2, 3, 4] },
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog) as never,
          usage,
        }]]),
      }),
    );
    assertEquals(result, [3, 4]);
  });

  it("flatMap concatenates array element results and pushes non-array results", () => {
    // element rog via a leaf: even → [e, e]; odd → e (defined non-array)
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "leaf",
        inputs: [arg("element")],
        outSchema: anySchema,
        detail: { kind: "leaf" },
      }],
      result: opOut(10),
    });
    const elemImpls = new Map<OpId, (i: unknown) => unknown>([
      [10, (x) => {
        const n = x as number;
        return n % 2 === 0 ? [n, n] : n;
      }],
    ]);
    const op = collOp(1, "flatMap");
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: [1, 2, 3] },
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog, elemImpls) as never,
          usage,
        }]]),
      }),
    );
    // 1 → 1 (push), 2 → [2,2] (concat), 3 → 3 (push)
    assertEquals(result, [1, 2, 2, 3]);
  });

  it("flatMap drops undefined element results", () => {
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "leaf",
        inputs: [arg("element")],
        outSchema: anySchema,
        detail: { kind: "leaf" },
      }],
      result: opOut(10),
    });
    const elemImpls = new Map<OpId, (i: unknown) => unknown>([
      [10, (x) => (x as number) > 1 ? x : undefined],
    ]);
    const op = collOp(1, "flatMap");
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: [1, 2, 3] },
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog, elemImpls) as never,
          usage,
        }]]),
      }),
    );
    assertEquals(result, [2, 3]);
  });

  it("undefined list yields [] (legacy container seed)", () => {
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "expr",
        inputs: [arg("element"), konst(1)],
        outSchema: anySchema,
        detail: { kind: "expr", op: "+", inputs: [arg("element"), konst(1)] },
      }],
      result: opOut(10),
    });
    const op = collOp(1, "map");
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: {},
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog) as never,
          usage,
        }]]),
      }),
    );
    assertEquals(result, []);
  });

  it("non-array list throws an ISOLATED error (op value undefined)", () => {
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "expr",
        inputs: [arg("element"), konst(1)],
        outSchema: anySchema,
        detail: { kind: "expr", op: "+", inputs: [arg("element"), konst(1)] },
      }],
      result: opOut(10),
    });
    const op = collOp(1, "map");
    const { result, errors, opValues } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: "not-an-array" },
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog) as never,
          usage,
        }]]),
      }),
    );
    // Error isolated, not thrown out of evalRog.
    assertEquals(result, undefined);
    assertEquals(opValues.get(1), undefined);
    assertEquals(errors.length, 1);
    assert(errors[0].error instanceof Error);
  });

  it("collection with no inline entry throws NotInterpretedHere (boundary)", () => {
    const op = collOp(1, "map");
    assertThrows(
      () =>
        evalRog(
          rog({ ops: [op], result: opOut(1) }),
          baseCtx({ argument: { list: [1] } }),
        ),
      NotInterpretedHere,
    );
  });

  it("collection map preserves sparse holes and surfaces element errors on the op channel", () => {
    // Sparse array: index 1 is a hole.
    const sparse: number[] = [];
    sparse[0] = 5;
    sparse[2] = 7;
    // element rog throws for value 7 (leaf), so an element error surfaces.
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "leaf",
        inputs: [arg("element")],
        outSchema: anySchema,
        detail: { kind: "leaf" },
      }],
      result: opOut(10),
    });
    const elemImpls = new Map<OpId, (i: unknown) => unknown>([
      [10, (x) => {
        if (x === 7) throw new Error("elem boom");
        return (x as number) * 10;
      }],
    ]);
    const op = collOp(1, "map");
    const { result, errors } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: sparse },
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog, elemImpls) as never,
          usage,
        }]]),
      }),
    );
    const out = result as unknown[];
    assertEquals(out[0], 50);
    assertEquals(1 in out, false); // hole preserved
    // index 2 threw inside the element rog → element result undefined, error surfaced
    assertEquals(out[2], undefined);
    assertEquals(errors.length, 1);
    assertEquals(errors[0].opId, 1);
  });

  it("collection probe mode returns undefined without evaluating elements", () => {
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "leaf",
        inputs: [arg("element")],
        outSchema: anySchema,
        detail: { kind: "leaf" },
      }],
      result: opOut(10),
    });
    let ran = false;
    const elemImpls = new Map<OpId, (i: unknown) => unknown>([
      [10, () => {
        ran = true;
        return 1;
      }],
    ]);
    const op = collOp(1, "map");
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: [1, 2] },
        probe: true,
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog, elemImpls) as never,
          usage,
        }]]),
      }),
    );
    assertEquals(result, undefined);
    assertEquals(ran, false);
  });

  it("collection passes index / array / params into the element argument", () => {
    // element rog: index + params (params is a number)
    const elemRog = rog({
      ops: [{
        id: 10,
        kind: "expr",
        inputs: [arg("index"), arg("params")],
        outSchema: anySchema,
        detail: {
          kind: "expr",
          op: "+",
          inputs: [arg("index"), arg("params")],
        },
      }],
      result: opOut(10),
    });
    const op: Op = {
      id: 1,
      kind: "collection",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "collection",
        op: "map",
        listInput: arg("list"),
        params: arg("p"),
      },
    };
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { list: ["a", "b", "c"], p: 100 },
        collections: new Map([[1, {
          elementBuilt: elementBuilt(elemRog) as never,
          usage: {
            usesElement: false,
            usesIndex: true,
            usesArray: true,
            usesParams: true,
          },
        }]]),
      }),
    );
    assertEquals(result, [100, 101, 102]);
  });
});

// =========================================================================
// evalRog — pattern (inlined child) + boundary fallbacks
// =========================================================================
describe("evalRog — pattern op", () => {
  function childBuilt(childRog: Rog, leafImpls = new Map()) {
    return {
      rog: childRog,
      leafImpls,
      children: new Map(),
      leafArgSchemas: new Map(),
      collectionElements: new Map(),
    } as never;
  }

  it("evaluates an inlined child pattern against the bound argument", () => {
    // Child reads its whole (scalar) argument and doubles it.
    const childRog = rog({
      ops: [{
        id: 10,
        kind: "expr",
        inputs: [arg(), konst(2)],
        outSchema: anySchema,
        detail: { kind: "expr", op: "*", inputs: [arg(), konst(2)] },
      }],
      result: opOut(10),
    });
    const op: Op = {
      id: 1,
      kind: "pattern",
      inputs: [],
      outSchema: anySchema,
      detail: { kind: "pattern", argument: { kind: "argument", path: ["y"] } },
    };
    const { result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { y: 21 },
        children: new Map([[1, childBuilt(childRog)]]),
      }),
    );
    assertEquals(result, 42);
  });

  it("pattern op with no child throws NotInterpretedHere (boundary)", () => {
    const op: Op = {
      id: 1,
      kind: "pattern",
      inputs: [],
      outSchema: anySchema,
      detail: { kind: "pattern", argument: arg("y") },
    };
    assertThrows(
      () =>
        evalRog(
          rog({ ops: [op], result: opOut(1) }),
          baseCtx({ argument: { y: 1 } }),
        ),
      NotInterpretedHere,
    );
  });

  it("pattern op with an INCOMPLETE child throws NotInterpretedHere", () => {
    const childRog = rog({ ops: [], result: konst(1) });
    childRog.incomplete = ["nope"];
    const op: Op = {
      id: 1,
      kind: "pattern",
      inputs: [],
      outSchema: anySchema,
      detail: { kind: "pattern", argument: arg("y") },
    };
    assertThrows(
      () =>
        evalRog(
          rog({ ops: [op], result: opOut(1) }),
          baseCtx({
            argument: { y: 1 },
            children: new Map([[1, childBuilt(childRog)]]),
          }),
        ),
      NotInterpretedHere,
    );
  });
});

// =========================================================================
// evalRog — call / effect boundary fallbacks
// =========================================================================
describe("evalRog — call / effect boundaries", () => {
  it("call op throws NotInterpretedHere", () => {
    const op: Op = {
      id: 1,
      kind: "call",
      inputs: [],
      outSchema: anySchema,
      detail: { kind: "call", builtin: "string.slice", args: [] },
    };
    assertThrows(
      () => evalRog(rog({ ops: [op], result: opOut(1) }), baseCtx()),
      NotInterpretedHere,
    );
  });

  it("effect op throws NotInterpretedHere", () => {
    const op: Op = {
      id: 1,
      kind: "effect",
      inputs: [],
      outSchema: anySchema,
      detail: { kind: "effect", sink: "render", writeTargets: [] },
    };
    assertThrows(
      () => evalRog(rog({ ops: [op], result: opOut(1) }), baseCtx()),
      NotInterpretedHere,
    );
  });
});

// =========================================================================
// evalRog — scope flow-tracking (ctx.scopes present)
// =========================================================================
describe("evalRog — scope flow-tracking", () => {
  it("derives per-op scope as the narrowest of consumed refs", () => {
    // op 1 reads argument (session-scoped); op 2 reads op1 (opOut) + a const.
    const op1: Op = {
      id: 1,
      kind: "expr",
      inputs: [arg("a"), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [arg("a"), konst(1)] },
    };
    const op2: Op = {
      id: 2,
      kind: "expr",
      inputs: [opOut(1), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [opOut(1), konst(1)] },
    };
    const { opScopes } = evalRog(
      rog({ ops: [op1, op2], result: opOut(2) }),
      baseCtx({
        argument: { a: 5 },
        scopes: { argument: "session" as CellScope },
      }),
    );
    // op1 consumed the session-scoped argument → session.
    assertEquals(opScopes.get(1), "session");
    // op2 consumed op1's output (session) + a const (space) → session.
    assertEquals(opScopes.get(2), "session");
  });

  it("space-only ops stay at space; byExternal/byInternal scopes fold in", () => {
    const extRef: ValueRef = { kind: "external", cell: 0, path: [] };
    const op1: Op = {
      id: 1,
      kind: "access",
      inputs: [extRef],
      outSchema: anySchema,
      detail: { kind: "access", path: [] },
    };
    const constOp: Op = {
      id: 2,
      kind: "expr",
      inputs: [konst(1), konst(2)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [konst(1), konst(2)] },
    };
    const { opScopes } = evalRog(
      rog({ ops: [op1, constOp], result: opOut(2) }),
      baseCtx({
        seedByExternal: new Map([[0, "x"]]),
        scopes: { byExternal: new Map([[0, "user" as CellScope]]) },
      }),
    );
    assertEquals(opScopes.get(1), "user"); // external is user-scoped
    assertEquals(opScopes.get(2), "space"); // consts only
  });

  it("leafInputOverrides op takes its scope from byLeafInput", () => {
    const op: Op = {
      id: 1,
      kind: "leaf",
      inputs: [arg("v")],
      outSchema: anySchema,
      detail: { kind: "leaf" },
    };
    const { opScopes, result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        argument: { v: "ignored" },
        leafImpls: new Map([[1, (x) => x]]),
        leafInputOverrides: new Map([[1, "ov"]]),
        scopes: { byLeafInput: new Map([[1, "user" as CellScope]]) },
      }),
    );
    assertEquals(result, "ov");
    assertEquals(opScopes.get(1), "user");
  });

  it("runScoped bracket observation widens the derived scope", () => {
    // A leaf whose derived scope is space, but runScoped observes 'session'
    // during the body — final scope is the narrower (session).
    const op: Op = {
      id: 1,
      kind: "leaf",
      inputs: [konst("c")],
      outSchema: anySchema,
      detail: { kind: "leaf", ungated: true },
    };
    const { opScopes } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({
        leafImpls: new Map([[1, (x) => x]]),
        scopes: {},
        runScoped: <T>(fn: () => T, onScope: (s: CellScope) => void): T => {
          const r = fn();
          onScope("session" as CellScope);
          return r;
        },
      }),
    );
    // const input → derived space, but observed session dominates.
    assertEquals(opScopes.get(1), "session");
  });

  it("folds scope through control/construct/collection/pattern detail refs", () => {
    // control op reads a session-scoped argument as its predicate.
    const ctrl: Op = {
      id: 1,
      kind: "control",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "control",
        op: "ifElse",
        pred: arg("flag"),
        then: konst("t"),
        else: konst("e"),
      },
    };
    // construct op reads the user-scoped argument field.
    const cons: Op = {
      id: 2,
      kind: "construct",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: { shape: "object", fields: { v: arg("u") } },
      },
    };
    // collection op over a session-scoped list (boundary via undefined list
    // avoids needing an element rog; scope folds from listInput regardless).
    const coll: Op = {
      id: 3,
      kind: "collection",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "collection",
        op: "map",
        listInput: arg("list"),
        params: arg("u"),
      },
    };
    // pattern op whose bound argument reads the session-scoped field.
    const pat: Op = {
      id: 4,
      kind: "pattern",
      inputs: [],
      outSchema: anySchema,
      detail: { kind: "pattern", argument: arg("list") },
    };
    const childRog = rog({ ops: [], result: konst("child") });
    const childBuilt = {
      rog: childRog,
      leafImpls: new Map(),
      children: new Map(),
      leafArgSchemas: new Map(),
      collectionElements: new Map(),
    } as never;
    // Two-field argument scoping: model `flag`/`list` as session by putting
    // argument at session (all argument reads then start at session).
    const { opScopes } = evalRog(
      rog({ ops: [ctrl, cons, coll, pat], result: opOut(2) }),
      baseCtx({
        argument: { flag: true, u: 1, list: [1] },
        children: new Map([[4, childBuilt]]),
        // Collection has an inline entry so it doesn't throw before scope-fold.
        collections: new Map([[3, {
          elementBuilt: {
            rog: rog({ ops: [], result: konst(0) }),
            leafImpls: new Map(),
            children: new Map(),
            leafArgSchemas: new Map(),
            collectionElements: new Map(),
          } as never,
          usage: {
            usesElement: false,
            usesIndex: false,
            usesArray: false,
            usesParams: false,
          },
        }]]),
        scopes: { argument: "session" as CellScope },
      }),
    );
    // Every op read the session-scoped argument through its detail refs.
    assertEquals(opScopes.get(1), "session"); // control pred
    assertEquals(opScopes.get(2), "session"); // construct field
    assertEquals(opScopes.get(3), "session"); // collection listInput/params
    assertEquals(opScopes.get(4), "session"); // pattern argument
  });

  it("internal-ref scope falls to byInternal when no producer is scoped", () => {
    // Internal cell 0 has NO producer op → its scope comes from byInternal.
    const internals: InternalDecl[] = [{ partialCause: "state" }];
    const ref: ValueRef = { kind: "internal", cell: 0, path: [] };
    const op: Op = {
      id: 1,
      kind: "access",
      inputs: [ref],
      outSchema: anySchema,
      detail: { kind: "access", path: [] },
    };
    const { opScopes, result } = evalRog(
      rog({ ops: [op], internals, result: opOut(1) }),
      baseCtx({
        seedByInternal: new Map([[0, "seeded"]]),
        scopes: { byInternal: new Map([[0, "user" as CellScope]]) },
      }),
    );
    assertEquals(result, "seeded");
    assertEquals(opScopes.get(1), "user");
  });

  it("result-ref folds to space in opScopeOf (input not resolved by evalOp)", () => {
    // A control op evaluates its pred/then/else, NOT op.inputs. We park a
    // `result` ref in op.inputs so evalOp never resolves it (no throw), but
    // opScopeOf DOES fold it — exercising the result-ref scope arm (→ space).
    const resultRef: ValueRef = { kind: "result", path: [] };
    const op: Op = {
      id: 1,
      kind: "control",
      inputs: [resultRef],
      outSchema: anySchema,
      detail: {
        kind: "control",
        op: "ifElse",
        pred: konst(true),
        then: konst("T"),
        else: konst("E"),
      },
    };
    const { opScopes, result } = evalRog(
      rog({ ops: [op], result: opOut(1) }),
      baseCtx({ scopes: { argument: "session" as CellScope } }),
    );
    assertEquals(result, "T"); // control evaluated normally
    assertEquals(opScopes.get(1), "space"); // result ref folds to space
  });

  it("const/result-ref scopes stay at space under scope-tracking", () => {
    // construct over an array template with only const items → space scope.
    const cons: Op = {
      id: 1,
      kind: "construct",
      inputs: [],
      outSchema: anySchema,
      detail: {
        kind: "construct",
        template: { shape: "array", items: [konst(1), konst(2)] },
      },
    };
    const { opScopes, result } = evalRog(
      rog({ ops: [cons], result: opOut(1) }),
      baseCtx({ scopes: { argument: "session" as CellScope } }),
    );
    assertEquals(result, [1, 2]);
    assertEquals(opScopes.get(1), "space");
  });

  it("internal-ref scope inherits from its producer op's scope", () => {
    const internals: InternalDecl[] = [{ partialCause: "c", producedBy: 1 }];
    const producer: Op = {
      id: 1,
      kind: "expr",
      inputs: [arg("a"), konst(1)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [arg("a"), konst(1)] },
    };
    const internalRef: ValueRef = { kind: "internal", cell: 0, path: [] };
    const consumer: Op = {
      id: 2,
      kind: "expr",
      inputs: [internalRef, konst(0)],
      outSchema: anySchema,
      detail: { kind: "expr", op: "+", inputs: [internalRef, konst(0)] },
    };
    const { opScopes } = evalRog(
      rog({ ops: [producer, consumer], internals, result: opOut(2) }),
      baseCtx({
        argument: { a: 1 },
        scopes: { argument: "user" as CellScope },
      }),
    );
    // producer consumed user-scoped argument → user; consumer reads internal
    // produced by op1 → inherits user.
    assertEquals(opScopes.get(1), "user");
    assertEquals(opScopes.get(2), "user");
  });
});
