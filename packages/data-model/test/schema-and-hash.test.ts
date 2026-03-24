import { describe, it } from "@std/testing/bdd";
import { assert, assertStrictEquals, assertThrows } from "@std/assert";
import { FabricHash } from "../fabric-hash.ts";
import { SchemaAndHash } from "../schema-and-hash.ts";
import { toDeepFrozenSchema } from "../schema-utils.ts";

describe("SchemaAndHash", () => {
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

  describe("hashString getter", () => {
    it("returns a string", () => {
      const hash = new FabricHash(new Uint8Array(32), "fid1");
      const sah = new SchemaAndHash(true, hash);
      assertStrictEquals(typeof sah.hashString, "string");
    });

    it("matches hash.toString()", () => {
      const hash = new FabricHash(new Uint8Array(32), "fid1");
      const sah = new SchemaAndHash(true, hash);
      assertStrictEquals(sah.hashString, sah.hash.toString());
    });
  });

  describe("instance frozenness", () => {
    it("the instance itself is frozen", () => {
      const hash = new FabricHash(new Uint8Array(32), "fid1");
      const sah = new SchemaAndHash(true, hash);
      assert(Object.isFrozen(sah));
    });

    it("schema property is not writable", () => {
      const hash = new FabricHash(new Uint8Array(32), "fid1");
      const sah = new SchemaAndHash(true, hash);
      let threw = false;
      try {
        (sah as unknown as Record<string, unknown>).schema = false;
      } catch {
        threw = true;
      }
      assert(threw);
    });

    it("hash property is not writable", () => {
      const hash = new FabricHash(new Uint8Array(32), "fid1");
      const sah = new SchemaAndHash(true, hash);
      let threw = false;
      try {
        (sah as unknown as Record<string, unknown>).hash = "tampered";
      } catch {
        threw = true;
      }
      assert(threw);
    });
  });
});
