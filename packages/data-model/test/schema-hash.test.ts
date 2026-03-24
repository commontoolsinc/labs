import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  hashSchema,
  hashSchemaItem,
  resetSchemaHashConfig,
  setSchemaHashConfig,
} from "../schema-hash.ts";
import type { JSONSchema } from "@commontools/api";

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
      assertEquals(typeof result, "string");
      assert(result.length > 0);
    });

    it("hashSchema is deterministic (same input → same output)", () => {
      setSchemaHashConfig(false);
      const schema: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const a = hashSchema(schema);
      const b = hashSchema(schema);
      assertEquals(a, b);
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
      assertEquals(a, b);
    });

    it("hashSchemaItem returns a string", () => {
      setSchemaHashConfig(false);
      const result = hashSchemaItem("hello");
      assertEquals(typeof result, "string");
      assert(result.length > 0);
    });

    it("hashSchemaItem is deterministic", () => {
      setSchemaHashConfig(false);
      const a = hashSchemaItem(42);
      const b = hashSchemaItem(42);
      assertEquals(a, b);
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
      assertEquals(typeof result, "string");
      assert(result.length > 0);
    });

    it("hashSchema is deterministic (same input → same output)", () => {
      setSchemaHashConfig(true);
      const schema: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const a = hashSchema(schema);
      const b = hashSchema(schema);
      assertEquals(a, b);
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
      assertEquals(typeof result, "string");
      assert(result.length > 0);
    });

    it("hashSchemaItem is deterministic", () => {
      setSchemaHashConfig(true);
      const a = hashSchemaItem(42);
      const b = hashSchemaItem(42);
      assertEquals(a, b);
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

      assertEquals(legacy, afterReset);
    });
  });
});
