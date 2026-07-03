import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

import {
  deepFrozenCloneAndInternSchema,
  findInternedSchema,
  hashSchema,
  internSchema,
  internSchemaAsTaggedHashString,
  isInternedSchema,
} from "@/schema-hash.ts";
import { SchemaAndHash } from "@/SchemaAndHash.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { hashStringOf, taggedHashStringOf } from "@/value-hash.ts";
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
      const callIntern = (
        schema: JSONSchema | undefined,
        fullResult = false,
      ) => {
        const result = internSchema(schema, wantSah);

        if (wantSah) {
          assert(result instanceof SchemaAndHash);
          assert(result.hash instanceof FabricHash);
          return fullResult ? result : result.schemaOrUndefined;
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

        it("uses an already-deep-frozen, already-canonical schema by reference", () => {
          // Content-unique key guarantees no prior interning has seen this exact
          // schema. Its keys are already in canonical (UTF-8 byte) order, so
          // interning returns the input by reference — no canonicalizing clone.
          const schema = toDeepFrozenSchema({
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
            type: "object",
          }) as JSONSchemaObj;
          expect(isDeepFrozen(schema)).toBe(true);
          const result = callIntern(schema);
          expect(result).toBe(schema);
        });

        it("uses a never-before-encountered, already-canonical mutable schema by reference", () => {
          // As above: content-unique, with keys already in canonical order, so
          // it is frozen in place and returned by reference.
          const schema: JSONSchemaObj = {
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
            type: "number",
          };
          const result = callIntern(schema);
          expect(result).toBe(schema);
        });

        it("returns a sorted clone (not by reference) for a non-canonical schema", () => {
          // Keys NOT in canonical order: interning returns a structurally-equal
          // clone with keys sorted, so the interned form serializes the same way
          // regardless of the input's key order (the convergence property).
          const schema: JSONSchemaObj = {
            type: "object",
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
          };
          const result = callIntern(schema) as JSONSchemaObj;
          expect(result).not.toBe(schema);
          expect(result).toEqual(schema); // structurally equal
          expect(Object.keys(result)).toEqual(["title", "type"]); // sorted
          expect(isDeepFrozen(result)).toBe(true);
        });

        it("handles boolean schema `true`", () => {
          const result = callIntern(true);
          expect(result).toBe(true);
        });

        it("handles boolean schema `false`", () => {
          const result = callIntern(false);
          expect(result).toBe(false);
        });

        it("handles schema `undefined`", () => {
          const result = callIntern(undefined);
          expect(result).toBe(undefined);
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

  describe("deepFrozenCloneAndInternSchema()", () => {
    it("interns a deep-frozen clone without freezing the input in place", () => {
      const input: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      expect(Object.isFrozen(input)).toBe(false); // precondition

      const result = deepFrozenCloneAndInternSchema(input);

      expect(result).not.toBe(input); // a clone, not the same object
      expect(result).toEqual(input); // structurally equal
      expect(isInternedSchema(result)).toBe(true);
      expect(isDeepFrozen(result)).toBe(true);
      // The whole point of this function: the caller's object is untouched,
      // unlike `internSchema()`, which would deep-freeze it in place.
      expect(Object.isFrozen(input)).toBe(false);
    });

    it("interns by content (equal inputs collapse to one instance)", () => {
      const a = deepFrozenCloneAndInternSchema({ type: "number", title: "x" });
      const b = deepFrozenCloneAndInternSchema({ type: "number", title: "x" });
      expect(a).toBe(b);
    });

    it("passes `undefined` and boolean schemas through", () => {
      expect(deepFrozenCloneAndInternSchema(undefined)).toBe(undefined);
      expect(deepFrozenCloneAndInternSchema(true)).toBe(true);
      expect(deepFrozenCloneAndInternSchema(false)).toBe(false);
    });
  });

  describe("isInternedSchema()", () => {
    it("returns `true` for boolean `true`", () => {
      expect(isInternedSchema(true)).toBe(true);
    });

    it("returns `true` for boolean `false`", () => {
      expect(isInternedSchema(false)).toBe(true);
    });

    it("returns `true` for `undefined`", () => {
      expect(isInternedSchema(undefined)).toBe(true);
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

    it("finds `undefined`", () => {
      const undefinedHash = taggedHashStringOf(undefined);
      const found = callFind(undefinedHash);
      expect(found).not.toBe(undefined);
      expect(found!.schemaOrUndefined).toBe(undefined);
    });
  });

  describe("internSchemaAsTaggedHashString()", () => {
    it("returns the interned schema's `.taggedHashString` for an object", () => {
      const schema: JSONSchema = { type: "number" };
      const sah = internSchema(schema, true);
      expect(internSchemaAsTaggedHashString(schema)).toBe(sah.taggedHashString);
    });

    it("returns the prefab `.taggedHashString` for `true`", () => {
      const expected = internSchema(true, true).taggedHashString;
      expect(internSchemaAsTaggedHashString(true)).toBe(expected);
    });

    it("returns the prefab `.taggedHashString` for `false`", () => {
      const expected = internSchema(false, true).taggedHashString;
      expect(internSchemaAsTaggedHashString(false)).toBe(expected);
    });

    it("returns the prefab `.taggedHashString` for `undefined`", () => {
      const expected = internSchema(undefined, true).taggedHashString;
      expect(internSchemaAsTaggedHashString(undefined)).toBe(expected);
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

  // The schema hash is key-order-insensitive (value-hash sorts keys), but the
  // interned object previously kept the key order of whichever code path first
  // interned it. Schemas are serialized directly from the interned object (e.g.
  // into content-addressed `data:` cell ids), so divergent stored key order let
  // two runtimes mint different ids for the same schema. The interned form is
  // now key-order-canonical so serialization is deterministic across paths.
  describe("key-order canonicalization", () => {
    it("interns object keys in UTF-8 sorted order regardless of input order", () => {
      // "$defs" (0x24) < "items" (0x69) < "type" (0x74)
      const interned = internSchema({
        type: "array",
        items: { type: "string" },
        $defs: { X: { type: "null" } },
      }) as JSONSchemaObj;
      expect(Object.keys(interned)).toEqual(["$defs", "items", "type"]);
    });

    it("sorts keys deeply (nested objects too)", () => {
      const interned = internSchema({
        type: "object",
        properties: { b: { type: "number" }, a: { type: "string" } },
      }) as JSONSchemaObj;
      expect(Object.keys(interned)).toEqual(["properties", "type"]);
      expect(Object.keys(interned.properties as JSONSchemaObj)).toEqual([
        "a",
        "b",
      ]);
    });

    it("preserves array order (arrays are ordered, not sorted)", () => {
      const interned = internSchema({
        type: "object",
        required: ["b", "a", "c"],
      }) as JSONSchemaObj;
      expect(interned.required).toEqual(["b", "a", "c"]);
    });

    it("converges: equal schemas in opposite key orders intern to one object and serialize identically", () => {
      // A unique `title` keeps this test's structural hash to itself.
      const tag = "canon-converge-test";
      const unsorted: JSONSchema = {
        type: "array",
        title: tag,
        items: { type: "string" },
        $defs: { X: { type: "null" } },
      };
      const sorted: JSONSchema = {
        $defs: { X: { type: "null" } },
        items: { type: "string" },
        title: tag,
        type: "array",
      };
      const a = internSchema(unsorted);
      const b = internSchema(sorted);
      expect(a).toBe(b); // same canonical object, regardless of which interned first
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      // ...and the canonical serialization is the sorted one.
      expect(JSON.stringify(a)).toBe(JSON.stringify(sorted));
    });

    it("leaves the schema hash unchanged (it was already key-order-insensitive)", () => {
      const tag = "canon-hash-test";
      const unsorted: JSONSchema = {
        type: "number",
        title: tag,
        description: "d",
      };
      const sorted: JSONSchema = {
        description: "d",
        title: tag,
        type: "number",
      };
      expect(hashSchema(unsorted)).toBe(hashSchema(sorted));
      expect(hashSchema(internSchema(unsorted))).toBe(hashSchema(unsorted));
    });

    it("interns to a deep-frozen object", () => {
      const interned = internSchema({
        type: "array",
        items: { type: "string" },
        $defs: { X: { type: "null" } },
      });
      assert(isDeepFrozen(interned));
    });

    it("shares already-interned sub-schemas by reference (no needless rebuild)", () => {
      // Pre-intern a child, then intern a parent that holds it. Canonicalizing
      // the parent keeps the already-interned (already-canonical) child by
      // reference instead of cloning it, preserving structural sharing.
      const child = internSchema({
        title: `canon-child-${Date.now()}-${Math.random()}`,
        type: "string",
      }) as JSONSchemaObj;
      const parent = internSchema({
        type: "object",
        title: `canon-parent-${Date.now()}-${Math.random()}`,
        properties: { x: child },
      }) as JSONSchemaObj;
      expect((parent.properties as Record<string, unknown>).x).toBe(child);
    });

    it("rebuilds non-canonical array elements while preserving array order", () => {
      // An array element that is itself a non-canonical object gets its keys
      // sorted, but the array's element order is preserved (arrays are ordered).
      const interned = internSchema({
        title: `canon-arr-${Date.now()}-${Math.random()}`,
        anyOf: [
          { type: "object", $defs: { X: { type: "null" } } }, // non-canonical
          { type: "string" },
        ],
      }) as JSONSchemaObj;
      const anyOf = interned.anyOf as JSONSchemaObj[];
      expect(Object.keys(anyOf[0])).toEqual(["$defs", "type"]); // element sorted
      expect((anyOf[1] as JSONSchemaObj).type).toBe("string"); // order preserved
      expect(anyOf.length).toBe(2);
    });

    it("preserves owned symbol-keyed properties when it rebuilds for sorting", () => {
      // Schemas are normally string-keyed, but canonicalization must never
      // silently drop an owned (symbol) property when it rebuilds to sort keys.
      const marker = Symbol("schemaMarker");
      const schema = {
        type: "object",
        title: `canon-sym-${Date.now()}-${Math.random()}`,
        [marker]: "kept",
      } satisfies JSONSchemaObj & { readonly [marker]: "kept" };
      const interned = internSchema(schema) as JSONSchemaObj;
      expect(Object.keys(interned)).toEqual(["title", "type"]); // string keys sorted
      expect((interned as Record<symbol, unknown>)[marker]).toBe("kept");
    });
  });
});
