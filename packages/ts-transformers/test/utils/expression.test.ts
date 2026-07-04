import ts from "typescript";
import { assert, assertEquals } from "@std/assert";
import { unwrapExpression } from "../../src/utils/expression.ts";

Deno.test("unwrapExpression unwraps a partially emitted expression", () => {
  const literal = ts.factory.createNumericLiteral("1");
  const wrapped = ts.factory.createPartiallyEmittedExpression(literal);

  assertEquals(unwrapExpression(wrapped), literal);
});

Deno.test(
  "unwrapExpression keeps a partially emitted wrapper when excluded",
  () => {
    const literal = ts.factory.createNumericLiteral("1");
    const wrapped = ts.factory.createPartiallyEmittedExpression(literal);

    const result = unwrapExpression(wrapped, {
      includePartiallyEmitted: false,
    });
    assert(ts.isPartiallyEmittedExpression(result));
  },
);
