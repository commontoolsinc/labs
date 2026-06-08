import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { SchemaAndHash } from "@/SchemaAndHash.ts";
import { toDeepFrozenSchema } from "@/schema-utils.ts";

// Two distinct non-empty byte arrays so tests can observe variance.
const HASH_A = new FabricHash(
  new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  "fid1",
);
const HASH_B = new FabricHash(
  new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]),
  "fid1",
);

describe("SchemaAndHash", () => {
  describe("constructor()", () => {
    it("throws if the schema is not deep-frozen", () => {
      expect(() => new SchemaAndHash({ type: "number" }, HASH_A)).toThrow(
        "schema must be deep-frozen",
      );
    });

    it("accepts a deep-frozen schema", () => {
      const schema = toDeepFrozenSchema({ type: "number" });
      const sah = new SchemaAndHash(schema, HASH_A);
      expect(sah.schema).toBe(schema);
      expect(sah.hash).toBe(HASH_A);
    });

    it("accepts a boolean schema (primitives are inherently frozen)", () => {
      const sah = new SchemaAndHash(true, HASH_A);
      expect(sah.schema).toBe(true);
    });

    it("produces a frozen instance", () => {
      const sah = new SchemaAndHash(true, HASH_A);
      expect(Object.isFrozen(sah)).toBe(true);
    });
  });

  describe("instance members", () => {
    describe(".schema", () => {
      it("is not writable", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        expect(() => {
          (sah as unknown as Record<string, unknown>).schema = false;
        }).toThrow();
      });
    });

    describe(".hash", () => {
      it("is not writable", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        expect(() => {
          (sah as unknown as Record<string, unknown>).hash = "tampered";
        }).toThrow();
      });
    });

    describe(".taggedHashString", () => {
      it("returns a string", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        expect(typeof sah.taggedHashString).toBe("string");
      });

      it("matches `hash.taggedHashString`", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        expect(sah.taggedHashString).toBe(sah.hash.taggedHashString);
      });

      it("produces different results for different hashes", () => {
        const sahA = new SchemaAndHash(true, HASH_A);
        const sahB = new SchemaAndHash(true, HASH_B);
        expect(sahA.taggedHashString).not.toBe(sahB.taggedHashString);
      });
    });
  });
});
