import { describe, it } from "@std/testing/bdd";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import {
  findInternedSchema,
  hashSchema,
  hashSchemaItem,
  hashSchemaItemAsFabricHash,
  internSchema,
  internSchemaAsHashString,
  isInternedSchema,
} from "../schema-hash.ts";
import { SchemaAndHash } from "../schema-and-hash.ts";
import { FabricHash } from "../fabric-hash.ts";
import { isDeepFrozen } from "../deep-freeze.ts";
import { toDeepFrozenSchema } from "../schema-utils.ts";
import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

describe("schema-hash dispatch", () => {
  describe("hashSchema()", () => {
    it("returns a string", () => {
      const result = hashSchema({ type: "number" });
      assertStrictEquals(typeof result, "string");
    });

    it("is deterministic (same input produces same result)", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const a = hashSchema(schema);
      const b = hashSchema(schema);
      assertStrictEquals(a, b);
    });

    it("produces different results for different schemas", () => {
      const a = hashSchema({ type: "number" });
      const b = hashSchema({ type: "string" });
      assertNotEquals(a, b);
    });

    it("is key-order independent", () => {
      const a = hashSchema({ type: "object", title: "A" } as JSONSchema);
      const b = hashSchema({ title: "A", type: "object" } as JSONSchema);
      assertStrictEquals(a, b);
    });
  });

  describe("hashSchemaItem()", () => {
    it("returns a string", () => {
      const result = hashSchemaItem("hello");
      assertStrictEquals(typeof result, "string");
    });

    it("is deterministic", () => {
      const a = hashSchemaItem(42);
      const b = hashSchemaItem(42);
      assertStrictEquals(a, b);
    });

    it("produces different results for different values", () => {
      const a = hashSchemaItem("foo");
      const b = hashSchemaItem("bar");
      assertNotEquals(a, b);
    });
  });

  describe("hashSchemaItemAsFabricHash()", () => {
    it("returns a `FabricHash`", () => {
      const result = hashSchemaItemAsFabricHash("hello");
      assert(result instanceof FabricHash);
    });

    it("uses the expected algorithm tag", () => {
      const expectedTag = "fid1";
      assertStrictEquals(
        hashSchemaItemAsFabricHash(42).tag,
        expectedTag,
      );
    });

    it("is deterministic (same input → same hash)", () => {
      const a = hashSchemaItemAsFabricHash(42);
      const b = hashSchemaItemAsFabricHash(42);
      assertStrictEquals(a.toString(), b.toString());
    });

    it("produces different hashes for different values", () => {
      const a = hashSchemaItemAsFabricHash("foo");
      const b = hashSchemaItemAsFabricHash("bar");
      assertNotEquals(a.toString(), b.toString());
    });

    it("handles primitive, array, and object inputs", () => {
      assert(hashSchemaItemAsFabricHash(null) instanceof FabricHash);
      assert(hashSchemaItemAsFabricHash(true) instanceof FabricHash);
      assert(hashSchemaItemAsFabricHash([1, 2, 3]) instanceof FabricHash);
      assert(
        hashSchemaItemAsFabricHash({ a: 1, b: "two" }) instanceof
          FabricHash,
      );
    });

    it("is key-order independent for object inputs", () => {
      const a = hashSchemaItemAsFabricHash({ type: "object", title: "A" });
      const b = hashSchemaItemAsFabricHash({ title: "A", type: "object" });
      assertStrictEquals(a.toString(), b.toString());
    });

    it("agrees with the hash stored by `internSchema()`", () => {
      const schema = toDeepFrozenSchema({
        type: "object",
        properties: { x: { type: "number" } },
      }) as JSONSchemaObj;
      const internedHash = internSchema(schema, true).hash;
      const directHash = hashSchemaItemAsFabricHash(schema);
      assertStrictEquals(internedHash.toString(), directHash.toString());
    });
  });

  describe("internSchema()", () => {
    it("defaults to `wantSchemaAndHash = false`", () => {
      const result = internSchema({});
      assert(!(result instanceof SchemaAndHash));
    });

    for (const wantSah of [false, true]) {
      const callIntern = (schema: JSONSchema, fullResult = false) => {
        const result = internSchema(schema, wantSah);

        if (wantSah) {
          assert(result instanceof SchemaAndHash);
          assert(result.hash instanceof FabricHash);
          return fullResult ? result : result.schema;
        } else {
          return result;
        }
      };

      describe(`with \`wantSchemaAndHash = ${wantSah}\``, () => {
        it("creates a valid result with schema equal to the given one", () => {
          const result = callIntern({ type: "number" });
          assertEquals(result, { type: "number" });
        });

        it("returns a deep-frozen schema result", () => {
          const schema: JSONSchemaObj = {
            type: "object",
            properties: { name: { type: "string" } },
          };
          const result = callIntern(schema);
          assert(isDeepFrozen(result));
        });

        it("deep-freezes the caller's original if not already deep-frozen", () => {
          const schema: JSONSchemaObj = {
            type: "object",
            properties: { x: { type: "number" } },
          };
          callIntern(schema);
          assert(isDeepFrozen(schema));
        });

        it("uses an already-deep-frozen schema by reference", () => {
          // Content-unique key guarantees no prior interning has seen this
          // exact schema.
          const schema = toDeepFrozenSchema({
            type: "object",
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
          }) as JSONSchemaObj;
          assert(isDeepFrozen(schema));
          const result = callIntern(schema);
          assertStrictEquals(result, schema);
        });

        it("uses a never-before-encountered mutable schema by reference", () => {
          // Content-unique key guarantees no prior interning has seen this
          // exact schema.
          const schema: JSONSchemaObj = {
            type: "number",
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
          };
          const result = callIntern(schema);
          assertStrictEquals(result, schema);
        });

        it("handles boolean schema true", () => {
          const result = callIntern(true);
          assertEquals(result, true);
        });

        it("handles boolean schema false", () => {
          const result = callIntern(false);
          assertEquals(result, false);
        });

        it("handles empty object schema", () => {
          const result = callIntern({});
          assertEquals(result, {});
        });

        it("returns same instance for repeated boolean schema", () => {
          const result1 = callIntern(true, true);
          const result2 = callIntern(true, true);
          assertStrictEquals(result1, result2);
        });

        it("returns same instance for same frozen object schema", () => {
          const schema = toDeepFrozenSchema({
            type: "number",
          }) as JSONSchemaObj;
          const result1 = callIntern(schema, true);
          const result2 = callIntern(schema, true);
          assertStrictEquals(result1, result2);
        });

        it("returns same instance for repeated unfrozen schema", () => {
          const result1 = callIntern({ type: "number" }, true);
          const result2 = callIntern({ type: "number" }, true);
          assertStrictEquals(result1, result2);
        });

        it("different schemas produce different instances", () => {
          const result1 = callIntern({ type: "number" }, true);
          const result2 = callIntern({ type: "string" }, true);
          assertNotStrictEquals(result1, result2);
        });

        it("property order does not affect interning", () => {
          const result1 = callIntern(
            { type: "object", title: "foo" },
            true,
          );
          const result2 = callIntern(
            { title: "foo", type: "object" },
            true,
          );
          assertStrictEquals(result1, result2);
        });

        it("structurally-equal but identity-different schemas return same instance", () => {
          const a: JSONSchemaObj = {
            type: "object",
            properties: { x: { type: "number" } },
          };
          const b: JSONSchemaObj = {
            type: "object",
            properties: { x: { type: "number" } },
          };
          assertNotStrictEquals(a, b); // different objects
          const resultA = callIntern(a, true);
          const resultB = callIntern(b, true);
          assertStrictEquals(resultA, resultB);
        });
      });
    }
  });

  describe("isInternedSchema()", () => {
    it("returns true for boolean true", () => {
      assertStrictEquals(isInternedSchema(true), true);
    });

    it("returns true for boolean false", () => {
      assertStrictEquals(isInternedSchema(false), true);
    });

    it("returns true for a freshly interned schema", () => {
      const schema = internSchema({ type: "string" });
      assertStrictEquals(isInternedSchema(schema), true);
    });

    it("returns false for a non-interned schema", () => {
      const schema: JSONSchemaObj = { type: "string" };
      assertStrictEquals(isInternedSchema(schema), false);
    });

    it("returns false for an equivalent-but-different object", () => {
      internSchema({ type: "number" });
      const equivalent: JSONSchemaObj = { type: "number" };
      assertStrictEquals(isInternedSchema(equivalent), false);
    });
  });

  describe("findInternedSchema()", () => {
    it("defaults to `wantSchemaAndHash = false`", () => {
      const hash = internSchema({}, true).hash;
      const result = findInternedSchema(hash);
      assert(result !== undefined);
      assert(!(result instanceof SchemaAndHash));
    });

    for (const wantSah of [false, true]) {
      const callFind = (hash: FabricHash | string) => {
        const result = findInternedSchema(hash, wantSah);

        if (wantSah && (result !== undefined)) {
          assert(result instanceof SchemaAndHash);
          assert(result.hash instanceof FabricHash);
        }

        return result;
      };

      const expectSame = (
        got: JSONSchema | SchemaAndHash | undefined,
        expectedSah: SchemaAndHash,
      ) => {
        if (wantSah) {
          assertStrictEquals(got, expectedSah);
        } else {
          assertStrictEquals(got, expectedSah.schema);
        }
      };

      describe(`with \`wantSchemaAndHash = ${wantSah}\``, () => {
        it("finds a previously interned schema by FabricHash", () => {
          const sah = internSchema(
            { type: "array", items: { type: "string" } },
            true,
          );
          const found = callFind(sah.hash);
          expectSame(found, sah);
        });

        it("finds a previously interned schema by hash string", () => {
          const sah = internSchema(
            {
              type: "object",
              properties: { z: { type: "boolean" } },
            },
            true,
          );
          const found = callFind(sah.hashString);
          expectSame(found, sah);
        });

        it("returns undefined for unknown hash", () => {
          const unknown = new FabricHash(new Uint8Array(32), "fid1");
          const found = callFind(unknown);
          assertStrictEquals(found, undefined);
        });

        it("finds interned boolean schemas", () => {
          const sahTrue = internSchema(true, true);
          const sahFalse = internSchema(false, true);
          const foundTrue = callFind(sahTrue.hash);
          const foundFalse = callFind(sahFalse.hash);
          expectSame(foundTrue, sahTrue);
          expectSame(foundFalse, sahFalse);
        });
      });
    }
  });

  describe("internSchemaAsHashString()", () => {
    it("returns the interned schema's hashString for an object", () => {
      const schema: JSONSchema = { type: "number" };
      const sah = internSchema(schema, true);
      assertStrictEquals(internSchemaAsHashString(schema), sah.hashString);
    });

    it("returns the boolean schema's prefab hashString for `true`", () => {
      const expected = internSchema(true, true).hashString;
      assertStrictEquals(internSchemaAsHashString(true), expected);
    });

    it("returns the boolean schema's prefab hashString for `false`", () => {
      const expected = internSchema(false, true).hashString;
      assertStrictEquals(internSchemaAsHashString(false), expected);
    });

    it("produces matching strings for structurally-equal objects", () => {
      const a: JSONSchema = {
        type: "object",
        properties: { x: { type: "string" } },
      };
      const b: JSONSchema = {
        type: "object",
        properties: { x: { type: "string" } },
      };
      assertStrictEquals(
        internSchemaAsHashString(a),
        internSchemaAsHashString(b),
      );
    });

    it("produces different strings for different schemas", () => {
      assertNotEquals(
        internSchemaAsHashString({ type: "number" }),
        internSchemaAsHashString({ type: "string" }),
      );
      assertNotEquals(
        internSchemaAsHashString(true),
        internSchemaAsHashString(false),
      );
    });

    it("interns the input schema as a side effect", () => {
      // Content-unique key guarantees no prior interning has seen this
      // exact schema, so `isInternedSchema` reflects what THIS call did.
      const schema: JSONSchemaObj = {
        type: "number",
        title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
      };
      assertStrictEquals(isInternedSchema(schema), false);
      internSchemaAsHashString(schema);
      assertStrictEquals(isInternedSchema(schema), true);
      assert(isDeepFrozen(schema));
    });

    it("is idempotent on already-interned schemas", () => {
      const schema: JSONSchema = { type: "number" };
      const first = internSchemaAsHashString(schema);
      const second = internSchemaAsHashString(schema);
      assertStrictEquals(first, second);
    });
  });

  it("hashSchema returns base64url strings (no algorithm prefix)", () => {
    const result = hashSchema({ type: "number" });
    assert(
      /^[A-Za-z0-9_-]+$/.test(result),
      `Expected plain base64url, got: ${result}`,
    );
  });
});
