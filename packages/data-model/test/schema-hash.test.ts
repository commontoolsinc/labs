import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertNotEquals } from "@std/assert";
import {
  hashSchema,
  hashSchemaItem,
  resetSchemaHashConfig,
  setSchemaHashConfig,
} from "../schema-hash.ts";
import { FabricHash } from "../fabric-hash.ts";
import type { JSONSchema } from "@commontools/api";

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
});
