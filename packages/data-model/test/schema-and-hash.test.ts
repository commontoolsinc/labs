import { describe, it } from "@std/testing/bdd";
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import type { JSONSchemaObj } from "@commontools/api";
import { isDeepFrozen } from "../deep-freeze.ts";
import { SchemaAndHash } from "../schema-and-hash.ts";
import { toDeepFrozenSchema } from "../schema-utils.ts";

describe("SchemaAndHash", () => {
  describe("from()", () => {
    it("creates an instance with schema and hash", () => {
      const sah = SchemaAndHash.from({ type: "number" });
      assertEquals(sah.schema, { type: "number" });
      assertStrictEquals(typeof sah.hash, "string");
    });

    it("deep-freezes the stored schema", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const sah = SchemaAndHash.from(schema);
      assert(isDeepFrozen(sah.schema));
    });

    it("does not modify the caller's original schema", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: { type: "number" } },
      };
      SchemaAndHash.from(schema);
      assertEquals(Object.isFrozen(schema), false);
    });

    it("uses an already-deep-frozen schema by reference", () => {
      const schema = toDeepFrozenSchema({
        type: "object",
        properties: { name: { type: "string" } },
      }) as JSONSchemaObj;
      assert(isDeepFrozen(schema));
      const sah = SchemaAndHash.from(schema);
      assertStrictEquals(sah.schema, schema);
    });

    it("handles boolean schema true", () => {
      const sah = SchemaAndHash.from(true);
      assertEquals(sah.schema, true);
      assertStrictEquals(typeof sah.hash, "string");
    });

    it("handles boolean schema false", () => {
      const sah = SchemaAndHash.from(false);
      assertEquals(sah.schema, false);
      assertStrictEquals(typeof sah.hash, "string");
    });

    it("handles empty object schema", () => {
      const sah = SchemaAndHash.from({});
      assertEquals(sah.schema, {});
      assertStrictEquals(typeof sah.hash, "string");
    });
  });

  describe("instance frozenness", () => {
    it("the instance itself is frozen", () => {
      const sah = SchemaAndHash.from({ type: "string" });
      assert(Object.isFrozen(sah));
    });

    it("schema property is not writable", () => {
      const sah = SchemaAndHash.from({ type: "string" });
      // Frozen objects throw in strict mode on property assignment.
      let threw = false;
      try {
        (sah as unknown as Record<string, unknown>).schema = true;
      } catch {
        threw = true;
      }
      assert(threw);
    });

    it("hash property is not writable", () => {
      const sah = SchemaAndHash.from({ type: "string" });
      let threw = false;
      try {
        (sah as unknown as Record<string, unknown>).hash = "tampered";
      } catch {
        threw = true;
      }
      assert(threw);
    });
  });

  describe("hash determinism", () => {
    it("same schema produces the same hash", () => {
      const sah1 = SchemaAndHash.from({ type: "number" });
      const sah2 = SchemaAndHash.from({ type: "number" });
      assertEquals(sah1.hash, sah2.hash);
    });

    it("different schemas produce different hashes", () => {
      const sah1 = SchemaAndHash.from({ type: "number" });
      const sah2 = SchemaAndHash.from({ type: "string" });
      assertNotStrictEquals(sah1.hash, sah2.hash);
    });

    it("property order does not affect hash", () => {
      const sah1 = SchemaAndHash.from({ type: "object", title: "foo" });
      const sah2 = SchemaAndHash.from({ title: "foo", type: "object" });
      assertEquals(sah1.hash, sah2.hash);
    });
  });
});
