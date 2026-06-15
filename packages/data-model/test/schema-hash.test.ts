import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

import {
  findInternedSchema,
  hashSchema,
  internSchema,
  internSchemaAsTaggedHashString,
  isInternedSchema,
} from "@/schema-hash.ts";
import { SchemaAndHash } from "@/SchemaAndHash.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { hashStringOf } from "@/value-hash.ts";
import { isDeepFrozen } from "@/deep-freeze.ts";
import { toDeepFrozenSchema } from "@/schema-utils.ts";

describe("schema-hash", () => {
  describe("hashSchema()", () => {
    it("returns a string", () => {
      const result = hashSchema({ type: "number" });
      expect(typeof result).toBe("string");
    });

    it("agrees with `hashStringOf()` on primitives", () => {
      for (const v of [false, true, undefined]) {
        const result1 = hashSchema(v);
        const result2 = hashStringOf(v);
        expect(result1).toBe(result2);
      }
    });

    it("agrees with `hashStringOf()` on plain objects", () => {
      const result1 = hashSchema({ type: "number", title: "Yes!" });
      const result2 = hashStringOf({ type: "number", title: "Yes!" });
      expect(result1).toBe(result2);
    });

    it("is deterministic (same input produces same result)", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const a = hashSchema(schema);
      const b = hashSchema(schema);
      expect(a).toBe(b);
    });

    it("produces different results for different schemas", () => {
      const a = hashSchema({ type: "number" });
      const b = hashSchema({ type: "string" });
      expect(a).not.toEqual(b);
    });

    it("is key-order independent", () => {
      const a = hashSchema({ type: "object", title: "A" } as JSONSchema);
      const b = hashSchema({ title: "A", type: "object" } as JSONSchema);
      expect(a).toBe(b);
    });
  });

  describe("internSchema()", () => {
    it("defaults to `wantSchemaAndHash = false`", () => {
      const result = internSchema({});
      expect(result).not.toBeInstanceOf(SchemaAndHash);
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
          expect(result).toEqual({ type: "number" });
        });

        it("returns a deep-frozen schema result", () => {
          const schema: JSONSchemaObj = {
            type: "object",
            properties: { name: { type: "string" } },
          };
          const result = callIntern(schema);
          expect(isDeepFrozen(result)).toBe(true);
        });

        it("deep-freezes the caller's original if not already deep-frozen", () => {
          const schema: JSONSchemaObj = {
            type: "object",
            properties: { x: { type: "number" } },
          };
          callIntern(schema);
          expect(isDeepFrozen(schema)).toBe(true);
        });

        it("uses an already-deep-frozen schema by reference", () => {
          // Content-unique key guarantees no prior interning has seen this
          // exact schema.
          const schema = toDeepFrozenSchema({
            type: "object",
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
          }) as JSONSchemaObj;
          expect(isDeepFrozen(schema)).toBe(true);
          const result = callIntern(schema);
          expect(result).toBe(schema);
        });

        it("uses a never-before-encountered mutable schema by reference", () => {
          // Content-unique key guarantees no prior interning has seen this
          // exact schema.
          const schema: JSONSchemaObj = {
            type: "number",
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
          };
          const result = callIntern(schema);
          expect(result).toBe(schema);
        });

        it("handles boolean schema `true`", () => {
          const result = callIntern(true);
          expect(result).toBe(true);
        });

        it("handles boolean schema `false`", () => {
          const result = callIntern(false);
          expect(result).toBe(false);
        });

        it("handles empty object schema", () => {
          const result = callIntern({});
          expect(result).toEqual({});
        });

        it("returns same instance for repeated boolean schema", () => {
          const result1 = callIntern(true, true);
          const result2 = callIntern(true, true);
          expect(result1).toBe(result2);
        });

        it("returns same instance for same frozen object schema", () => {
          const schema = toDeepFrozenSchema({
            type: "number",
          }) as JSONSchemaObj;
          const result1 = callIntern(schema, true);
          const result2 = callIntern(schema, true);
          expect(result1).toBe(result2);
        });

        it("returns same instance for repeated unfrozen schema", () => {
          const result1 = callIntern({ type: "number" }, true);
          const result2 = callIntern({ type: "number" }, true);
          expect(result1).toBe(result2);
        });

        it("produces different instances for different schemas", () => {
          const result1 = callIntern({ type: "number" }, true);
          const result2 = callIntern({ type: "string" }, true);
          expect(result1).not.toBe(result2);
        });

        it("ignores property order when interning", () => {
          const result1 = callIntern(
            { type: "object", title: "foo" },
            true,
          );
          const result2 = callIntern(
            { title: "foo", type: "object" },
            true,
          );
          expect(result1).toBe(result2);
        });

        it("returns the same instance for structurally-equal but identity-different schemas", () => {
          const a: JSONSchemaObj = {
            type: "object",
            properties: { x: { type: "number" } },
          };
          const b: JSONSchemaObj = {
            type: "object",
            properties: { x: { type: "number" } },
          };
          expect(a).not.toBe(b); // different objects
          const resultA = callIntern(a, true);
          const resultB = callIntern(b, true);
          expect(resultA).toBe(resultB);
        });
      });
    }
  });

  describe("isInternedSchema()", () => {
    it("returns `true` for boolean `true`", () => {
      expect(isInternedSchema(true)).toBe(true);
    });

    it("returns `true` for boolean `false`", () => {
      expect(isInternedSchema(false)).toBe(true);
    });

    it("returns `true` for a freshly interned schema", () => {
      const schema = internSchema({ type: "string" });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("returns `false` for a non-interned schema", () => {
      const schema: JSONSchemaObj = { type: "string" };
      expect(isInternedSchema(schema)).toBe(false);
    });

    it("returns `false` for an equivalent-but-different object", () => {
      internSchema({ type: "number" });
      const equivalent: JSONSchemaObj = { type: "number" };
      expect(isInternedSchema(equivalent)).toBe(false);
    });
  });

  describe("findInternedSchema()", () => {
    const callFind = (hash: FabricHash | string) => {
      const result = findInternedSchema(hash);

      if (result !== undefined) {
        expect(result).toBeInstanceOf(SchemaAndHash);
        expect(result.hash).toBeInstanceOf(FabricHash);
      }

      return result;
    };

    it("finds a previously interned schema by FabricHash", () => {
      const sah = internSchema(
        { type: "array", items: { type: "string" } },
        true,
      );
      const found = callFind(sah.hash);
      expect(found).toBe(sah);
    });

    it("finds a previously interned schema by hash string", () => {
      const sah = internSchema(
        {
          type: "object",
          properties: { z: { type: "boolean" } },
        },
        true,
      );
      const found = callFind(sah.taggedHashString);
      expect(found).toBe(sah);
    });

    it("returns `undefined` for unknown hash", () => {
      const unknown = new FabricHash(new Uint8Array(32), "fid1");
      const found = callFind(unknown);
      expect(found).toBe(undefined);
    });

    it("finds interned boolean schemas", () => {
      const sahTrue = internSchema(true, true);
      const sahFalse = internSchema(false, true);
      const foundTrue = callFind(sahTrue.hash);
      const foundFalse = callFind(sahFalse.hash);
      expect(foundTrue).toBe(sahTrue);
      expect(foundFalse).toBe(sahFalse);
    });
  });

  describe("internSchemaAsTaggedHashString()", () => {
    it("returns the interned schema's `.taggedHashString` for an object", () => {
      const schema: JSONSchema = { type: "number" };
      const sah = internSchema(schema, true);
      expect(internSchemaAsTaggedHashString(schema)).toBe(sah.taggedHashString);
    });

    it("returns the boolean schema's prefab `.taggedHashString` for `true`", () => {
      const expected = internSchema(true, true).taggedHashString;
      expect(internSchemaAsTaggedHashString(true)).toBe(expected);
    });

    it("returns the boolean schema's prefab `.taggedHashString` for `false`", () => {
      const expected = internSchema(false, true).taggedHashString;
      expect(internSchemaAsTaggedHashString(false)).toBe(expected);
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
      expect(internSchemaAsTaggedHashString(a)).toBe(
        internSchemaAsTaggedHashString(b),
      );
    });

    it("produces different strings for different schemas", () => {
      expect(internSchemaAsTaggedHashString({ type: "number" })).not.toEqual(
        internSchemaAsTaggedHashString({ type: "string" }),
      );
      expect(internSchemaAsTaggedHashString(true)).not.toEqual(
        internSchemaAsTaggedHashString(false),
      );
    });

    it("interns the input schema as a side effect", () => {
      // Content-unique key guarantees no prior interning has seen this
      // exact schema, so `isInternedSchema` reflects what THIS call did.
      const schema: JSONSchemaObj = {
        type: "number",
        title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
      };
      expect(isInternedSchema(schema)).toBe(false);
      internSchemaAsTaggedHashString(schema);
      expect(isInternedSchema(schema)).toBe(true);
      expect(isDeepFrozen(schema)).toBe(true);
    });

    it("is idempotent on already-interned schemas", () => {
      const schema: JSONSchema = { type: "number" };
      const first = internSchemaAsTaggedHashString(schema);
      const second = internSchemaAsTaggedHashString(schema);
      expect(first).toBe(second);
    });
  });

  it("returns base64url strings from `hashSchema()` (no algorithm prefix)", () => {
    const result = hashSchema({ type: "number" });
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
