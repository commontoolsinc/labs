import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  FabricValue,
  JSONSchema,
  JSONSchemaObj,
  JSONSchemaTypes,
  SchemaPathSelector,
} from "@commonfabric/api";

import { deepFreeze, isDeepFrozen } from "@/deep-freeze.ts";
import {
  cloneSchemaMutable,
  emptySchemaObject,
  factorySchemasEqual,
  internPathSelector,
  internSchemaPairAsKey,
  isNontrivialSchema,
  schemaForValueType,
  schemaWithoutProperties,
  schemaWithProperties,
  toDeepFrozenSchema,
} from "@/schema-utils.ts";
import { internSchema, isInternedSchema } from "@/schema-hash.ts";

describe("schema-utils", () => {
  describe("toDeepFrozenSchema()", () => {
    for (const prim of [false, true, undefined]) {
      describe(`on primitive \`${prim}\``, () => {
        it("returns the value as-is given both values of `canShare`", () => {
          const result1 = toDeepFrozenSchema(prim, false);
          const result2 = toDeepFrozenSchema(prim, true);
          expect(result1).toBe(prim);
          expect(result2).toBe(prim);
        });
      });
    }

    describe("`canShare=true`", () => {
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
        expect(result).toBe(schema);
        expect(Object.isFrozen(schema)).toBe(true);

        // Property values are frozen in place — same references, now frozen.
        expect(Object.isFrozen(schema.properties)).toBe(true);
        expect(schema.properties).toBe(originalProperties);
        expect(Object.isFrozen(schema.properties!.name)).toBe(true);
      });

      it("freezes an unfrozen schema in place (same reference)", () => {
        const schema: JSONSchemaObj = {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        };

        const result = toDeepFrozenSchema(schema, true);

        // Same reference — frozen in place, not cloned.
        expect(result).toBe(schema);
        expect(Object.isFrozen(result)).toBe(true);
      });
    });

    describe("`canShare=false`", () => {
      it("clones before freezing", () => {
        const schema: JSONSchemaObj = {
          type: "object",
          properties: {
            age: { type: "integer" },
          },
        };

        const result = toDeepFrozenSchema(schema, false);

        // Should NOT be the same reference.
        expect(result).not.toBe(schema);

        // Original should NOT be frozen.
        expect(Object.isFrozen(schema)).toBe(false);

        // Result should be deeply frozen.
        expect(Object.isFrozen(result)).toBe(true);
        const obj = result as JSONSchemaObj;
        expect(Object.isFrozen(obj.properties)).toBe(true);
        expect(Object.isFrozen(obj.properties!.age)).toBe(true);
      });

      it("preserves original schema", () => {
        const inner: JSONSchemaObj = { type: "string" };
        const schema: JSONSchemaObj = {
          type: "object",
          properties: { name: inner },
        };

        toDeepFrozenSchema(schema, false);

        // Original should still be mutable.
        expect(Object.isFrozen(schema)).toBe(false);
        expect(Object.isFrozen(inner)).toBe(false);

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
        expect(Object.isFrozen(innerProp)).toBe(false);
      });
    });

    describe("deeply nested schemas", () => {
      it("freezes deeply nested schemas", () => {
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

        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.properties)).toBe(true);

        const address = result.properties!.address as JSONSchemaObj;
        expect(Object.isFrozen(address)).toBe(true);
        expect(Object.isFrozen(address.properties)).toBe(true);
        expect(Object.isFrozen(address.required)).toBe(true);
        expect(Object.isFrozen(address.properties!.street)).toBe(true);
      });

      it("freezes a schema with arrays", () => {
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

        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.required)).toBe(true);

        const tags = result.properties!.tags as JSONSchemaObj;
        expect(Object.isFrozen(tags)).toBe(true);
        expect(Object.isFrozen(tags.items)).toBe(true);
      });

      it("freezes anyOf schemas", () => {
        const schema: JSONSchemaObj = {
          anyOf: [
            { type: "string" },
            { type: "number" },
          ],
        };

        const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.anyOf)).toBe(true);
        expect(Object.isFrozen(result.anyOf![0])).toBe(true);
        expect(Object.isFrozen(result.anyOf![1])).toBe(true);
      });

      it("freezes enum values", () => {
        const schema: JSONSchemaObj = {
          type: "string",
          enum: ["a", "b", "c"],
        };

        const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;
        expect(Object.isFrozen(result.enum)).toBe(true);
      });
    });

    describe("immutability enforcement", () => {
      it("rejects mutation of a frozen schema", () => {
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

      it("returns an interned schema as-is even with `canShare=false`", () => {
        const schema = internSchema({
          type: "object",
          properties: { x: { type: "number" } },
        });
        const result = toDeepFrozenSchema(schema, false);
        expect(result).toBe(schema);
      });
    });

    describe("already-frozen input handling", () => {
      it("handles an already-frozen schema", () => {
        const schema: JSONSchemaObj = Object.freeze({
          type: "string" as const,
        });
        const result = toDeepFrozenSchema(schema, true);
        expect(result).toBe(schema);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("returns the same reference when already deep-frozen (`canShare=true`)", () => {
        const schema: JSONSchemaObj = deepFreeze({
          type: "object",
          properties: { name: { type: "string" } },
        });

        const result = toDeepFrozenSchema(schema, true);
        expect(result).toBe(schema);
      });

      it("returns the same reference when already deep-frozen (`canShare=false`)", () => {
        const schema: JSONSchemaObj = deepFreeze({
          type: "object",
          properties: { age: { type: "number" } },
        });

        const result = toDeepFrozenSchema(schema, false);
        expect(result).toBe(schema);
      });

      it("deep-freezes a frozen-but-not-deep schema in place (`canShare=true`)", () => {
        const inner = { type: "string" } as JSONSchemaObj;
        const schema: JSONSchemaObj = Object.freeze({
          type: "object",
          properties: Object.freeze({ name: inner }),
        } as JSONSchemaObj);
        // schema is frozen, but inner is not — so not deep-frozen.

        const result = toDeepFrozenSchema(schema, true);

        // Same reference — `canShare=true` lets us complete the deep-freeze in
        // place rather than cloning.
        expect(result).toBe(schema);

        // Result (and the previously-unfrozen `inner`) must now be deeply frozen.
        expect(Object.isFrozen(result)).toBe(true);
        const obj = result as JSONSchemaObj;
        expect(Object.isFrozen(obj.properties)).toBe(true);
        expect(Object.isFrozen(inner)).toBe(true);
      });
    });

    describe("subtree reuse", () => {
      it("reuses already-deep-frozen subtrees, freezes the rest in place (`canShare=true`)", () => {
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

        // The already-deep-frozen "properties" subtree is reused by reference.
        expect(result.properties).toBe(frozenProperties);

        // The unfrozen "required" is frozen in place (same reference, now frozen)
        // rather than cloned, since `canShare=true`.
        expect(result.required).toBe(unfrozenRequired);

        // Both are deeply frozen in the result.
        expect(Object.isFrozen(result.properties)).toBe(true);
        expect(Object.isFrozen(result.required)).toBe(true);
      });
    });
  });

  describe("isNontrivialSchema()", () => {
    describe("nullish inputs", () => {
      it("returns `false` for `undefined`", () => {
        expect(isNontrivialSchema(undefined)).toBe(false);
      });

      it("returns `false` for `null`", () => {
        expect(isNontrivialSchema(null)).toBe(false);
      });
    });

    describe("boolean schemas", () => {
      it("returns `false` for `true`", () => {
        expect(isNontrivialSchema(true)).toBe(false);
      });

      it("returns `false` for `false`", () => {
        expect(isNontrivialSchema(false)).toBe(false);
      });
    });

    describe("empty object schema", () => {
      it("returns `false` for `{}`", () => {
        expect(isNontrivialSchema({})).toBe(false);
      });
    });

    describe("non-trivial schemas", () => {
      it("returns `true` for a schema with `type`", () => {
        expect(isNontrivialSchema({ type: "string" })).toBe(true);
      });

      it("returns `true` for a schema with `properties`", () => {
        const schema: JSONSchemaObj = {
          type: "object",
          properties: { name: { type: "string" } },
        };
        expect(isNontrivialSchema(schema)).toBe(true);
      });

      it("returns `true` for a schema with only `$ref`", () => {
        expect(isNontrivialSchema({ $ref: "#/definitions/Foo" })).toBe(true);
      });

      it("returns `true` for a schema with `anyOf`", () => {
        expect(
          isNontrivialSchema({
            anyOf: [{ type: "string" }, { type: "number" }],
          }),
        ).toBe(true);
      });

      it("returns `true` for a frozen non-empty schema", () => {
        const schema = Object.freeze({ type: "number" as const });
        expect(isNontrivialSchema(schema)).toBe(true);
      });

      it("returns `true` for a deep-frozen schema", () => {
        const schema: JSONSchemaObj = deepFreeze({
          type: "object",
          properties: { x: { type: "number" } },
        });
        expect(isNontrivialSchema(schema)).toBe(true);
      });
    });

    describe("type narrowing", () => {
      it("narrows to `JSONSchemaObj` (allows property access)", () => {
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

  describe("cloneSchemaMutable()", () => {
    it("returns `{}` for boolean `true`", () => {
      expect(cloneSchemaMutable(true)).toEqual({});
    });

    it("returns `{ not: true }` for boolean `false`", () => {
      expect(cloneSchemaMutable(false)).toEqual({ not: true });
    });

    it("returns `{}` for `undefined`", () => {
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
      expect(result).not.toBe(schema);
      // Content is equal.
      expect(result.type).toBe("object");
      expect((result.properties!.name as JSONSchemaObj).type).toBe("string");
      // Nested objects share references (shallow).
      expect(result.properties).toBe(schema.properties);
    });

    it("returns a deep copy when `deep=true`", () => {
      const inner: JSONSchemaObj = { type: "string" };
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: inner },
      };

      const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;

      // Different top-level reference.
      expect(result).not.toBe(schema);
      // Content is equal.
      expect(result.type).toBe("object");
      expect((result.properties!.name as JSONSchemaObj).type).toBe("string");
      // Nested objects are also cloned (deep).
      expect(result.properties).not.toBe(schema.properties);
    });

    it("produces a deeply mutable result when `deep=true`", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: { type: "number" } },
      };

      const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;
      expect(Object.isFrozen(result)).toBe(false);

      // Top-level mutation should work.
      (result as Record<string, unknown>).type = "array";
      expect(result.type).toBe("array");

      // Nested mutation should also work.
      expect(Object.isFrozen(result.properties)).toBe(false);
      const xProp = result.properties!.x as Record<string, unknown>;
      expect(Object.isFrozen(xProp)).toBe(false);
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

    it("produces a fully mutable deep clone of a frozen schema", () => {
      const schema = toDeepFrozenSchema({
        type: "object",
        properties: { y: { type: "number" } },
      } as JSONSchemaObj);

      const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;

      expect(Object.isFrozen(result)).toBe(false);
      expect(result.type).toBe("object");
      // Nested properties should also be mutable.
      expect(Object.isFrozen(result.properties)).toBe(false);
    });

    it("handles schema with arrays (`anyOf`) when `deep=true`", () => {
      const schema: JSONSchemaObj = {
        anyOf: [{ type: "string" }, { type: "number" }],
      };

      const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;

      expect(result).not.toBe(schema);
      expect(result.anyOf!.length).toBe(2);
      expect(result.anyOf).not.toBe(schema.anyOf);
    });

    it("handles empty object schema", () => {
      const schema: JSONSchemaObj = {};
      const result = cloneSchemaMutable(schema) as JSONSchemaObj;

      expect(result).not.toBe(schema);
      expect(Object.keys(result).length).toBe(0);
    });
  });

  describe("schemaWithProperties()", () => {
    it("returns a new object with overrides applied", () => {
      const schema: JSONSchemaObj = { type: "object", description: "old" };
      const result = schemaWithProperties(schema, {
        description: "new",
      }) as JSONSchemaObj;

      expect(result).not.toBe(schema);
      expect(result.type).toBe("object");
      expect(result.description).toBe("new");
    });

    it("does not mutate the original", () => {
      const schema: JSONSchemaObj = { type: "string" };
      schemaWithProperties(schema, { type: "number" });

      expect(schema.type).toBe("string");
    });

    it("can set properties to undefined (key remains present)", () => {
      const schema = { type: "object", asCell: ["stream"] } as JSONSchemaObj;
      const result = schemaWithProperties(schema, {
        default: undefined,
      }) as JSONSchemaObj;

      // The key must still exist on the result — `undefined` is a meaningful
      // value distinct from absence, which matters once schemas carry
      // FabricValue-typed fields.
      expect(result.default).toBe(undefined);
      expect("default" in result).toBe(true);
      expect(result.asCell).toEqual(["stream"]);
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

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.properties)).toBe(true);
    });

    it("distinguishes `undefined`-valued key from absent key", () => {
      // A schema with no `description` key at all.
      const schema: JSONSchemaObj = { type: "string" };
      expect("description" in schema).toBe(false);

      // Setting description to undefined: key is present but value is undefined.
      const withUndefined = schemaWithProperties(schema, {
        description: undefined,
      }) as JSONSchemaObj;
      expect("description" in withUndefined).toBe(true);
      expect(withUndefined.description).toBe(undefined);

      // Not mentioning description: key remains absent.
      const withoutOverride = schemaWithProperties(schema, {
        type: "number",
      }) as JSONSchemaObj;
      expect("description" in withoutOverride).toBe(false);
    });

    for (const truish of [true, undefined]) {
      describe(`for \`schema = ${truish}\``, () => {
        it("treats it as `{}` (any) and returns `overrides`", () => {
          const result = schemaWithProperties(truish, { type: "string" });
          expect(result).toEqual({ type: "string" });
        });

        it("returns an interned result", () => {
          const result = schemaWithProperties(truish, { type: "string" });
          expect(isInternedSchema(result)).toBe(true);
        });

        it("does not freeze `overrides`", () => {
          const overrides: JSONSchemaObj = { type: "boolean" };
          schemaWithProperties(truish, overrides);
          expect(Object.isFrozen(overrides)).toBe(false);
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
        expect(isInternedSchema(result)).toBe(true);
      });

      it("returns an uninterned result given an uninterned `schema`", () => {
        const result = schemaWithProperties({ type: "string" }, true);
        expect(isInternedSchema(result)).toBe(false);
      });

      it("does not freeze a mutable `schema`", () => {
        const schema: JSONSchemaObj = { type: "boolean" };
        schemaWithProperties(schema, true);
        expect(Object.isFrozen(schema)).toBe(false);
      });
    });

    describe("for `schema = false`", () => {
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

    describe("for `overrides = false`", () => {
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
      it("interns the result when the base schema is interned", () => {
        const base = internSchema({ type: "object" });
        const result = schemaWithProperties(base, {
          properties: { x: { type: "string" } },
        });
        expect(isInternedSchema(result)).toBe(true);
      });

      it("leaves the result uninterned when the base schema is not interned", () => {
        const base: JSONSchemaObj = { type: "object" };
        const result = schemaWithProperties(base, {
          properties: { x: { type: "string" } },
        });
        expect(isInternedSchema(result)).toBe(false);
        // But it should still be frozen.
        expect(Object.isFrozen(result)).toBe(true);
      });
    });
  });

  describe("schemaWithoutProperties()", () => {
    it("removes a single named property", () => {
      const schema: JSONSchemaObj = { type: "object", asCell: ["cell"] };
      const result = schemaWithoutProperties(schema, "asCell") as JSONSchemaObj;

      expect(result).toEqual({ type: "object" });
      expect("asCell" in result).toBe(false);
    });

    it("removes multiple named properties", () => {
      const schema = {
        type: "object",
        asCell: ["cell"],
        default: {},
      } as JSONSchemaObj;
      const result = schemaWithoutProperties(
        schema,
        "asCell",
        "default",
      ) as JSONSchemaObj;

      expect(result).toEqual({ type: "object" });
      expect("asCell" in result).toBe(false);
      expect("default" in result).toBe(false);
    });

    it("returns a frozen result", () => {
      const schema: JSONSchemaObj = { type: "object", asCell: ["cell"] };
      const result = schemaWithoutProperties(schema, "asCell");

      expect(Object.isFrozen(result)).toBe(true);
    });

    it("does not mutate the original", () => {
      const schema: JSONSchemaObj = { type: "object", asCell: ["cell"] };
      schemaWithoutProperties(schema, "asCell");

      expect(schema.asCell).toEqual(["cell"]);
    });

    it("is a no-op (deep-frozen clone) when the named property is absent from a mutable schema", () => {
      const schema: JSONSchemaObj = { not: { type: "string" } };
      const result = schemaWithoutProperties(schema, "asCell");

      expect(result).toEqual(schema);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen((result as JSONSchemaObj).not)).toBe(true);
    });

    it("is a true no-op when the named property is absent from a deep-frozen schema", () => {
      const schema = toDeepFrozenSchema(
        { type: "string" } as JSONSchemaObj,
        true,
      );
      const result = schemaWithoutProperties(schema, "asCell");

      expect(result).toBe(schema);
    });

    it("treats `undefined` as `true` (accept everything)", () => {
      expect(schemaWithoutProperties(undefined, "asCell")).toBe(true);
    });

    it("returns boolean `true` as-is", () => {
      expect(schemaWithoutProperties(true, "asCell")).toBe(true);
    });

    it("returns boolean `false` as-is", () => {
      expect(schemaWithoutProperties(false, "asCell")).toBe(false);
    });

    describe("intern contagion", () => {
      it("interns the result when the input schema is interned", () => {
        const schema = internSchema({ type: "object", asCell: ["cell"] });
        const result = schemaWithoutProperties(schema, "asCell");
        expect(isInternedSchema(result)).toBe(true);
      });

      it("leaves the result uninterned when the input schema is not interned", () => {
        const schema: JSONSchemaObj = { type: "object", asCell: ["cell"] };
        const result = schemaWithoutProperties(schema, "asCell");
        expect(isInternedSchema(result)).toBe(false);
        // But it should still be frozen.
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("preserves interned identity on a no-op over an interned schema", () => {
        const schema = internSchema({ type: "string" });
        const result = schemaWithoutProperties(schema, "nonexistent");
        expect(result).toBe(schema);
        expect(isInternedSchema(result)).toBe(true);
      });
    });
  });

  describe("schemaForValueType()", () => {
    function testType(
      typeName: JSONSchemaTypes,
      example: FabricValue,
    ) {
      describe(typeName, () => {
        it(`returns { type: "${typeName}" }`, () => {
          expect(schemaForValueType(example)).toEqual({ type: typeName });
        });

        it("returns a frozen result", () => {
          expect(isDeepFrozen(schemaForValueType(example)!)).toBe(true);
        });

        it("returns an interned result", () => {
          expect(isInternedSchema(schemaForValueType(example)!)).toBe(true);
        });

        it("returns the same result every time", () => {
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

    describe("`undefined`", () => {
      it("returns `undefined`", () => {
        expect(schemaForValueType(undefined)).toBe(undefined);
      });
    });

    describe("`bigint`", () => {
      it("returns `undefined`", () => {
        expect(schemaForValueType(BigInt(42))).toBe(undefined);
      });
    });

    describe("symbol", () => {
      it("returns undefined", () => {
        expect(schemaForValueType(Symbol("test"))).toBe(undefined);
      });
    });
  });

  describe("emptySchemaObject", () => {
    it("returns {}", () => {
      expect(emptySchemaObject()).toEqual({});
    });

    it("returns the same object every time", () => {
      expect(emptySchemaObject()).toBe(emptySchemaObject());
    });

    it("returns an interned result", () => {
      expect(isInternedSchema(emptySchemaObject())).toBe(true);
    });

    it("returns a frozen result", () => {
      expect(isDeepFrozen(emptySchemaObject())).toBe(true);
    });
  });

  describe("internSchemaPairAsKey()", () => {
    it("composes the two interned `.taggedHashString`s with `|`", () => {
      const a: JSONSchema = { type: "number" };
      const b: JSONSchema = { type: "string" };
      const aHash = internSchema(a, true).taggedHashString;
      const bHash = internSchema(b, true).taggedHashString;
      expect(internSchemaPairAsKey(a, b)).toBe(`${aHash}|${bHash}`);
    });

    it("handles boolean schemas on either side", () => {
      const obj: JSONSchema = { type: "number" };
      const objHash = internSchema(obj, true).taggedHashString;
      const trueHash = internSchema(true, true).taggedHashString;
      const falseHash = internSchema(false, true).taggedHashString;
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
      expect(isDeepFrozen(a)).toBe(true);
      expect(isDeepFrozen(b)).toBe(true);
    });
  });

  describe("internPathSelector()", () => {
    // Content-unique markers guarantee no prior interning has seen these
    // schemas — avoids the flake shape Dan flagged on PR #3335.
    const uniqueSchema = (): JSONSchemaObj => ({
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
      expect(isDeepFrozen(schema)).toBe(true);
    });

    it("canonicalizes `selector.schema` to the interned instance", () => {
      const title = `internPathSelectorCanonAt${Date.now()}-${Math.random()}`;
      // Establish the canonical interned instance from one distinct object...
      const canonical = internSchema({ type: "object", title });
      // ...then intern a selector holding a structurally-equal but distinct
      // schema object. After interning, `selector.schema` should be the shared
      // canonical instance, not the (now-redundant) input object.
      const selector: SchemaPathSelector = {
        path: ["x"],
        schema: { type: "object", title },
      };
      expect(selector.schema).not.toBe(canonical);
      internPathSelector(selector);
      expect(selector.schema).toBe(canonical);
    });

    it("returns a new selector when a frozen input's schema must be canonicalized", () => {
      const title = `internPathSelectorFrozenAt${Date.now()}-${Math.random()}`;
      // Establish the canonical interned instance from one distinct object...
      const canonical = internSchema({ type: "object", title });
      // ...then build a *frozen* selector holding a structurally-equal but
      // distinct (non-canonical) schema object. Since the input is frozen, its
      // schema can't be replaced in place, so interning must allocate and
      // return a new selector carrying the canonical schema.
      const selector = Object.freeze({
        path: Object.freeze(["x"]),
        schema: Object.freeze({ type: "object", title }),
      }) as SchemaPathSelector;
      expect(selector.schema).not.toBe(canonical);
      const result = internPathSelector(selector);
      expect(result).not.toBe(selector);
      expect(result.schema).toBe(canonical);
      expect(result.path).toEqual(["x"]);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("returns the input reference when `selector.schema` is already interned", () => {
      const title =
        `internPathSelectorPreInternedAt${Date.now()}-${Math.random()}`;
      const interned = internSchema({ type: "object", title });
      expect(isInternedSchema(interned)).toBe(true);
      // Even a frozen selector is returned as-is when its schema is already the
      // canonical interned instance: there is nothing to replace, so no clone.
      const selector = Object.freeze({
        path: Object.freeze(["x"]),
        schema: interned,
      }) as SchemaPathSelector;
      const result = internPathSelector(selector);
      expect(result).toBe(selector);
      expect(result.schema).toBe(interned);
    });

    it("interns a selector with an empty path", () => {
      const schema = uniqueSchema();
      const selector: SchemaPathSelector = { path: [], schema };
      const result = internPathSelector(selector);

      expect(result.path).toEqual([]);
      expect(Object.isFrozen(result.path)).toBe(true);
      expect(isInternedSchema(result.schema as JSONSchemaObj)).toBe(true);
    });

    it("keeps an empty path distinct from a non-empty one", () => {
      const schema = uniqueSchema();
      const empty = internPathSelector({ path: [], schema });
      const nonEmpty = internPathSelector({ path: ["a"], schema });

      expect(empty).not.toBe(nonEmpty);
      expect(empty.path).toEqual([]);
      expect(nonEmpty.path).toEqual(["a"]);
    });

    it("canonicalizes to one instance when a frozen path array is reused", () => {
      const schema = uniqueSchema();
      const first = internPathSelector({ path: ["a", "b"], schema });

      // Interning froze the path in place, so the same array identity can be
      // handed back in a fresh selector -- the repeat case the path-key cache
      // exists for. The cache is only populated once the path is frozen, so
      // it takes a third pass to serve one; all three must agree.
      const second = internPathSelector({
        path: first.path,
        schema: first.schema,
      });
      const third = internPathSelector({
        path: first.path,
        schema: first.schema,
      });

      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it("keeps paths distinct when a component contains the separator", () => {
      const schema = uniqueSchema();
      const a = internPathSelector({ path: ["a:b"], schema });
      const b = internPathSelector({ path: ["a", "b"], schema });

      expect(a).not.toBe(b);
    });

    it("keeps live entries when the path cache sweeps", () => {
      // The per-schema path map sweeps collected entries once it passes its
      // threshold (2048). Holding every returned selector alive means the
      // sweep runs with nothing to collect, which is the case that must not
      // lose canonical instances: dropping a live entry would silently break
      // canonicalization for that path.
      const schema = uniqueSchema();
      const held: SchemaPathSelector[] = [];
      for (let i = 0; i <= 2048; i++) {
        held.push(internPathSelector({ path: [`p${i}`], schema }));
      }

      // Every path still canonicalizes to the instance interned for it.
      expect(internPathSelector({ path: ["p0"], schema })).toBe(held[0]);
      expect(internPathSelector({ path: ["p2048"], schema })).toBe(held[2048]);
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

    it("canonicalizes two distinct equal selectors (object schema) to one instance", () => {
      const schema = uniqueSchema();
      const a = internPathSelector({ path: ["x"], schema });
      // A *distinct* selector object carrying a structurally-equal (but
      // separate) schema object must resolve to the very same canonical
      // instance — not merely the same-object idempotency the test above checks.
      const b = internPathSelector({ path: ["x"], schema: { ...schema } });
      expect(b).toBe(a);
    });

    it("canonicalizes two distinct equal selectors with primitive/absent schemas", () => {
      // Exercises the primitive-schema map (booleans and the `undefined`
      // "schema") rather than the object `WeakMap`. Fresh unique paths keep
      // prior interning in this process from pre-populating the cache.
      const base = `prim-${Date.now()}-${Math.random()}`;
      for (const schema of [undefined, true, false] as const) {
        const path = [`${base}-${String(schema)}`];
        const a = internPathSelector({ path: [...path], schema });
        const b = internPathSelector({ path: [...path], schema });
        expect(b).toBe(a);
      }
    });

    it("keeps the same path distinct across schema kinds", () => {
      // Same path, schema ∈ {undefined, true, false, object}. Each kind must
      // get its own canonical instance: this guards routing between the object
      // `WeakMap` and the primitive `Map`, plus the per-key separation of
      // `undefined`/`true`/`false` within the primitive map.
      const path = [`kinds-${Date.now()}-${Math.random()}`];
      const results = [
        internPathSelector({ path: [...path] }),
        internPathSelector({ path: [...path], schema: true }),
        internPathSelector({ path: [...path], schema: false }),
        internPathSelector({ path: [...path], schema: uniqueSchema() }),
      ];
      expect(new Set(results).size).toBe(4);
    });

    it("does not conflate paths that share a naive concatenation", () => {
      // Same canonical schema, so path is the only discriminator. A separator
      // join would collide `["a","b"]` with `["a.b"]`; the length-prefixed key
      // keeps all three apart.
      const schema = internSchema(uniqueSchema());
      const s1 = internPathSelector({ path: ["a", "b"], schema });
      const s2 = internPathSelector({ path: ["ab"], schema });
      const s3 = internPathSelector({ path: ["a.b"], schema });
      expect(s1).not.toBe(s2);
      expect(s1).not.toBe(s3);
      expect(s2).not.toBe(s3);
    });

    it("freezes and canonicalizes a mutable input in place even on a cache hit", () => {
      const schema = uniqueSchema();
      const canonical = internPathSelector({ path: ["x"], schema });
      // A distinct, still-mutable selector with equal content. The canonical
      // already exists, so the return value is that canonical (not this input) —
      // but per the pre-cache contract, the input is nonetheless frozen and its
      // schema canonicalized in place, for callers that keep using their object.
      const dup: SchemaPathSelector = { path: ["x"], schema: { ...schema } };
      expect(Object.isFrozen(dup)).toBe(false);
      const result = internPathSelector(dup);
      expect(result).toBe(canonical);
      expect(result).not.toBe(dup);
      expect(Object.isFrozen(dup)).toBe(true);
      expect(Object.isFrozen(dup.path)).toBe(true);
      expect(dup.schema).toBe(canonical.schema);
    });
  });

  describe("factorySchemasEqual()", () => {
    it("compares exact normalized structure deterministically", () => {
      expect(factorySchemasEqual(
        {
          required: ["value"],
          properties: { value: { type: "number" } },
          type: "object",
        },
        {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      )).toBe(true);
      expect(factorySchemasEqual(
        { type: "object", required: ["left", "right"] },
        { type: "object", required: ["right", "left"] },
      )).toBe(false);
      expect(factorySchemasEqual(undefined, undefined)).toBe(true);
      expect(factorySchemasEqual(undefined, true)).toBe(false);
    });

    it("resolves local $defs and legacy definitions before comparison", () => {
      const byDefs: JSONSchema = {
        $defs: {
          Payload: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        },
        $ref: "#/$defs/Payload",
      };
      const byLegacyDefinitions: JSONSchema = {
        definitions: {
          "Payload/value": {
            required: ["value"],
            properties: { value: { type: "number" } },
            type: "object",
          },
        },
        $ref: "#/definitions/Payload~1value",
      };
      const inline: JSONSchema = {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      };

      expect(factorySchemasEqual(byDefs, inline)).toBe(true);
      expect(factorySchemasEqual(byLegacyDefinitions, inline)).toBe(true);
      expect(byDefs).toHaveProperty("$defs");
      expect(byLegacyDefinitions).toHaveProperty("definitions");
    });

    it("preserves and recursively normalizes asFactory", () => {
      const referenced = {
        $defs: {
          Input: {
            type: "object",
            properties: { value: { type: "number" } },
          },
        },
        asFactory: {
          kind: "pattern",
          argumentSchema: { $ref: "#/$defs/Input" },
          resultSchema: { type: "string" },
        },
      } as JSONSchema;
      const inline: JSONSchemaObj = {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            properties: { value: { type: "number" } },
            type: "object",
          },
          resultSchema: { type: "string" },
        },
      };
      const different: JSONSchemaObj = {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            properties: { value: { type: "number" } },
            type: "object",
          },
          resultSchema: { type: "number" },
        },
      };

      expect(factorySchemasEqual(referenced, inline)).toBe(true);
      expect(factorySchemasEqual(referenced, different)).toBe(false);
    });

    it("fails closed on unresolved, external, malformed, and cyclic refs", () => {
      const unresolved = { $ref: "#/$defs/Missing" } as JSONSchema;
      const external = { $ref: "other.json#/$defs/Value" } as JSONSchema;
      const malformed = { $ref: "#/$defs/Bad~2escape" } as JSONSchema;
      const cyclic = {
        $defs: {
          Left: { $ref: "#/$defs/Right" },
          Right: { $ref: "#/$defs/Left" },
        },
        $ref: "#/$defs/Left",
      } as JSONSchema;

      for (const invalid of [unresolved, external, malformed, cyclic]) {
        expect(factorySchemasEqual(invalid, invalid)).toBe(false);
        expect(factorySchemasEqual(invalid, true)).toBe(false);
      }
    });
  });
});
