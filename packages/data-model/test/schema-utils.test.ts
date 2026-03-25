import { describe, it } from "@std/testing/bdd";
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { JSONSchemaObj } from "@commontools/api";
import { deepFreeze } from "../deep-freeze.ts";
import {
  cloneSchemaMutable,
  isNontrivialSchema,
  schemaWithoutProperties,
  schemaWithProperties,
  toDeepFrozenSchema,
} from "../schema-utils.ts";

describe("toDeepFrozenSchema", () => {
  describe("boolean schemas", () => {
    it("boolean true is returned as-is", () => {
      const result = toDeepFrozenSchema(true, false);
      assertEquals(result, true);
    });

    it("boolean false is returned as-is", () => {
      const result = toDeepFrozenSchema(false, true);
      assertEquals(result, false);
    });
  });

  describe("canShare=true", () => {
    it("freezes input in place", () => {
      const originalProperties = {
        name: { type: "string" } as JSONSchemaObj,
      };
      const schema: JSONSchemaObj = {
        type: "object",
        properties: originalProperties,
      };

      const result = toDeepFrozenSchema(schema, true);

      // Top-level should be the same reference — frozen in place.
      assertEquals(result === schema, true);
      assertEquals(Object.isFrozen(schema), true);

      // Property values are replaced with frozen clones (not the originals).
      assertEquals(Object.isFrozen(schema.properties), true);
      assertEquals(schema.properties !== originalProperties, true);
      assertEquals(Object.isFrozen(schema.properties!.name), true);
    });

    it("unfrozen schema is frozen in place (same reference)", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
      };

      const result = toDeepFrozenSchema(schema, true);

      // Same reference — frozen in place, not cloned.
      assertEquals(result === schema, true);
      assertEquals(Object.isFrozen(result), true);
    });
  });

  describe("canShare=false", () => {
    it("clones before freezing", () => {
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

    it("preserves original schema", () => {
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
    });

    it("does not freeze original property values", () => {
      const innerProp = { type: "string" } as JSONSchemaObj;
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: innerProp },
      };

      toDeepFrozenSchema(schema, false);

      // Original property value should not be frozen.
      assertEquals(Object.isFrozen(innerProp), false);
    });
  });

  describe("deeply nested schemas", () => {
    it("deeply nested schemas are frozen", () => {
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

    it("schema with arrays is frozen", () => {
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

    it("anyOf schemas are frozen", () => {
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

    it("enum values are frozen", () => {
      const schema: JSONSchemaObj = {
        type: "string",
        enum: ["a", "b", "c"],
      };

      const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;
      assertEquals(Object.isFrozen(result.enum), true);
    });
  });

  describe("immutability enforcement", () => {
    it("frozen schema rejects mutation", () => {
      const schema: JSONSchemaObj = { type: "string" };
      toDeepFrozenSchema(schema, true);

      assertThrows(
        () => {
          (schema as Record<string, unknown>).type = "number";
        },
        TypeError,
      );
    });
  });

  describe("already-frozen input handling", () => {
    it("already-frozen schema is handled", () => {
      const schema: JSONSchemaObj = Object.freeze({ type: "string" as const });
      const result = toDeepFrozenSchema(schema, true);
      assertEquals(result === schema, true);
      assertEquals(Object.isFrozen(result), true);
    });

    it("already-deep-frozen returns same reference (canShare=true)", () => {
      const schema: JSONSchemaObj = deepFreeze({
        type: "object",
        properties: { name: { type: "string" } },
      });

      const result = toDeepFrozenSchema(schema, true);
      assertEquals(result === schema, true);
    });

    it("already-deep-frozen returns same reference (canShare=false)", () => {
      const schema: JSONSchemaObj = deepFreeze({
        type: "object",
        properties: { age: { type: "number" } },
      });

      const result = toDeepFrozenSchema(schema, false);
      assertEquals(result === schema, true);
    });

    it("frozen but not deep-frozen schema is shallow-cloned even with canShare=true", () => {
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
    });
  });

  describe("per-property optimization", () => {
    it("already-deep-frozen top-level values are reused", () => {
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
    });
  });
});

describe("isNontrivialSchema", () => {
  describe("nullish inputs", () => {
    it("returns false for undefined", () => {
      assertEquals(isNontrivialSchema(undefined), false);
    });

    it("returns false for null", () => {
      assertEquals(isNontrivialSchema(null), false);
    });
  });

  describe("boolean schemas", () => {
    it("returns false for true", () => {
      assertEquals(isNontrivialSchema(true), false);
    });

    it("returns false for false", () => {
      assertEquals(isNontrivialSchema(false), false);
    });
  });

  describe("empty object schema", () => {
    it("returns false for {}", () => {
      assertEquals(isNontrivialSchema({}), false);
    });
  });

  describe("non-trivial schemas", () => {
    it("returns true for a schema with type", () => {
      assertEquals(isNontrivialSchema({ type: "string" }), true);
    });

    it("returns true for a schema with properties", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      assertEquals(isNontrivialSchema(schema), true);
    });

    it("returns true for a schema with only $ref", () => {
      assertEquals(isNontrivialSchema({ $ref: "#/definitions/Foo" }), true);
    });

    it("returns true for a schema with anyOf", () => {
      assertEquals(
        isNontrivialSchema({ anyOf: [{ type: "string" }, { type: "number" }] }),
        true,
      );
    });

    it("returns true for a frozen non-empty schema", () => {
      const schema = Object.freeze({ type: "number" as const });
      assertEquals(isNontrivialSchema(schema), true);
    });

    it("returns true for a deep-frozen schema", () => {
      const schema: JSONSchemaObj = deepFreeze({
        type: "object",
        properties: { x: { type: "number" } },
      });
      assertEquals(isNontrivialSchema(schema), true);
    });
  });

  describe("type narrowing", () => {
    it("narrows to JSONSchemaObj (allows property access)", () => {
      const schema: JSONSchemaObj | undefined = {
        type: "object",
        properties: { a: { type: "string" } },
      };
      if (isNontrivialSchema(schema)) {
        assertEquals(schema.type, "object");
        assertEquals(typeof schema.properties, "object");
      } else {
        throw new Error("Expected isNontrivialSchema to return true");
      }
    });
  });
});

describe("cloneSchemaMutable", () => {
  it("returns boolean true as-is", () => {
    assertEquals(cloneSchemaMutable(true), true);
  });

  it("returns boolean false as-is", () => {
    assertEquals(cloneSchemaMutable(false), false);
  });

  it("returns {} for undefined", () => {
    const result = cloneSchemaMutable(undefined);
    assertEquals(result, {});
  });

  it("forceObject returns {} for undefined", () => {
    const result = cloneSchemaMutable(undefined, true);
    assertEquals(result, {});
  });

  it("forceObject returns {} for boolean true", () => {
    const result = cloneSchemaMutable(true, true);
    assertEquals(result, {});
  });

  it("forceObject returns {} for boolean false", () => {
    const result = cloneSchemaMutable(false, true);
    assertEquals(result, {});
  });

  it("returns a deep copy of an object schema", () => {
    const inner: JSONSchemaObj = { type: "string" };
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { name: inner },
    };

    const result = cloneSchemaMutable(schema) as JSONSchemaObj;

    // Different reference.
    assertEquals(result !== schema, true);
    // Content is equal.
    assertEquals(result.type, "object");
    assertEquals((result.properties!.name as JSONSchemaObj).type, "string");
    // Nested objects are also cloned (deep).
    assertEquals(result.properties !== schema.properties, true);
  });

  it("result is deeply mutable", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { x: { type: "number" } },
    };

    const result = cloneSchemaMutable(schema) as JSONSchemaObj;
    assertEquals(Object.isFrozen(result), false);

    // Top-level mutation should work.
    (result as Record<string, unknown>).type = "array";
    assertEquals(result.type, "array");

    // Nested mutation should also work.
    assertEquals(Object.isFrozen(result.properties), false);
    const xProp = result.properties!.x as Record<string, unknown>;
    assertEquals(Object.isFrozen(xProp), false);
    xProp.type = "string";
    assertEquals((result.properties!.x as JSONSchemaObj).type, "string");
  });

  it("does not mutate the original", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { a: { type: "string" } },
    };

    const result = cloneSchemaMutable(schema) as Record<string, unknown>;
    result.type = "array";

    assertEquals(schema.type, "object");
  });

  it("clones a frozen schema into a mutable copy", () => {
    const schema = toDeepFrozenSchema({
      type: "object",
      properties: { y: { type: "number" } },
    } as JSONSchemaObj);

    const result = cloneSchemaMutable(schema) as JSONSchemaObj;

    assertEquals(Object.isFrozen(result), false);
    assertEquals(result.type, "object");
    // Nested properties should also be mutable.
    assertEquals(
      Object.isFrozen(result.properties),
      false,
    );
  });

  it("handles schema with arrays (anyOf)", () => {
    const schema: JSONSchemaObj = {
      anyOf: [{ type: "string" }, { type: "number" }],
    };

    const result = cloneSchemaMutable(schema) as JSONSchemaObj;

    assertEquals(result !== schema, true);
    assertEquals(result.anyOf!.length, 2);
    assertEquals(result.anyOf !== schema.anyOf, true);
  });

  it("handles empty object schema", () => {
    const schema: JSONSchemaObj = {};
    const result = cloneSchemaMutable(schema) as JSONSchemaObj;

    assertEquals(result !== schema, true);
    assertEquals(Object.keys(result).length, 0);
  });
});

describe("schemaWithProperties", () => {
  it("returns a new object with overrides applied", () => {
    const schema: JSONSchemaObj = { type: "object", description: "old" };
    const result = schemaWithProperties(schema, {
      description: "new",
    }) as JSONSchemaObj;

    assertEquals(result !== schema, true);
    assertEquals(result.type, "object");
    assertEquals(result.description, "new");
  });

  it("does not mutate the original", () => {
    const schema: JSONSchemaObj = { type: "string" };
    schemaWithProperties(schema, { type: "number" });

    assertEquals(schema.type, "string");
  });

  it("can set properties to undefined (key remains present)", () => {
    const schema = { type: "object", asStream: true } as JSONSchemaObj;
    const result = schemaWithProperties(schema, {
      asStream: undefined,
    }) as JSONSchemaObj;

    // The key must still exist on the result — `undefined` is a meaningful
    // value distinct from absence, which matters once schemas carry
    // FabricValue-typed fields.
    assertEquals(result.asStream, undefined);
    assertEquals("asStream" in result, true);
    assertEquals(result.type, "object");
  });

  it("can add new properties", () => {
    const schema: JSONSchemaObj = { type: "object" };
    const result = schemaWithProperties(schema, {
      $defs: { Foo: { type: "string" } },
    }) as JSONSchemaObj;

    assertEquals(result.$defs!.Foo, { type: "string" });
  });

  it("preserves properties not in overrides", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const result = schemaWithProperties(schema, {
      type: "array",
    }) as JSONSchemaObj;

    assertEquals(result.type, "array");
    assertEquals(result.required, ["a"]);
    assertEquals((result.properties!.a as JSONSchemaObj).type, "string");
  });

  it("returns a frozen result", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { x: { type: "number" } },
    };
    const result = schemaWithProperties(schema, {
      description: "hi",
    }) as JSONSchemaObj;

    assertEquals(Object.isFrozen(result), true);
    assertEquals(Object.isFrozen(result.properties), true);
  });

  it("distinguishes undefined-valued key from absent key", () => {
    // A schema with no `description` key at all.
    const schema: JSONSchemaObj = { type: "string" };
    assertEquals("description" in schema, false);

    // Setting description to undefined: key is present but value is undefined.
    const withUndefined = schemaWithProperties(schema, {
      description: undefined,
    }) as JSONSchemaObj;
    assertEquals("description" in withUndefined, true);
    assertEquals(withUndefined.description, undefined);

    // Not mentioning description: key remains absent.
    const withoutOverride = schemaWithProperties(schema, {
      type: "number",
    }) as JSONSchemaObj;
    assertEquals("description" in withoutOverride, false);
  });

  it("treats undefined as {} and applies overrides", () => {
    const result = schemaWithProperties(undefined, { type: "string" });
    assertEquals(result, { type: "string" });
    assertEquals(Object.isFrozen(result), true);
  });

  it("treats boolean true as {} and applies overrides", () => {
    const result = schemaWithProperties(true, { type: "string" });
    assertEquals(result, { type: "string" });
    assertEquals(Object.isFrozen(result), true);
  });

  it("returns false as-is regardless of overrides", () => {
    const result = schemaWithProperties(false, { type: "string" });
    assertEquals(result, false);
  });
});

describe("schemaWithoutProperties", () => {
  it("removes a single named property", () => {
    const schema: JSONSchemaObj = { type: "object", asCell: true };
    const result = schemaWithoutProperties(schema, "asCell") as JSONSchemaObj;

    assertEquals(result, { type: "object" });
    assertEquals("asCell" in result, false);
  });

  it("removes multiple named properties", () => {
    const schema = {
      type: "object",
      asCell: true,
      asStream: true,
    } as JSONSchemaObj;
    const result = schemaWithoutProperties(
      schema,
      "asCell",
      "asStream",
    ) as JSONSchemaObj;

    assertEquals(result, { type: "object" });
    assertEquals("asCell" in result, false);
    assertEquals("asStream" in result, false);
  });

  it("returns a frozen result", () => {
    const schema: JSONSchemaObj = { type: "object", asCell: true };
    const result = schemaWithoutProperties(schema, "asCell");

    assertEquals(Object.isFrozen(result), true);
  });

  it("does not mutate the original", () => {
    const schema: JSONSchemaObj = { type: "object", asCell: true };
    schemaWithoutProperties(schema, "asCell");

    assertEquals(schema.asCell, true);
  });

  it("is a no-op (deep-frozen clone) when the named property is absent from a mutable schema", () => {
    const schema: JSONSchemaObj = { not: { type: "string" } };
    const result = schemaWithoutProperties(schema, "asCell");

    assertEquals(result, schema);
    assertEquals(Object.isFrozen(result), true);
    assertEquals(Object.isFrozen((result as JSONSchemaObj).not), true);
  });

  it("is a true no-op when the named property is absent from a deep-frozen schema", () => {
    const schema = toDeepFrozenSchema(
      { type: "string" } as JSONSchemaObj,
      true,
    );
    const result = schemaWithoutProperties(schema, "asCell");

    assertStrictEquals(result, schema);
  });

  it("treats undefined as true (accept everything)", () => {
    assertEquals(schemaWithoutProperties(undefined, "asCell"), true);
  });

  it("returns boolean true as-is", () => {
    assertEquals(schemaWithoutProperties(true, "asCell"), true);
  });

  it("returns boolean false as-is", () => {
    assertEquals(schemaWithoutProperties(false, "asCell"), false);
  });
});
