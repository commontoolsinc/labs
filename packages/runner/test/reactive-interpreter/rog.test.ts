import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  constructRefs,
  EXPR_BIN_OPS,
  EXPR_UN_OPS,
  inputsOf,
  isExprOp,
  isWellFormedCall,
  type Op,
  type ValueRef,
  writesOf,
} from "../../src/reactive-interpreter/rog.ts";

const arg = (...path: string[]): ValueRef => ({ kind: "argument", path });
const out = (op: number, ...path: string[]): ValueRef => ({
  kind: "opOut",
  op,
  path,
});
const konst = (value: unknown): ValueRef => ({ kind: "const", value });

const baseOp = (over: Partial<Op> & { detail: Op["detail"] }): Op => ({
  id: 0,
  kind: over.detail.kind === "call" ? "call" : over.detail.kind,
  inputs: [],
  outSchema: {},
  ...over,
});

describe("rog structural helpers", () => {
  it("inputsOf surfaces flat inputs plus detail refs per kind", () => {
    const leaf = baseOp({ detail: { kind: "leaf" }, inputs: [arg("a")] });
    assertEquals(inputsOf(leaf), [arg("a")]);

    const coll = baseOp({
      detail: { kind: "collection", op: "map", listInput: arg("items") },
    });
    assertEquals(inputsOf(coll), [arg("items")]);

    const pat = baseOp({
      detail: { kind: "pattern", argument: out(3) },
    });
    assertEquals(inputsOf(pat), [out(3)]);

    const ctrlBoth = baseOp({
      detail: {
        kind: "control",
        op: "ifElse",
        pred: arg("p"),
        then: out(1),
        else: out(2),
      },
    });
    assertEquals(inputsOf(ctrlBoth), [arg("p"), out(1), out(2)]);
  });

  it("inputsOf does NOT duplicate the pred for else:'pred' controls", () => {
    const whenOp = baseOp({
      detail: {
        kind: "control",
        op: "when",
        pred: arg("cond"),
        then: out(1),
        else: "pred",
      },
    });
    assertEquals(inputsOf(whenOp), [arg("cond"), out(1)]);
  });

  it("inputsOf mirrors interpolate/expr/call refs via flat inputs", () => {
    const interp = baseOp({
      detail: {
        kind: "interpolate",
        strings: ["Hello ", "!"],
        values: [arg("name")],
      },
      inputs: [arg("name")],
    });
    assertEquals(inputsOf(interp), [arg("name")]);

    const call = baseOp({
      detail: { kind: "call", builtin: "string.slice", args: [out(1)] },
      inputs: [out(1), konst(2)],
    });
    assertEquals(inputsOf(call), [out(1), konst(2)]);
  });

  it("writesOf exposes effect write-back targets and nothing else", () => {
    const handler = baseOp({
      detail: {
        kind: "effect",
        sink: "handler",
        streamLink: "onClick",
        writeTargets: [{ kind: "internal", cell: 0, path: [] }],
      },
      inputs: [arg("state")],
    });
    assertEquals(writesOf(handler), [{ kind: "internal", cell: 0, path: [] }]);
    // Write targets must NOT leak into the read view (false deps / hidden F4).
    assertEquals(inputsOf(handler), [arg("state")]);

    const leaf = baseOp({ detail: { kind: "leaf" }, inputs: [arg("a")] });
    assertEquals(writesOf(leaf), []);
  });

  it("constructRefs walks both template shapes", () => {
    assertEquals(
      constructRefs({ shape: "object", fields: { a: arg("x"), b: out(1) } }),
      [arg("x"), out(1)],
    );
    assertEquals(constructRefs({ shape: "array", items: [konst(1)] }), [
      konst(1),
    ]);
  });

  it("isWellFormedCall requires exactly one callee form", () => {
    assertEquals(isWellFormedCall({ kind: "call", callee: 0, args: [] }), true);
    assertEquals(
      isWellFormedCall({ kind: "call", builtin: "string.slice", args: [] }),
      true,
    );
    assertEquals(isWellFormedCall({ kind: "call", args: [] }), false);
    assertEquals(
      isWellFormedCall({
        kind: "call",
        callee: 0,
        builtin: "string.slice",
        args: [],
      }),
      false,
    );
  });

  it("expr allow-list is closed and typeof is excluded", () => {
    assertEquals(EXPR_BIN_OPS.size, 20);
    assertEquals(EXPR_UN_OPS.size, 4);
    assertEquals(isExprOp("+"), true);
    assertEquals(isExprOp("u!"), true);
    assertEquals(isExprOp("typeof"), false);
    assertEquals(isExprOp("&&"), false); // logical stays control
    assertEquals(isExprOp("?:"), false);
  });
});
