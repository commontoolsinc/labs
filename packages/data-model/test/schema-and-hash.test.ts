import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  assert,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { FabricHash } from "../fabric-hash.ts";
import { SchemaAndHash } from "../schema-and-hash.ts";
import { resetSchemaHashConfig, setSchemaHashConfig } from "../schema-hash.ts";
import { toDeepFrozenSchema } from "../schema-utils.ts";

// Two distinct non-empty byte arrays so tests can observe variance.
const HASH_A = new FabricHash(
  new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  "fid1",
);
const HASH_B = new FabricHash(
  new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]),
  "fid1",
);

for (const flagValue of [false, true]) {
  describe(`SchemaAndHash (modernSchemaHash=${flagValue})`, () => {
    beforeAll(() => {
      setSchemaHashConfig(flagValue);
    });

    afterAll(() => {
      resetSchemaHashConfig();
    });

    describe("constructor", () => {
      it("throws if schema is not deep-frozen", () => {
        assertThrows(
          () => new SchemaAndHash({ type: "number" }, HASH_A),
          Error,
          "schema must be deep-frozen",
        );
      });

      it("accepts a deep-frozen schema", () => {
        const schema = toDeepFrozenSchema({ type: "number" });
        const sah = new SchemaAndHash(schema, HASH_A);
        assertStrictEquals(sah.schema, schema);
        assertStrictEquals(sah.hash, HASH_A);
      });

      it("accepts boolean schema (primitives are inherently frozen)", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        assertStrictEquals(sah.schema, true);
      });
    });

    describe("hashString getter", () => {
      it("returns a string", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        assertStrictEquals(typeof sah.hashString, "string");
      });

      it("matches hash.toString()", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        assertStrictEquals(sah.hashString, sah.hash.toString());
      });

      it("different hashes produce different hashStrings", () => {
        const sahA = new SchemaAndHash(true, HASH_A);
        const sahB = new SchemaAndHash(true, HASH_B);
        assertNotStrictEquals(sahA.hashString, sahB.hashString);
      });
    });

    describe("instance frozenness", () => {
      it("the instance itself is frozen", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        assert(Object.isFrozen(sah));
      });

      it("schema property is not writable", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        let threw = false;
        try {
          (sah as unknown as Record<string, unknown>).schema = false;
        } catch {
          threw = true;
        }
        assert(threw);
      });

      it("hash property is not writable", () => {
        const sah = new SchemaAndHash(true, HASH_A);
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
}
