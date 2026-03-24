import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { JSONSchemaObj } from "@commontools/api";
import { FabricHash } from "../fabric-hash.ts";
import { isDeepFrozen } from "../deep-freeze.ts";
import { SchemaAndHash } from "../schema-and-hash.ts";
import { toDeepFrozenSchema } from "../schema-utils.ts";
import { resetSchemaHashConfig, setSchemaHashConfig } from "../schema-hash.ts";
import { resetModernHashConfig, setModernHashConfig } from "../value-hash.ts";

describe("SchemaAndHash", () => {
  beforeEach(() => {
    setSchemaHashConfig(true);
    setModernHashConfig(true);
  });

  afterEach(() => {
    resetSchemaHashConfig();
    resetModernHashConfig();
  });

  describe("constructor", () => {
    it("throws if schema is not deep-frozen", () => {
      const hash = new FabricHash(new Uint8Array(32), "fid1");
      assertThrows(
        () => new SchemaAndHash({ type: "number" }, hash),
        Error,
        "schema must be deep-frozen",
      );
    });

    it("accepts a deep-frozen schema", () => {
      const schema = toDeepFrozenSchema({ type: "number" });
      const hash = new FabricHash(new Uint8Array(32), "fid1");
      const sah = new SchemaAndHash(schema, hash);
      assertStrictEquals(sah.schema, schema);
      assertStrictEquals(sah.hash, hash);
    });

    it("accepts boolean schema (primitives are inherently frozen)", () => {
      const hash = new FabricHash(new Uint8Array(32), "fid1");
      const sah = new SchemaAndHash(true, hash);
      assertStrictEquals(sah.schema, true);
    });
  });

  describe("from()", () => {
    it("creates an instance with schema and hash", () => {
      const sah = SchemaAndHash.from({ type: "number" });
      assertEquals(sah.schema, { type: "number" });
      assert(sah.hash instanceof FabricHash);
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
      assert(sah.hash instanceof FabricHash);
    });

    it("handles boolean schema false", () => {
      const sah = SchemaAndHash.from(false);
      assertEquals(sah.schema, false);
      assert(sah.hash instanceof FabricHash);
    });

    it("handles empty object schema", () => {
      const sah = SchemaAndHash.from({});
      assertEquals(sah.schema, {});
      assert(sah.hash instanceof FabricHash);
    });
  });

  describe("hashString getter", () => {
    it("returns a string", () => {
      const sah = SchemaAndHash.from({ type: "number" });
      assertStrictEquals(typeof sah.hashString, "string");
    });

    it("matches hash.toString()", () => {
      const sah = SchemaAndHash.from({ type: "number" });
      assertStrictEquals(sah.hashString, sah.hash.toString());
    });
  });

  describe("instance frozenness", () => {
    it("the instance itself is frozen", () => {
      const sah = SchemaAndHash.from({ type: "string" });
      assert(Object.isFrozen(sah));
    });

    it("schema property is not writable", () => {
      const sah = SchemaAndHash.from({ type: "string" });
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
    it("same schema produces the same hashString", () => {
      const sah1 = SchemaAndHash.from({ type: "number" });
      const sah2 = SchemaAndHash.from({ type: "number" });
      assertEquals(sah1.hashString, sah2.hashString);
    });

    it("different schemas produce different hashStrings", () => {
      const sah1 = SchemaAndHash.from({ type: "number" });
      const sah2 = SchemaAndHash.from({ type: "string" });
      assertNotStrictEquals(sah1.hashString, sah2.hashString);
    });

    it("property order does not affect hash", () => {
      const sah1 = SchemaAndHash.from({ type: "object", title: "foo" });
      const sah2 = SchemaAndHash.from({ title: "foo", type: "object" });
      assertEquals(sah1.hashString, sah2.hashString);
    });
  });
});
