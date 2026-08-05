import { assert, assertEquals } from "@std/assert";

import plugin from "../lint-plugins/no-prototype-aware-in.ts";

interface Report {
  node: unknown;
  message: string;
}

function createRule(reports: Report[], filename = "/src/thing.ts") {
  return plugin.rules["no-prototype-aware-in"].create({
    filename,
    report(report: Report) {
      reports.push(report);
    },
  } as never);
}

/** `<left> in <right>`, with `left` spelled as the given AST node. */
function inExpression(left: Record<string, unknown>) {
  return { type: "BinaryExpression", operator: "in", left, right: {} };
}

const identifier = { type: "Identifier", name: "key" };
const stringLiteral = (value: string) => ({ type: "Literal", value });
const numberLiteral = (value: number) => ({ type: "Literal", value });

function reportsFor(left: Record<string, unknown>): Report[] {
  const reports: Report[] = [];
  const rule = createRule(reports);
  const visit = rule.BinaryExpression;
  assert(visit);
  visit(inExpression(left) as never);
  return reports;
}

Deno.test("flags a non-literal key, which is the dangerous shape", () => {
  assertEquals(reportsFor(identifier).length, 1);
});

Deno.test("flags a member-expression key", () => {
  assertEquals(
    reportsFor({
      type: "MemberExpression",
      object: { type: "Identifier", name: "node" },
      property: { type: "Identifier", name: "field" },
    }).length,
    1,
  );
});

// The overwhelmingly common safe use: discriminated-union narrowing on a name
// the code chose. Flagging these would make the rule unusable.
Deno.test("allows an ordinary string literal", () => {
  assertEquals(reportsFor(stringLiteral("error")).length, 0);
  assertEquals(reportsFor(stringLiteral("scope")).length, 0);
  assertEquals(reportsFor(stringLiteral("$value")).length, 0);
});

Deno.test("flags a string literal that names an Object.prototype member", () => {
  for (
    const name of [
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
      "constructor",
      "__proto__",
    ]
  ) {
    const reports = reportsFor(stringLiteral(name));
    assertEquals(reports.length, 1, `expected \`"${name}" in x\` to report`);
    assert(reports[0]!.message.includes(name));
  }
});

// `0 in arr` is a sparse-hole probe. Arrays do not inherit index properties,
// so `in` is the correct operator there and must stay quiet.
Deno.test("allows a numeric literal index probe", () => {
  assertEquals(reportsFor(numberLiteral(0)).length, 0);
  assertEquals(reportsFor(numberLiteral(42)).length, 0);
});

Deno.test("ignores binary expressions that are not `in`", () => {
  const reports: Report[] = [];
  const rule = createRule(reports);
  const visit = rule.BinaryExpression;
  assert(visit);
  visit(
    {
      type: "BinaryExpression",
      operator: "instanceof",
      left: identifier,
      right: {},
    } as never,
  );
  visit(
    {
      type: "BinaryExpression",
      operator: "===",
      left: identifier,
      right: {},
    } as never,
  );
  assertEquals(reports.length, 0);
});

// Deno has spelled literals more than one way across versions. If the AST shape
// changes under us the rule must get LOUDER, not silently stop reporting —
// an unknown left-hand shape is treated as non-literal and flagged.
Deno.test("an unrecognised literal spelling still reports rather than passing", () => {
  assertEquals(reportsFor({ type: "StringLiteral", value: "error" }).length, 0);
  assertEquals(reportsFor({ type: "NumericLiteral", value: 0 }).length, 0);
  assertEquals(
    reportsFor({ type: "SomeFutureLiteralNode", value: "error" }).length,
    1,
  );
});

Deno.test("the message names the fix", () => {
  const reports = reportsFor(identifier);
  assertEquals(reports.length, 1);
  const message = reports[0]!.message;
  assert(message.includes("Object.hasOwn"));
  assert(message.includes("deno-lint-ignore"));
});
