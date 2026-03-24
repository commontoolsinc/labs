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
    it("hashSchema returns a FabricHash", () => {
      setSchemaHashConfig(false);
      const result = hashSchema({ type: "number" });
      assert(result instanceof FabricHash);
    });

    it("hashSchema is deterministic (same input produces same toString())", () => {
      setSchemaHashConfig(false);
      const schema: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const a = hashSchema(schema);
      const b = hashSchema(schema);
      assert(a.toString() === b.toString());
    });

    it("hashSchema produces different results for different schemas", () => {
      setSchemaHashConfig(false);
      const a = hashSchema({ type: "number" });
      const b = hashSchema({ type: "string" });
      assertNotEquals(a.toString(), b.toString());
    });

    it("hashSchema is key-order independent", () => {
      setSchemaHashConfig(false);
      const a = hashSchema({ type: "object", title: "A" } as JSONSchema);
      const b = hashSchema({ title: "A", type: "object" } as JSONSchema);
      assert(a.toString() === b.toString());
    });

    it("hashSchemaItem returns a FabricHash", () => {
      setSchemaHashConfig(false);
      const result = hashSchemaItem("hello");
      assert(result instanceof FabricHash);
    });

    it("hashSchemaItem is deterministic", () => {
      setSchemaHashConfig(false);
      const a = hashSchemaItem(42);
      const b = hashSchemaItem(42);
      assert(a.toString() === b.toString());
    });

    it("hashSchemaItem produces different results for different values", () => {
      setSchemaHashConfig(false);
      const a = hashSchemaItem("foo");
      const b = hashSchemaItem("bar");
      assertNotEquals(a.toString(), b.toString());
    });

    it("legacy hashSchema uses 'legacy' algorithm tag", () => {
      setSchemaHashConfig(false);
      const result = hashSchema({ type: "number" });
      assert(
        result.algorithmTag === "legacy",
        `Expected legacy algorithm tag, got: ${result.algorithmTag}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Modern path (flag ON)
  // -------------------------------------------------------------------------

  describe("modern path (modernSchemaHash ON)", () => {
    it("hashSchema returns a FabricHash", () => {
      setSchemaHashConfig(true);
      const result = hashSchema({ type: "number" });
      assert(result instanceof FabricHash);
    });

    it("hashSchema is deterministic (same input produces same toString())", () => {
      setSchemaHashConfig(true);
      const schema: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const a = hashSchema(schema);
      const b = hashSchema(schema);
      assert(a.toString() === b.toString());
    });

    it("hashSchema produces different results for different schemas", () => {
      setSchemaHashConfig(true);
      const a = hashSchema({ type: "number" });
      const b = hashSchema({ type: "string" });
      assertNotEquals(a.toString(), b.toString());
    });

    it("hashSchemaItem returns a FabricHash", () => {
      setSchemaHashConfig(true);
      const result = hashSchemaItem("hello");
      assert(result instanceof FabricHash);
    });

    it("hashSchemaItem is deterministic", () => {
      setSchemaHashConfig(true);
      const a = hashSchemaItem(42);
      const b = hashSchemaItem(42);
      assert(a.toString() === b.toString());
    });

    it("hashSchemaItem produces different results for different values", () => {
      setSchemaHashConfig(true);
      const a = hashSchemaItem("foo");
      const b = hashSchemaItem("bar");
      assertNotEquals(a.toString(), b.toString());
    });

    it("hashSchema returns fid1: prefixed strings", () => {
      setSchemaHashConfig(true);
      const result = hashSchema({ type: "number" });
      assert(
        result.toString().startsWith("fid1:"),
        `Expected fid1: prefix, got: ${result.toString()}`,
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
      const legacy = hashSchema(schema).toString();
      setSchemaHashConfig(true);
      const modern = hashSchema(schema).toString();
      assertNotEquals(legacy, modern);
    });

    it("hashSchemaItem differs between paths for same input", () => {
      setSchemaHashConfig(false);
      const legacy = hashSchemaItem("test").toString();
      setSchemaHashConfig(true);
      const modern = hashSchemaItem("test").toString();
      assertNotEquals(legacy, modern);
    });
  });

  // -------------------------------------------------------------------------
  // Reset behavior
  // -------------------------------------------------------------------------

  describe("reset restores legacy path", () => {
    it("hashSchema returns legacy result after reset", () => {
      setSchemaHashConfig(false);
      const legacy = hashSchema({ type: "boolean" }).toString();

      setSchemaHashConfig(true);
      resetSchemaHashConfig();
      const afterReset = hashSchema({ type: "boolean" }).toString();

      assert(legacy === afterReset);
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
        properties: { name: { type: "string" } },
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

    it("returns consistent hash for same object schema", () => {
      const schema = toDeepFrozenSchema({ type: "number" }) as JSONSchemaObj;
      const sah1 = internSchema(schema);
      const sah2 = internSchema(schema);
      assertEquals(sah1.hashString, sah2.hashString);
    });

    it("same schema produces the same hashString", () => {
      const sah1 = internSchema({ type: "number" });
      const sah2 = internSchema({ type: "number" });
      assertEquals(sah1.hashString, sah2.hashString);
    });

    it("different schemas produce different hashStrings", () => {
      const sah1 = internSchema({ type: "number" });
      const sah2 = internSchema({ type: "string" });
      assertNotStrictEquals(sah1.hashString, sah2.hashString);
    });

    it("property order does not affect hash", () => {
      const sah1 = internSchema({ type: "object", title: "foo" });
      const sah2 = internSchema({ title: "foo", type: "object" });
      assertEquals(sah1.hashString, sah2.hashString);
    });
  });

  describe("findInternedSchema()", () => {
    it("finds a previously interned schema by FabricHash", () => {
      const sah = internSchema({ type: "array", items: { type: "string" } });
      const found = findInternedSchema(sah.hash);
      assert(found !== undefined);
      assertEquals(found!.hashString, sah.hashString);
    });

    it("finds a previously interned schema by hash string", () => {
      const sah = internSchema({
        type: "object",
        properties: { z: { type: "boolean" } },
      });
      const found = findInternedSchema(sah.hashString);
      assert(found !== undefined);
      assertEquals(found!.hashString, sah.hashString);
    });

    it("returns undefined for unknown hash", () => {
      const unknown = new FabricHash(new Uint8Array(32), "fid1");
      assertEquals(findInternedSchema(unknown), undefined);
    });

    it("finds interned boolean schemas", () => {
      const sahTrue = internSchema(true);
      const sahFalse = internSchema(false);
      const foundTrue = findInternedSchema(sahTrue.hash);
      const foundFalse = findInternedSchema(sahFalse.hash);
      assert(foundTrue !== undefined);
      assert(foundFalse !== undefined);
      assertStrictEquals(foundTrue!.schema, true);
      assertStrictEquals(foundFalse!.schema, false);
    });
  });
});
