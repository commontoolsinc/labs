/**
 * 08 expression-interpretation — OPERATOR `expr` op extraction + evaluation.
 *
 * The increment lowers a branded (`$builtin: "expr:<op>"`) arithmetic/comparison/
 * unary lift leaf to a native `expr` op the evaluator computes directly — the
 * opaque operator lift body is NEVER resolved/invoked under the flag. These unit
 * tests pin, at the extract + evalRog seam (no scheduler/runtime):
 *
 *   1. a branded binary/unary `exprLift` leaf extracts to an `expr` op (NOT a
 *      `leaf`), with the operator in `detail.op` and the operands positionally in
 *      `op.inputs` — and NO opaque leaf / input-construct synthesized.
 *   2. `evalRog` reproduces EXACT JS operator semantics (coercion, NaN, relational,
 *      bitwise, unary, falsy-but-defined operands) byte-for-byte vs the raw JS.
 *   3. fail-closed: an UNBRANDED operator lift, an unknown-op brand, and a wrong-
 *      arity brand all stay `leaf` (never an `expr` op) — the allow-list gate.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { createMeasureEnv } from "../support/interpreter-measure.ts";
import { extractRog } from "../../src/reactive-interpreter/extract.ts";
import { evalRog } from "../../src/reactive-interpreter/interpret.ts";
import type { ExprOp, Op, Rog } from "../../src/reactive-interpreter/rog.ts";
import type { JSONSchema } from "../../src/builder/types.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-expr-interp");
const num = { type: "number" } as const satisfies JSONSchema;
const bool = { type: "boolean" } as const satisfies JSONSchema;

/** A pattern whose result binds `out` to a single branded BINARY `expr` op over
 * two argument fields `a` and `b`. Mirrors what the transformer emits for
 * `a <op> b` (positional `[a, b]` operands + `([a,b]) => a <op> b` body). */
// deno-lint-ignore no-explicit-any
function buildBinaryExprPattern(cf: any, op: ExprOp, resultSchema: JSONSchema) {
  // The runnable arrow body (legacy parity): destructure the positional operand
  // array and apply the operator. We build it dynamically per op via Function so
  // the body matches the operator under test exactly (the transformer would emit
  // the literal operator inline).
  const body = makeBinaryBody(op);
  return cf.pattern(
    ({ a, b }: { a: number; b: number }) => ({
      out: cf.exprLift(`expr:${op}`, body)([a, b]),
    }),
    {
      type: "object",
      properties: { a: num, b: num },
      required: ["a", "b"],
    },
    { type: "object", properties: { out: resultSchema } },
  );
}

/** A pattern whose result binds `out` to a single branded UNARY `expr` op over
 * the argument field `a`. */
// deno-lint-ignore no-explicit-any
function buildUnaryExprPattern(cf: any, op: ExprOp, resultSchema: JSONSchema) {
  const body = makeUnaryBody(op);
  return cf.pattern(
    ({ a }: { a: number }) => ({
      out: cf.exprLift(`expr:${op}`, body)([a]),
    }),
    { type: "object", properties: { a: num }, required: ["a"] },
    { type: "object", properties: { out: resultSchema } },
  );
}

// Build the positional-array lift bodies matching each operator. Using a real
// closure (not Function()) keeps it SES-safe and provenance-stamped.
const BINARY_BODIES: Record<string, (i: [unknown, unknown]) => unknown> = {
  "+": ([a, b]) => (a as number) + (b as number),
  "-": ([a, b]) => (a as number) - (b as number),
  "*": ([a, b]) => (a as number) * (b as number),
  "/": ([a, b]) => (a as number) / (b as number),
  "%": ([a, b]) => (a as number) % (b as number),
  "**": ([a, b]) => (a as number) ** (b as number),
  "&": ([a, b]) => (a as number) & (b as number),
  "|": ([a, b]) => (a as number) | (b as number),
  "^": ([a, b]) => (a as number) ^ (b as number),
  "<<": ([a, b]) => (a as number) << (b as number),
  ">>": ([a, b]) => (a as number) >> (b as number),
  ">>>": ([a, b]) => (a as number) >>> (b as number),
  "<": ([a, b]) => (a as number) < (b as number),
  ">": ([a, b]) => (a as number) > (b as number),
  "<=": ([a, b]) => (a as number) <= (b as number),
  ">=": ([a, b]) => (a as number) >= (b as number),
  "==": ([a, b]) => a == b,
  "===": ([a, b]) => a === b,
  "!=": ([a, b]) => a != b,
  "!==": ([a, b]) => a !== b,
};
function makeBinaryBody(op: ExprOp) {
  return BINARY_BODIES[op]!;
}
const UNARY_BODIES: Record<string, (i: [unknown]) => unknown> = {
  "u-": ([a]) => -(a as number),
  "u+": ([a]) => +(a as number),
  "u~": ([a]) => ~(a as number),
  "u!": ([a]) => !a,
};
function makeUnaryBody(op: ExprOp) {
  return UNARY_BODIES[op]!;
}

/** Extract a pattern and return its top-level ROG + the single `expr` op found. */
// deno-lint-ignore no-explicit-any
function extractExpr(pattern: any): {
  rog: Rog;
  exprOps: Op[];
  leafOps: Op[];
  internalToOp: Map<string, number>;
} {
  const extracted = extractRog(pattern);
  const exprOps = extracted.rog.ops.filter((o) => o.kind === "expr");
  const leafOps = extracted.rog.ops.filter((o) => o.kind === "leaf");
  return {
    rog: extracted.rog,
    exprOps,
    leafOps,
    internalToOp: extracted.internalToOp,
  };
}

/** Evaluate the extracted ROG against a plain argument and return `result.out`. */
function evalOut(
  rog: Rog,
  internalToOp: Map<string, number>,
  argument: unknown,
): unknown {
  const { result } = evalRog(rog, {
    argument,
    leafImpls: new Map(),
    internalToOp,
  });
  return (result as { out: unknown }).out;
}

describe("08 expr-interp: branded operator leaf → native expr op", () => {
  it("extracts a binary `+` leaf to an `expr` op (no leaf, no input construct)", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      const { rog, exprOps, leafOps } = extractExpr(
        buildBinaryExprPattern(cf, "+", num),
      );
      expect(exprOps.length).toBe(1);
      const op = exprOps[0];
      expect(op.detail.kind).toBe("expr");
      if (op.detail.kind === "expr") {
        expect(op.detail.op).toBe("+");
        // Operands ride positionally in op.inputs (binary = 2).
        expect(op.inputs.length).toBe(2);
        expect(op.detail.inputs.length).toBe(2);
      }
      // The opaque operator leaf is GONE — replaced natively.
      expect(leafOps.length).toBe(0);
      // No `{a,b}` input-construct synthesized for the operator (the only
      // construct is the result `{out}` object) — the serialized-boundary shrink.
      const constructOps = rog.ops.filter((o) => o.kind === "construct");
      expect(constructOps.length).toBeLessThanOrEqual(1);
    } finally {
      env.dispose();
    }
  });

  it("extracts a unary `!` leaf to an `expr` op with one positional operand", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      const { exprOps, leafOps } = extractExpr(
        buildUnaryExprPattern(cf, "u!", bool),
      );
      expect(exprOps.length).toBe(1);
      const op = exprOps[0];
      if (op.detail.kind === "expr") {
        expect(op.detail.op).toBe("u!");
        expect(op.inputs.length).toBe(1);
      }
      expect(leafOps.length).toBe(0);
    } finally {
      env.dispose();
    }
  });
});

describe("08 expr-interp: evalRog reproduces EXACT JS operator semantics", () => {
  // Each row: [op, a, b, expected] — the expected is the LITERAL JS result of
  // `a <op> b`, so any divergence is a fidelity bug. We deliberately include
  // coercion, NaN, relational, bitwise, and falsy-but-defined operands.
  const binaryRows: Array<[ExprOp, number, number, unknown]> = [
    ["+", 3, 4, 7],
    ["-", 10, 3, 7],
    ["*", 6, 7, 42],
    ["/", 10, 4, 2.5],
    ["/", 1, 0, Infinity],
    ["%", 10, 3, 1],
    ["**", 2, 10, 1024],
    ["&", 6, 3, 2],
    ["|", 4, 1, 5],
    ["^", 5, 1, 4],
    ["<<", 1, 4, 16],
    [">>", 256, 2, 64],
    [">>>", -1, 28, 15],
    ["<", 3, 4, true],
    ["<", 4, 3, false],
    [">", 5, 2, true],
    ["<=", 4, 4, true],
    [">=", 4, 5, false],
    ["==", 0, 0, true],
    ["===", 1, 1, true],
    ["!=", 1, 2, true],
    ["!==", 2, 2, false],
  ];
  for (const [op, a, b, expected] of binaryRows) {
    it(`binary ${a} ${op} ${b} === ${String(expected)}`, () => {
      const env = createMeasureEnv(signer);
      try {
        // deno-lint-ignore no-explicit-any
        const cf = env.commonfabric as any;
        const { rog, internalToOp } = extractExpr(
          buildBinaryExprPattern(cf, op, num),
        );
        const got = evalOut(rog, internalToOp, { a, b });
        // Byte-for-byte the raw JS operator result.
        // deno-lint-ignore no-explicit-any
        const raw = makeBinaryBody(op)([a, b] as any);
        expect(got).toEqual(raw);
        expect(got).toEqual(expected);
      } finally {
        env.dispose();
      }
    });
  }

  const unaryRows: Array<[ExprOp, number, unknown]> = [
    ["u-", 5, -5],
    ["u+", 5, 5],
    ["u~", 0, -1],
    ["u!", 0, true],
    ["u!", 1, false],
  ];
  for (const [op, a, expected] of unaryRows) {
    it(`unary ${op} ${a} === ${String(expected)}`, () => {
      const env = createMeasureEnv(signer);
      try {
        // deno-lint-ignore no-explicit-any
        const cf = env.commonfabric as any;
        const { rog, internalToOp } = extractExpr(
          buildUnaryExprPattern(cf, op, num),
        );
        const got = evalOut(rog, internalToOp, { a });
        // deno-lint-ignore no-explicit-any
        const raw = makeUnaryBody(op)([a] as any);
        expect(got).toEqual(raw);
        expect(got).toEqual(expected);
      } finally {
        env.dispose();
      }
    });
  }

  it("`&&`/`||`-style falsy-but-defined operands coerce exactly (=== / +)", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      // `0 === 0` is true; `"" + 0` would coerce — but these are number fields,
      // so test the equality family on falsy-but-defined operands.
      const eq = extractExpr(buildBinaryExprPattern(cf, "===", bool));
      expect(evalOut(eq.rog, eq.internalToOp, { a: 0, b: 0 })).toBe(true);
      expect(evalOut(eq.rog, eq.internalToOp, { a: 0, b: 1 })).toBe(false);
      // NaN !== NaN under === (the canonical fidelity trap).
      expect(evalOut(eq.rog, eq.internalToOp, { a: NaN, b: NaN })).toBe(false);
    } finally {
      env.dispose();
    }
  });
});

describe("08 expr-interp: FAIL-CLOSED — non-allow-list shapes stay `leaf`", () => {
  it("an UNBRANDED operator lift stays a leaf (never an expr op)", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      // A plain `lift(({a,b}) => a+b)({a,b})` — the un-branded shape — must NOT
      // lower. (This is what an unrecognized operator emits today.)
      const p = cf.pattern(
        ({ a, b }: { a: number; b: number }) => ({
          out: cf.lift(({ a, b }: { a: number; b: number }) => a + b)({ a, b }),
        }),
        {
          type: "object",
          properties: { a: num, b: num },
          required: ["a", "b"],
        },
        { type: "object", properties: { out: num } },
      );
      const { exprOps, leafOps } = extractExpr(p);
      expect(exprOps.length).toBe(0);
      expect(leafOps.length).toBe(1);
    } finally {
      env.dispose();
    }
  });

  it("an unknown-operator brand stays a leaf", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      // `expr:??` is not in the allow-list → recognizer returns null → leaf.
      const p = cf.pattern(
        ({ a, b }: { a: number; b: number }) => ({
          // deno-lint-ignore no-explicit-any
          out: cf.exprLift("expr:??", ([a, b]: [any, any]) => a ?? b)([a, b]),
        }),
        {
          type: "object",
          properties: { a: num, b: num },
          required: ["a", "b"],
        },
        { type: "object", properties: { out: num } },
      );
      const { exprOps, leafOps } = extractExpr(p);
      expect(exprOps.length).toBe(0);
      expect(leafOps.length).toBe(1);
    } finally {
      env.dispose();
    }
  });

  it("a wrong-arity brand stays a leaf (binary brand, one operand)", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      // Binary brand `expr:+` but only ONE operand → arity mismatch → leaf.
      const p = cf.pattern(
        ({ a }: { a: number }) => ({
          // deno-lint-ignore no-explicit-any
          out: cf.exprLift("expr:+", ([a]: [any]) => a + 1)([a]),
        }),
        { type: "object", properties: { a: num }, required: ["a"] },
        { type: "object", properties: { out: num } },
      );
      const { exprOps, leafOps } = extractExpr(p);
      expect(exprOps.length).toBe(0);
      expect(leafOps.length).toBe(1);
    } finally {
      env.dispose();
    }
  });
});
