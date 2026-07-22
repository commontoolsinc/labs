import { assertEquals, assertThrows } from "@std/assert";

import {
  assertSchemaJsonTransportSafe,
  findJsonUnsafeSchemaValues,
} from "./schema-transport.ts";

Deno.test("findJsonUnsafeSchemaValues: passes an ordinary schema", () => {
  const schema = {
    type: "object",
    properties: {
      n: { type: "number", default: -1, minimum: 0, maximum: 100 },
      s: { type: "string", default: "x" },
      flag: { type: "boolean", default: false },
      nothing: { type: "null", default: null },
      tags: { type: "array", default: ["a", "b"], items: { type: "string" } },
    },
    required: ["n"],
  };
  assertEquals(findJsonUnsafeSchemaValues(schema), []);
});

Deno.test("findJsonUnsafeSchemaValues: catches each non-finite and signed zero", () => {
  // One number the plain-JSON path alters, per row, at a `default`.
  const cases: Array<[unknown, string]> = [
    [NaN, "NaN"],
    [Infinity, "Infinity"],
    [-Infinity, "-Infinity"],
    [-0, "-0"],
  ];
  for (const [value, description] of cases) {
    const found = findJsonUnsafeSchemaValues({
      type: "number",
      default: value,
    });
    assertEquals(found, [{ path: "default", description }]);
  }
});

Deno.test("findJsonUnsafeSchemaValues: catches a bigint", () => {
  // JSON.stringify throws on a bigint rather than altering it; caught here so
  // the failure names the value instead of surfacing as an opaque serialization
  // error.
  const found = findJsonUnsafeSchemaValues({
    type: "integer",
    default: 12345678901234567890n,
  });
  assertEquals(found, [{
    path: "default",
    description: "12345678901234567890n",
  }]);
});

Deno.test("findJsonUnsafeSchemaValues: does not flag a finite -1 or +0", () => {
  // The negative SENTINEL and a plain zero are perfectly JSON-safe; only the
  // sign of an actual -0 is at risk.
  assertEquals(
    findJsonUnsafeSchemaValues({ type: "number", default: -1 }),
    [],
  );
  assertEquals(
    findJsonUnsafeSchemaValues({ type: "number", default: 0 }),
    [],
  );
});

Deno.test("findJsonUnsafeSchemaValues: reaches into nested defaults and arrays", () => {
  const found = findJsonUnsafeSchemaValues({
    type: "object",
    properties: {
      cfg: {
        type: "object",
        default: { ratio: NaN, offsets: [1, -0, 3] },
      },
    },
    examples: [{ ratio: -Infinity }],
  });
  assertEquals(found, [
    { path: "properties.cfg.default.ratio", description: "NaN" },
    { path: "properties.cfg.default.offsets[1]", description: "-0" },
    { path: "examples[0].ratio", description: "-Infinity" },
  ]);
});

Deno.test("findJsonUnsafeSchemaValues: flags a non-finite keyword value too", () => {
  // The hazard is not specific to `default`: a non-finite `maximum` would be
  // rendered `null` just the same.
  const found = findJsonUnsafeSchemaValues({
    type: "number",
    maximum: Infinity,
  });
  assertEquals(found, [{ path: "maximum", description: "Infinity" }]);
});

Deno.test("assertSchemaJsonTransportSafe: returns for a safe schema", () => {
  assertSchemaJsonTransportSafe({ type: "number", default: -1 });
});

Deno.test("assertSchemaJsonTransportSafe: throws, naming path and value", () => {
  const err = assertThrows(
    () =>
      assertSchemaJsonTransportSafe({
        type: "object",
        properties: { n: { type: "number", default: NaN } },
      }),
    Error,
  );
  const message = err.message;
  // The author needs to see both which value and where.
  assertEquals(message.includes("properties.n.default"), true);
  assertEquals(message.includes("NaN"), true);
});

Deno.test("assertSchemaJsonTransportSafe: lists every offender", () => {
  const err = assertThrows(
    () =>
      assertSchemaJsonTransportSafe({
        type: "object",
        properties: {
          a: { type: "number", default: NaN },
          b: { type: "number", default: -0 },
        },
      }),
    Error,
  );
  assertEquals(err.message.includes("properties.a.default"), true);
  assertEquals(err.message.includes("properties.b.default"), true);
  assertEquals(err.message.includes("2 value(s)"), true);
});
