import { afterEach, describe, it } from "@std/testing/bdd";
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
  internSchema,
  resetSchemaHashConfig,
  setSchemaHashConfig,
} from "../schema-hash.ts";
import { FabricHash } from "../fabric-hash.ts";
import { isDeepFrozen } from "../deep-freeze.ts";
import { toDeepFrozenSchema } from "../schema-utils.ts";
import type { JSONSchema, JSONSchemaObj } from "@commontools/api";

describe("schema-hash dispatch", () => {
  afterEach(() => {
    resetSchemaHashConfig();
  });

  // -------------------------------------------------------------------------
  // Legacy path (flag OFF)
  // -------------------------------------------------------------------------

  describe("legacy path (modernSchemaHash OFF)", () => {
    it("hashSchema returns a string", () => {
      setSchemaHashConfig(false);
      const result = hashSchema({ type: "number" });
      assertStrictEquals(typeof result, "string");
    });

    it("hashSchema is deterministic (same input produces same result)", () => {
      setSchemaHashConfig(false);
      const schema: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const a = hashSchema(schema);
      const b = hashSchema(schema);
      assertStrictEquals(a, b);
    });

    it("hashSchema produces different results for different schemas", () => {
      setSchemaHashConfig(false);
      const a = hashSchema({ type: "number" });
      const b = hashSchema({ type: "string" });
      assertNotEquals(a, b);
    });

    it("hashSchema is key-order independent", () => {
      setSchemaHashConfig(false);
      const a = hashSchema({ type: "object", title: "A" } as JSONSchema);
      const b = hashSchema({ title: "A", type: "object" } as JSONSchema);
      assertStrictEquals(a, b);
    });

    it("hashSchemaItem returns a string", () => {
      setSchemaHashConfig(false);
      const result = hashSchemaItem("hello");
      assertStrictEquals(typeof result, "string");
    });

    it("hashSchemaItem is deterministic", () => {
      setSchemaHashConfig(false);
      const a = hashSchemaItem(42);
      const b = hashSchemaItem(42);
      assertStrictEquals(a, b);
    });

    it("hashSchemaItem produces different results for different values", () => {
      setSchemaHashConfig(false);
      const a = hashSchemaItem("foo");
      const b = hashSchemaItem("bar");
      assertNotEquals(a, b);
    });
  });

  // -------------------------------------------------------------------------
  // Modern path (flag ON)
  // -------------------------------------------------------------------------

  describe("modern path (modernSchemaHash ON)", () => {
    it("hashSchema returns a string", () => {
      setSchemaHashConfig(true);
      const result = hashSchema({ type: "number" });
      assertStrictEquals(typeof result, "string");
    });

    it("hashSchema is deterministic (same input produces same result)", () => {
      setSchemaHashConfig(true);
      const schema: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const a = hashSchema(schema);
      const b = hashSchema(schema);
      assertStrictEquals(a, b);
    });

    it("hashSchema produces different results for different schemas", () => {
      setSchemaHashConfig(true);
      const a = hashSchema({ type: "number" });
      const b = hashSchema({ type: "string" });
      assertNotEquals(a, b);
    });

    it("hashSchemaItem returns a string", () => {
      setSchemaHashConfig(true);
      const result = hashSchemaItem("hello");
      assertStrictEquals(typeof result, "string");
    });

    it("hashSchemaItem is deterministic", () => {
      setSchemaHashConfig(true);
      const a = hashSchemaItem(42);
      const b = hashSchemaItem(42);
      assertStrictEquals(a, b);
    });

    it("hashSchemaItem produces different results for different values", () => {
      setSchemaHashConfig(true);
      const a = hashSchemaItem("foo");
      const b = hashSchemaItem("bar");
      assertNotEquals(a, b);
    });

    it("hashSchema returns fid1: prefixed strings", () => {
      setSchemaHashConfig(true);
      const result = hashSchema({ type: "number" });
      assert(
        result.startsWith("fid1:"),
        `Expected fid1: prefix, got: ${result}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cross-path: legacy and modern produce different hashes
  // -------------------------------------------------------------------------

  describe("legacy vs modern produce different hashes", () => {
    it("hashSchema differs between paths for same input", () => {
      const schema: JSONSchema = { type: "number" };
      setSchemaHashConfig(false);
      const legacy = hashSchema(schema);
      setSchemaHashConfig(true);
      const modern = hashSchema(schema);
      assertNotEquals(legacy, modern);
    });

    it("hashSchemaItem differs between paths for same input", () => {
      setSchemaHashConfig(false);
      const legacy = hashSchemaItem("test");
      setSchemaHashConfig(true);
      const modern = hashSchemaItem("test");
      assertNotEquals(legacy, modern);
    });
  });

  // -------------------------------------------------------------------------
  // Reset behavior
  // -------------------------------------------------------------------------

  describe("reset restores legacy path", () => {
    it("hashSchema returns legacy result after reset", () => {
      setSchemaHashConfig(false);
      const legacy = hashSchema({ type: "boolean" });

      setSchemaHashConfig(true);
      resetSchemaHashConfig();
      const afterReset = hashSchema({ type: "boolean" });

      assertStrictEquals(legacy, afterReset);
    });
  });

  // -------------------------------------------------------------------------
  // Schema interning
  // -------------------------------------------------------------------------

  describe("internSchema()", () => {
    it("creates a SchemaAndHash with schema and hash", () => {
      const sah = internSchema({ type: "number" });
      assertEquals(sah.schema, { type: "number" });
      assert(sah.hash instanceof FabricHash);
    });

    it("deep-freezes the stored schema", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const sah = internSchema(schema);
      assert(isDeepFrozen(sah.schema));
    });

    it("does not modify the caller's original schema", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: { type: "number" } },
      };
      internSchema(schema);
      assertEquals(Object.isFrozen(schema), false);
    });

    it("uses an already-deep-frozen schema by reference", () => {
      const schema = toDeepFrozenSchema({
        type: "object",
        properties: { uniqueField: { type: "boolean" } },
      }) as JSONSchemaObj;
      assert(isDeepFrozen(schema));
      const sah = internSchema(schema);
      assertStrictEquals(sah.schema, schema);
    });

    it("handles boolean schema true", () => {
      const sah = internSchema(true);
      assertEquals(sah.schema, true);
      assert(sah.hash instanceof FabricHash);
    });

    it("handles boolean schema false", () => {
      const sah = internSchema(false);
      assertEquals(sah.schema, false);
      assert(sah.hash instanceof FabricHash);
    });

    it("handles empty object schema", () => {
      const sah = internSchema({});
      assertEquals(sah.schema, {});
      assert(sah.hash instanceof FabricHash);
    });

    it("returns same SchemaAndHash for repeated boolean schema", () => {
      const sah1 = internSchema(true);
      const sah2 = internSchema(true);
      assertStrictEquals(sah1, sah2);
    });

    it("returns same instance for same frozen object schema", () => {
      const schema = toDeepFrozenSchema({ type: "number" }) as JSONSchemaObj;
      const sah1 = internSchema(schema);
      const sah2 = internSchema(schema);
      assertStrictEquals(sah1, sah2);
    });

    it("returns same instance for repeated unfrozen schema", () => {
      const sah1 = internSchema({ type: "number" });
      const sah2 = internSchema({ type: "number" });
      assertStrictEquals(sah1, sah2);
    });

    it("different schemas produce different instances", () => {
      const sah1 = internSchema({ type: "number" });
      const sah2 = internSchema({ type: "string" });
      assertNotStrictEquals(sah1, sah2);
    });

    it("property order does not affect interning", () => {
      const sah1 = internSchema({ type: "object", title: "foo" });
      const sah2 = internSchema({ title: "foo", type: "object" });
      assertStrictEquals(sah1, sah2);
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
      const sahA = internSchema(a);
      const sahB = internSchema(b);
      assertStrictEquals(sahA, sahB);
    });
  });

  describe("findInternedSchema()", () => {
    it("finds a previously interned schema by FabricHash", () => {
      const sah = internSchema({ type: "array", items: { type: "string" } });
      const found = findInternedSchema(sah.hash);
      assertStrictEquals(found, sah);
    });

    it("finds a previously interned schema by hash string", () => {
      const sah = internSchema({
        type: "object",
        properties: { z: { type: "boolean" } },
      });
      const found = findInternedSchema(sah.hashString);
      assertStrictEquals(found, sah);
    });

    it("returns undefined for unknown hash", () => {
      const unknown = new FabricHash(new Uint8Array(32), "fid1");
      assertStrictEquals(findInternedSchema(unknown), undefined);
    });

    it("finds interned boolean schemas", () => {
      const sahTrue = internSchema(true);
      const sahFalse = internSchema(false);
      assertStrictEquals(findInternedSchema(sahTrue.hash), sahTrue);
      assertStrictEquals(findInternedSchema(sahFalse.hash), sahFalse);
    });
  });
});
