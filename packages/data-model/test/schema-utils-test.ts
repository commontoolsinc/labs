import { assertEquals, assertThrows } from "@std/assert";
import type { JSONSchemaObj } from "@commontools/api";
import { deepFreeze } from "../deep-freeze.ts";
import { toDeepFrozenSchema } from "../schema-utils.ts";

Deno.test("toDeepFrozenSchema - boolean true is returned as-is", () => {
  const result = toDeepFrozenSchema(true, false);
  assertEquals(result, true);
});

Deno.test("toDeepFrozenSchema - boolean false is returned as-is", () => {
  const result = toDeepFrozenSchema(false, true);
  assertEquals(result, false);
});

Deno.test("toDeepFrozenSchema - canShare=true freezes input in place", () => {
  const schema: JSONSchemaObj = {
    type: "object",
    properties: {
      name: { type: "string" },
    },
  };

  const result = toDeepFrozenSchema(schema, true);

  // Should be the same reference.
  assertEquals(result === schema, true);

  // Should be frozen at the top level.
  assertEquals(Object.isFrozen(schema), true);

  // Nested objects should also be frozen.
  assertEquals(Object.isFrozen(schema.properties), true);
  assertEquals(Object.isFrozen(schema.properties!.name), true);
});

Deno.test("toDeepFrozenSchema - canShare=false clones before freezing", () => {
  const schema: JSONSchemaObj = {
    type: "object",
    properties: {
      age: { type: "integer" },
    },
  };

  const result = toDeepFrozenSchema(schema, false);

  // Should NOT be the same reference.
  assertEquals(result !== schema, true);

  // Original should NOT be frozen.
  assertEquals(Object.isFrozen(schema), false);

  // Result should be deeply frozen.
  assertEquals(Object.isFrozen(result), true);
  const obj = result as JSONSchemaObj;
  assertEquals(Object.isFrozen(obj.properties), true);
  assertEquals(Object.isFrozen(obj.properties!.age), true);
});

Deno.test("toDeepFrozenSchema - deeply nested schemas are frozen", () => {
  const schema: JSONSchemaObj = {
    type: "object",
    properties: {
      address: {
        type: "object",
        properties: {
          street: { type: "string" },
          city: { type: "string" },
        },
        required: ["street"],
      },
    },
  };

  const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

  assertEquals(Object.isFrozen(result), true);
  assertEquals(Object.isFrozen(result.properties), true);

  const address = result.properties!.address as JSONSchemaObj;
  assertEquals(Object.isFrozen(address), true);
  assertEquals(Object.isFrozen(address.properties), true);
  assertEquals(Object.isFrozen(address.required), true);
  assertEquals(Object.isFrozen(address.properties!.street), true);
});

Deno.test("toDeepFrozenSchema - frozen schema rejects mutation", () => {
  const schema: JSONSchemaObj = { type: "string" };
  toDeepFrozenSchema(schema, true);

  assertThrows(
    () => {
      (schema as Record<string, unknown>).type = "number";
    },
    TypeError,
  );
});

Deno.test("toDeepFrozenSchema - schema with arrays is frozen", () => {
  const schema: JSONSchemaObj = {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["tags"],
  };

  const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

  assertEquals(Object.isFrozen(result), true);
  assertEquals(Object.isFrozen(result.required), true);

  const tags = result.properties!.tags as JSONSchemaObj;
  assertEquals(Object.isFrozen(tags), true);
  assertEquals(Object.isFrozen(tags.items), true);
});

Deno.test("toDeepFrozenSchema - anyOf schemas are frozen", () => {
  const schema: JSONSchemaObj = {
    anyOf: [
      { type: "string" },
      { type: "number" },
    ],
  };

  const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

  assertEquals(Object.isFrozen(result), true);
  assertEquals(Object.isFrozen(result.anyOf), true);
  assertEquals(Object.isFrozen(result.anyOf![0]), true);
  assertEquals(Object.isFrozen(result.anyOf![1]), true);
});

Deno.test(
  "toDeepFrozenSchema - canShare=false preserves original schema",
  () => {
    const inner: JSONSchemaObj = { type: "string" };
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { name: inner },
    };

    toDeepFrozenSchema(schema, false);

    // Original should still be mutable.
    assertEquals(Object.isFrozen(schema), false);
    assertEquals(Object.isFrozen(inner), false);

    // Prove mutability by actually mutating.
    (inner as Record<string, unknown>).type = "number";
    assertEquals(inner.type, "number");
  },
);

Deno.test("toDeepFrozenSchema - already-frozen schema is handled", () => {
  const schema: JSONSchemaObj = Object.freeze({ type: "string" as const });
  const result = toDeepFrozenSchema(schema, true);
  assertEquals(result === schema, true);
  assertEquals(Object.isFrozen(result), true);
});

Deno.test("toDeepFrozenSchema - enum values are frozen", () => {
  const schema: JSONSchemaObj = {
    type: "string",
    enum: ["a", "b", "c"],
  };

  const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;
  assertEquals(Object.isFrozen(result.enum), true);
});

// ---------------------------------------------------------------------------
// New behavior tests (per Dan's rewrite)
// ---------------------------------------------------------------------------

Deno.test(
  "toDeepFrozenSchema - already-deep-frozen returns same reference (canShare=true)",
  () => {
    const schema: JSONSchemaObj = deepFreeze({
      type: "object",
      properties: { name: { type: "string" } },
    });

    const result = toDeepFrozenSchema(schema, true);
    assertEquals(result === schema, true);
  },
);

Deno.test(
  "toDeepFrozenSchema - already-deep-frozen returns same reference (canShare=false)",
  () => {
    const schema: JSONSchemaObj = deepFreeze({
      type: "object",
      properties: { age: { type: "number" } },
    });

    const result = toDeepFrozenSchema(schema, false);
    assertEquals(result === schema, true);
  },
);

Deno.test(
  "toDeepFrozenSchema - frozen but not deep-frozen schema is shallow-cloned even with canShare=true",
  () => {
    const inner = { type: "string" } as JSONSchemaObj;
    const schema: JSONSchemaObj = Object.freeze({
      type: "object",
      properties: Object.freeze({ name: inner }),
    } as JSONSchemaObj);
    // schema is frozen, but inner is not — so not deep-frozen.

    const result = toDeepFrozenSchema(schema, true);

    // Must be a different reference (shallow-cloned) since original is
    // frozen and can't be mutated.
    assertEquals(result !== schema, true);

    // Result must be deeply frozen.
    assertEquals(Object.isFrozen(result), true);
    const obj = result as JSONSchemaObj;
    assertEquals(Object.isFrozen(obj.properties), true);
  },
);

Deno.test(
  "toDeepFrozenSchema - per-property: already-deep-frozen top-level values are reused",
  () => {
    // The per-property optimization works on the schema's own top-level
    // fields (e.g., "type", "properties", "required"). An already-deep-frozen
    // field value is kept as-is; an unfrozen one is structuredClone'd.
    const frozenProperties = deepFreeze({
      name: { type: "string" },
    } as Record<string, JSONSchemaObj>);
    const unfrozenRequired = ["name"];
    const schema: JSONSchemaObj = {
      type: "object",
      properties: frozenProperties,
      required: unfrozenRequired,
    };

    const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

    // The already-deep-frozen "properties" value should be the same reference.
    assertEquals(result.properties === frozenProperties, true);

    // The unfrozen "required" should be a different reference (cloned).
    assertEquals(result.required !== unfrozenRequired, true);

    // Both should be deeply frozen in the result.
    assertEquals(Object.isFrozen(result.properties), true);
    assertEquals(Object.isFrozen(result.required), true);
  },
);

Deno.test(
  "toDeepFrozenSchema - canShare=false does not freeze original property values",
  () => {
    const innerProp = { type: "string" } as JSONSchemaObj;
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { x: innerProp },
    };

    toDeepFrozenSchema(schema, false);

    // Original property value should not be frozen.
    assertEquals(Object.isFrozen(innerProp), false);
  },
);
