import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import type {
  FabricValue,
  JSONSchema,
  JSONSchemaObj,
  JSONSchemaTypes,
  SchemaPathSelector,
} from "@commonfabric/api";
import { deepFreeze, isDeepFrozen } from "../deep-freeze.ts";
import {
  cloneSchemaMutable,
  emptySchemaObject,
  internPathSelector,
  internSchemaPairAsKey,
  isNontrivialSchema,
  schemaForValueType,
  schemaWithoutProperties,
  schemaWithProperties,
  toDeepFrozenSchema,
} from "../schema-utils.ts";
import { internSchema, isInternedSchema } from "../schema-hash.ts";

describe("toDeepFrozenSchema", () => {
  describe("boolean schemas", () => {
    it("boolean true is returned as-is", () => {
      const result = toDeepFrozenSchema(true, false);
      expect(result).toBe(true);
    });

    it("boolean false is returned as-is", () => {
      const result = toDeepFrozenSchema(false, true);
      expect(result).toBe(false);
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
      assert(result === schema);
      assert(Object.isFrozen(schema));

      // Property values are replaced with frozen clones (not the originals).
      assert(Object.isFrozen(schema.properties));
      assert(schema.properties !== originalProperties);
      assert(Object.isFrozen(schema.properties!.name));
    });

    it("unfrozen schema is frozen in place (same reference)", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
      };

      const result = toDeepFrozenSchema(schema, true);

      // Same reference — frozen in place, not cloned.
      assert(result === schema);
      assert(Object.isFrozen(result));
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
      assert(result !== schema);

      // Original should NOT be frozen.
      assert(!Object.isFrozen(schema));

      // Result should be deeply frozen.
      assert(Object.isFrozen(result));
      const obj = result as JSONSchemaObj;
      assert(Object.isFrozen(obj.properties));
      assert(Object.isFrozen(obj.properties!.age));
    });

    it("preserves original schema", () => {
      const inner: JSONSchemaObj = { type: "string" };
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: inner },
      };

      toDeepFrozenSchema(schema, false);

      // Original should still be mutable.
      assert(!Object.isFrozen(schema));
      assert(!Object.isFrozen(inner));

      // Prove mutability by actually mutating.
      (inner as Record<string, unknown>).type = "number";
      expect(inner.type).toBe("number");
    });

    it("does not freeze original property values", () => {
      const innerProp = { type: "string" } as JSONSchemaObj;
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: innerProp },
      };

      toDeepFrozenSchema(schema, false);

      // Original property value should not be frozen.
      assert(!Object.isFrozen(innerProp));
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

      assert(Object.isFrozen(result));
      assert(Object.isFrozen(result.properties));

      const address = result.properties!.address as JSONSchemaObj;
      assert(Object.isFrozen(address));
      assert(Object.isFrozen(address.properties));
      assert(Object.isFrozen(address.required));
      assert(Object.isFrozen(address.properties!.street));
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

      assert(Object.isFrozen(result));
      assert(Object.isFrozen(result.required));

      const tags = result.properties!.tags as JSONSchemaObj;
      assert(Object.isFrozen(tags));
      assert(Object.isFrozen(tags.items));
    });

    it("anyOf schemas are frozen", () => {
      const schema: JSONSchemaObj = {
        anyOf: [
          { type: "string" },
          { type: "number" },
        ],
      };

      const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

      assert(Object.isFrozen(result));
      assert(Object.isFrozen(result.anyOf));
      assert(Object.isFrozen(result.anyOf![0]));
      assert(Object.isFrozen(result.anyOf![1]));
    });

    it("enum values are frozen", () => {
      const schema: JSONSchemaObj = {
        type: "string",
        enum: ["a", "b", "c"],
      };

      const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;
      assert(Object.isFrozen(result.enum));
    });
  });

  describe("immutability enforcement", () => {
    it("frozen schema rejects mutation", () => {
      const schema: JSONSchemaObj = { type: "string" };
      toDeepFrozenSchema(schema, true);

      expect(() => {
        (schema as Record<string, unknown>).type = "number";
      }).toThrow(TypeError);
    });
  });

  describe("interned schema handling", () => {
    it("returns an interned schema as-is", () => {
      const schema = internSchema({ type: "string" });
      const result = toDeepFrozenSchema(schema);
      expect(result).toBe(schema);
    });

    it("returns an interned schema as-is even with canShare=false", () => {
      const schema = internSchema({
        type: "object",
        properties: { x: { type: "number" } },
      });
      const result = toDeepFrozenSchema(schema, false);
      expect(result).toBe(schema);
    });
  });

  describe("already-frozen input handling", () => {
    it("already-frozen schema is handled", () => {
      const schema: JSONSchemaObj = Object.freeze({ type: "string" as const });
      const result = toDeepFrozenSchema(schema, true);
      assert(result === schema);
      assert(Object.isFrozen(result));
    });

    it("already-deep-frozen returns same reference (canShare=true)", () => {
      const schema: JSONSchemaObj = deepFreeze({
        type: "object",
        properties: { name: { type: "string" } },
      });

      const result = toDeepFrozenSchema(schema, true);
      assert(result === schema);
    });

    it("already-deep-frozen returns same reference (canShare=false)", () => {
      const schema: JSONSchemaObj = deepFreeze({
        type: "object",
        properties: { age: { type: "number" } },
      });

      const result = toDeepFrozenSchema(schema, false);
      assert(result === schema);
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
      assert(result !== schema);

      // Result must be deeply frozen.
      assert(Object.isFrozen(result));
      const obj = result as JSONSchemaObj;
      assert(Object.isFrozen(obj.properties));
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
      assert(result.properties === frozenProperties);

      // The unfrozen "required" should be a different reference (cloned).
      assert(result.required !== unfrozenRequired);

      // Both should be deeply frozen in the result.
      assert(Object.isFrozen(result.properties));
      assert(Object.isFrozen(result.required));
    });
  });
});

describe("isNontrivialSchema", () => {
  describe("nullish inputs", () => {
    it("returns false for undefined", () => {
      assert(!isNontrivialSchema(undefined));
    });

    it("returns false for null", () => {
      assert(!isNontrivialSchema(null));
    });
  });

  describe("boolean schemas", () => {
    it("returns false for true", () => {
      assert(!isNontrivialSchema(true));
    });

    it("returns false for false", () => {
      assert(!isNontrivialSchema(false));
    });
  });

  describe("empty object schema", () => {
    it("returns false for {}", () => {
      assert(!isNontrivialSchema({}));
    });
  });

  describe("non-trivial schemas", () => {
    it("returns true for a schema with type", () => {
      assert(isNontrivialSchema({ type: "string" }));
    });

    it("returns true for a schema with properties", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      assert(isNontrivialSchema(schema));
    });

    it("returns true for a schema with only $ref", () => {
      assert(isNontrivialSchema({ $ref: "#/definitions/Foo" }));
    });

    it("returns true for a schema with anyOf", () => {
      expect(
        isNontrivialSchema({ anyOf: [{ type: "string" }, { type: "number" }] }),
      ).toBe(true);
    });

    it("returns true for a frozen non-empty schema", () => {
      const schema = Object.freeze({ type: "number" as const });
      assert(isNontrivialSchema(schema));
    });

    it("returns true for a deep-frozen schema", () => {
      const schema: JSONSchemaObj = deepFreeze({
        type: "object",
        properties: { x: { type: "number" } },
      });
      assert(isNontrivialSchema(schema));
    });
  });

  describe("type narrowing", () => {
    it("narrows to JSONSchemaObj (allows property access)", () => {
      const schema: JSONSchemaObj | undefined = {
        type: "object",
        properties: { a: { type: "string" } },
      };
      if (isNontrivialSchema(schema)) {
        expect(schema.type).toBe("object");
        expect(typeof schema.properties).toBe("object");
      } else {
        throw new Error("Expected isNontrivialSchema to return true");
      }
    });
  });
});

describe("cloneSchemaMutable", () => {
  it("returns {} for boolean true", () => {
    expect(cloneSchemaMutable(true)).toEqual({});
  });

  it("returns { not: true } for boolean false", () => {
    expect(cloneSchemaMutable(false)).toEqual({ not: true });
  });

  it("returns {} for undefined", () => {
    const result = cloneSchemaMutable(undefined);
    expect(result).toEqual({});
  });

  it("returns a shallow copy by default", () => {
    const inner: JSONSchemaObj = { type: "string" };
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { name: inner },
    };

    const result = cloneSchemaMutable(schema) as JSONSchemaObj;

    // Different top-level reference.
    assert(result !== schema);
    // Content is equal.
    expect(result.type).toBe("object");
    expect((result.properties!.name as JSONSchemaObj).type).toBe("string");
    // Nested objects share references (shallow).
    assert(result.properties === schema.properties);
  });

  it("returns a deep copy when deep=true", () => {
    const inner: JSONSchemaObj = { type: "string" };
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { name: inner },
    };

    const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;

    // Different top-level reference.
    assert(result !== schema);
    // Content is equal.
    expect(result.type).toBe("object");
    expect((result.properties!.name as JSONSchemaObj).type).toBe("string");
    // Nested objects are also cloned (deep).
    assert(result.properties !== schema.properties);
  });

  it("result is deeply mutable when deep=true", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { x: { type: "number" } },
    };

    const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;
    assert(!Object.isFrozen(result));

    // Top-level mutation should work.
    (result as Record<string, unknown>).type = "array";
    expect(result.type).toBe("array");

    // Nested mutation should also work.
    assert(!Object.isFrozen(result.properties));
    const xProp = result.properties!.x as Record<string, unknown>;
    assert(!Object.isFrozen(xProp));
    xProp.type = "string";
    expect((result.properties!.x as JSONSchemaObj).type).toBe("string");
  });

  it("does not mutate the original", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { a: { type: "string" } },
    };

    const result = cloneSchemaMutable(schema) as Record<string, unknown>;
    result.type = "array";

    expect(schema.type).toBe("object");
  });

  it("deep clone of a frozen schema is fully mutable", () => {
    const schema = toDeepFrozenSchema({
      type: "object",
      properties: { y: { type: "number" } },
    } as JSONSchemaObj);

    const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;

    assert(!Object.isFrozen(result));
    expect(result.type).toBe("object");
    // Nested properties should also be mutable.
    expect(Object.isFrozen(result.properties)).toBe(false);
  });

  it("handles schema with arrays (anyOf) when deep=true", () => {
    const schema: JSONSchemaObj = {
      anyOf: [{ type: "string" }, { type: "number" }],
    };

    const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;

    assert(result !== schema);
    expect(result.anyOf!.length).toBe(2);
    assert(result.anyOf !== schema.anyOf);
  });

  it("handles empty object schema", () => {
    const schema: JSONSchemaObj = {};
    const result = cloneSchemaMutable(schema) as JSONSchemaObj;

    assert(result !== schema);
    expect(Object.keys(result).length).toBe(0);
  });
});

describe("schemaWithProperties", () => {
  it("returns a new object with overrides applied", () => {
    const schema: JSONSchemaObj = { type: "object", description: "old" };
    const result = schemaWithProperties(schema, {
      description: "new",
    }) as JSONSchemaObj;

    assert(result !== schema);
    expect(result.type).toBe("object");
    expect(result.description).toBe("new");
  });

  it("does not mutate the original", () => {
    const schema: JSONSchemaObj = { type: "string" };
    schemaWithProperties(schema, { type: "number" });

    expect(schema.type).toBe("string");
  });

  it("can set properties to undefined (key remains present)", () => {
    const schema = { type: "object", asStream: true } as JSONSchemaObj;
    const result = schemaWithProperties(schema, {
      asStream: undefined,
    }) as JSONSchemaObj;

    // The key must still exist on the result — `undefined` is a meaningful
    // value distinct from absence, which matters once schemas carry
    // FabricValue-typed fields.
    expect(result.asStream).toBe(undefined);
    assert("asStream" in result);
    expect(result.type).toBe("object");
  });

  it("can add new properties", () => {
    const schema: JSONSchemaObj = { type: "object" };
    const result = schemaWithProperties(schema, {
      $defs: { Foo: { type: "string" } },
    }) as JSONSchemaObj;

    expect(result.$defs!.Foo).toEqual({ type: "string" });
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

    expect(result.type).toBe("array");
    expect(result.required).toEqual(["a"]);
    expect((result.properties!.a as JSONSchemaObj).type).toBe("string");
  });

  it("returns a frozen result", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { x: { type: "number" } },
    };
    const result = schemaWithProperties(schema, {
      description: "hi",
    }) as JSONSchemaObj;

    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.properties));
  });

  it("distinguishes undefined-valued key from absent key", () => {
    // A schema with no `description` key at all.
    const schema: JSONSchemaObj = { type: "string" };
    assert(!("description" in schema));

    // Setting description to undefined: key is present but value is undefined.
    const withUndefined = schemaWithProperties(schema, {
      description: undefined,
    }) as JSONSchemaObj;
    assert("description" in withUndefined);
    expect(withUndefined.description).toBe(undefined);

    // Not mentioning description: key remains absent.
    const withoutOverride = schemaWithProperties(schema, {
      type: "number",
    }) as JSONSchemaObj;
    assert(!("description" in withoutOverride));
  });

  for (const truish of [true, undefined]) {
    describe(`for \`schema = ${truish}\``, () => {
      it("treats it as `{}` (any) and returns `overrides`", () => {
        const result = schemaWithProperties(truish, { type: "string" });
        expect(result).toEqual({ type: "string" });
      });

      it("returns an interned result", () => {
        const result = schemaWithProperties(truish, { type: "string" });
        assert(isInternedSchema(result));
      });

      it("does not freeze `overrides`", () => {
        const overrides: JSONSchemaObj = { type: "boolean" };
        schemaWithProperties(truish, overrides);
        assert(!Object.isFrozen(overrides));
      });
    });
  }

  describe("for `overrides = true`", () => {
    it("treats it as `{}` (any) and returns `schema`", () => {
      const result = schemaWithProperties({ type: "string" }, true);
      expect(result).toEqual({ type: "string" });
    });

    it("returns an interned result given an interned `schema`", () => {
      const schema = internSchema({ type: "string" });
      const result = schemaWithProperties(schema, true);
      assert(isInternedSchema(result));
    });

    it("returns an uninterned result given an uninterned `schema`", () => {
      const result = schemaWithProperties({ type: "string" }, true);
      assert(!isInternedSchema(result));
    });

    it("does not freeze a mutable `schema`", () => {
      const schema: JSONSchemaObj = { type: "boolean" };
      schemaWithProperties(schema, true);
      assert(!Object.isFrozen(schema));
    });
  });

  describe("for `schema = false\`", () => {
    for (const overrides of [false, true, { type: "string" } as JSONSchema]) {
      const label = (typeof overrides === "boolean")
        ? `\`overrides = ${overrides}\``
        : "`overrides` of type `object`";
      it(`returns \`false\` given ${label}`, () => {
        const result = schemaWithProperties(false, overrides);
        expect(result).toBe(false);
      });
    }
  });

  describe("for `overrides = false\`", () => {
    for (const schema of [false, true, { type: "string" } as JSONSchema]) {
      const label = (typeof schema === "boolean")
        ? `\`schema = ${schema}\``
        : "`schema` of type `object`";
      it(`returns \`false\` given ${label}`, () => {
        const result = schemaWithProperties(schema, false);
        expect(result).toBe(false);
      });
    }
  });

  describe("intern contagion of `object`s", () => {
    it("result is interned when base schema is interned", () => {
      const base = internSchema({ type: "object" });
      const result = schemaWithProperties(base, {
        properties: { x: { type: "string" } },
      });
      assert(isInternedSchema(result));
    });

    it("result is not interned when base schema is not interned", () => {
      const base: JSONSchemaObj = { type: "object" };
      const result = schemaWithProperties(base, {
        properties: { x: { type: "string" } },
      });
      assert(!isInternedSchema(result));
      // But it should still be frozen.
      assert(Object.isFrozen(result));
    });
  });
});

describe("schemaWithoutProperties", () => {
  it("removes a single named property", () => {
    const schema: JSONSchemaObj = { type: "object", asCell: true };
    const result = schemaWithoutProperties(schema, "asCell") as JSONSchemaObj;

    expect(result).toEqual({ type: "object" });
    assert(!("asCell" in result));
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

    expect(result).toEqual({ type: "object" });
    assert(!("asCell" in result));
    assert(!("asStream" in result));
  });

  it("returns a frozen result", () => {
    const schema: JSONSchemaObj = { type: "object", asCell: true };
    const result = schemaWithoutProperties(schema, "asCell");

    assert(Object.isFrozen(result));
  });

  it("does not mutate the original", () => {
    const schema: JSONSchemaObj = { type: "object", asCell: true };
    schemaWithoutProperties(schema, "asCell");

    expect(schema.asCell).toBe(true);
  });

  it("is a no-op (deep-frozen clone) when the named property is absent from a mutable schema", () => {
    const schema: JSONSchemaObj = { not: { type: "string" } };
    const result = schemaWithoutProperties(schema, "asCell");

    expect(result).toEqual(schema);
    assert(Object.isFrozen(result));
    assert(Object.isFrozen((result as JSONSchemaObj).not));
  });

  it("is a true no-op when the named property is absent from a deep-frozen schema", () => {
    const schema = toDeepFrozenSchema(
      { type: "string" } as JSONSchemaObj,
      true,
    );
    const result = schemaWithoutProperties(schema, "asCell");

    expect(result).toBe(schema);
  });

  it("treats undefined as true (accept everything)", () => {
    expect(schemaWithoutProperties(undefined, "asCell")).toBe(true);
  });

  it("returns boolean true as-is", () => {
    expect(schemaWithoutProperties(true, "asCell")).toBe(true);
  });

  it("returns boolean false as-is", () => {
    expect(schemaWithoutProperties(false, "asCell")).toBe(false);
  });

  describe("intern contagion", () => {
    it("result is interned when input schema is interned", () => {
      const schema = internSchema({ type: "object", asCell: true });
      const result = schemaWithoutProperties(schema, "asCell");
      assert(isInternedSchema(result));
    });

    it("result is not interned when input schema is not interned", () => {
      const schema: JSONSchemaObj = { type: "object", asCell: true };
      const result = schemaWithoutProperties(schema, "asCell");
      assert(!isInternedSchema(result));
      // But it should still be frozen.
      assert(Object.isFrozen(result));
    });

    it("no-op on interned schema preserves interned identity", () => {
      const schema = internSchema({ type: "string" });
      const result = schemaWithoutProperties(schema, "nonexistent");
      expect(result).toBe(schema);
      assert(isInternedSchema(result));
    });
  });
});

describe("schemaForValueType", () => {
  function testType(
    typeName: JSONSchemaTypes,
    example: FabricValue,
  ) {
    describe(typeName, () => {
      it(`should return { type: "${typeName}" }`, () => {
        expect(schemaForValueType(example)).toEqual({ type: typeName });
      });

      it("should return a frozen result", () => {
        assert(isDeepFrozen(schemaForValueType(example)!));
      });

      it("should return an interned result", () => {
        assert(isInternedSchema(schemaForValueType(example)!));
      });

      it("should return the same result every time", () => {
        expect(schemaForValueType(example)).toBe(schemaForValueType(example));
      });
    });
  }

  testType("string", "hello");
  testType("integer", 42);
  testType("number", 3.14);
  testType("boolean", true);
  testType("null", null);
  testType("array", [1, 2, 3]);
  testType("object", { a: 1 });

  describe("undefined", () => {
    it("should return undefined", () => {
      expect(schemaForValueType(undefined)).toBe(undefined);
    });
  });

  describe("bigint", () => {
    it("should return undefined", () => {
      expect(schemaForValueType(BigInt(42))).toBe(undefined);
    });
  });

  describe("symbol", () => {
    it("should return undefined", () => {
      expect(schemaForValueType(Symbol("test"))).toBe(undefined);
    });
  });
});

describe("emptySchemaObject", () => {
  it("should return {}", () => {
    expect(emptySchemaObject()).toEqual({});
  });

  it("should return the same object every time", () => {
    expect(emptySchemaObject()).toBe(emptySchemaObject());
  });

  it("should return an interned result", () => {
    assert(isInternedSchema(emptySchemaObject()));
  });

  it("should return a frozen result", () => {
    assert(isDeepFrozen(emptySchemaObject()));
  });
});

describe("internSchemaPairAsKey()", () => {
  it("composes the two interned `hashString`s with `|`", () => {
    const a: JSONSchema = { type: "number" };
    const b: JSONSchema = { type: "string" };
    const aHash = internSchema(a, true).hashString;
    const bHash = internSchema(b, true).hashString;
    expect(internSchemaPairAsKey(a, b)).toBe(`${aHash}|${bHash}`);
  });

  it("handles boolean schemas on either side", () => {
    const obj: JSONSchema = { type: "number" };
    const objHash = internSchema(obj, true).hashString;
    const trueHash = internSchema(true, true).hashString;
    const falseHash = internSchema(false, true).hashString;
    expect(internSchemaPairAsKey(true, obj)).toBe(`${trueHash}|${objHash}`);
    expect(internSchemaPairAsKey(obj, false)).toBe(`${objHash}|${falseHash}`);
    expect(internSchemaPairAsKey(true, false)).toBe(
      `${trueHash}|${falseHash}`,
    );
  });

  it("is order-sensitive", () => {
    const a: JSONSchema = { type: "number" };
    const b: JSONSchema = { type: "string" };
    expect(internSchemaPairAsKey(a, b)).not.toEqual(
      internSchemaPairAsKey(b, a),
    );
  });

  it("matches for structurally-equal inputs", () => {
    const a1: JSONSchema = {
      type: "object",
      properties: { x: { type: "string" } },
    };
    const a2: JSONSchema = {
      type: "object",
      properties: { x: { type: "string" } },
    };
    const b1: JSONSchema = { type: "array", items: { type: "number" } };
    const b2: JSONSchema = { type: "array", items: { type: "number" } };
    expect(internSchemaPairAsKey(a1, b1)).toBe(internSchemaPairAsKey(a2, b2));
  });

  it("interns both inputs as a side effect", () => {
    // Content-unique keys guarantee no prior interning has seen
    // these exact schemas, so `isInternedSchema` reflects what
    // THIS call did.
    const stamp = `${Date.now()}-${Math.random()}`;
    const a: JSONSchemaObj = {
      type: "number",
      title: `schemaHashTestAt${stamp}-a`,
    };
    const b: JSONSchemaObj = {
      type: "string",
      title: `schemaHashTestAt${stamp}-b`,
    };
    expect(isInternedSchema(a)).toBe(false);
    expect(isInternedSchema(b)).toBe(false);
    internSchemaPairAsKey(a, b);
    expect(isInternedSchema(a)).toBe(true);
    expect(isInternedSchema(b)).toBe(true);
    assert(isDeepFrozen(a));
    assert(isDeepFrozen(b));
  });
});

describe("internPathSelector", () => {
  // Content-unique markers guarantee no prior interning has seen these
  // schemas — avoids the flake shape Dan flagged on PR #3335.
  const uniqueSchema = (): JSONSchema => ({
    type: "object",
    title: `internPathSelectorTestAt${Date.now()}-${Math.random()}`,
  });

  it("freezes `selector.path` and `selector` in place", () => {
    const selector: SchemaPathSelector = {
      path: ["a", "b"],
      schema: uniqueSchema(),
    };
    expect(Object.isFrozen(selector)).toBe(false);
    expect(Object.isFrozen(selector.path)).toBe(false);
    internPathSelector(selector);
    expect(Object.isFrozen(selector)).toBe(true);
    expect(Object.isFrozen(selector.path)).toBe(true);
  });

  it("interns `selector.schema` when it is an object", () => {
    const schema = uniqueSchema();
    const selector: SchemaPathSelector = { path: ["x"], schema };
    expect(isInternedSchema(schema)).toBe(false);
    internPathSelector(selector);
    expect(isInternedSchema(schema)).toBe(true);
    assert(isDeepFrozen(schema));
  });

  it("handles selectors whose `schema` is undefined", () => {
    const selector: SchemaPathSelector = { path: ["p"] };
    // Must not throw — `internSchema(undefined)` would, and the guard
    // `if (selector.schema !== undefined)` prevents it.
    internPathSelector(selector);
    expect(Object.isFrozen(selector)).toBe(true);
    expect(Object.isFrozen(selector.path)).toBe(true);
  });

  it("handles boolean `selector.schema` (true and false)", () => {
    const trueSelector: SchemaPathSelector = { path: ["t"], schema: true };
    const falseSelector: SchemaPathSelector = { path: ["f"], schema: false };
    internPathSelector(trueSelector);
    internPathSelector(falseSelector);
    expect(Object.isFrozen(trueSelector)).toBe(true);
    expect(Object.isFrozen(falseSelector)).toBe(true);
    expect(isInternedSchema(true)).toBe(true);
    expect(isInternedSchema(false)).toBe(true);
  });

  it("returns its input reference (does not clone)", () => {
    const selector: SchemaPathSelector = {
      path: ["x"],
      schema: uniqueSchema(),
    };
    const result = internPathSelector(selector);
    expect(result).toBe(selector);
  });

  it("is idempotent: `internPathSelector(x) === internPathSelector(x)`", () => {
    const selector: SchemaPathSelector = {
      path: ["x"],
      schema: uniqueSchema(),
    };
    const first = internPathSelector(selector);
    const second = internPathSelector(selector);
    expect(first).toBe(second);
    expect(first).toBe(selector);
  });
});
