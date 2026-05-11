import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { FabricHash } from "../fabric-hash.ts";
import { SchemaAndHash } from "../schema-and-hash.ts";
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

describe("constructor", () => {
  it("throws if schema is not deep-frozen", () => {
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

  it("accepts boolean schema (primitives are inherently frozen)", () => {
    const sah = new SchemaAndHash(true, HASH_A);
    expect(sah.schema).toBe(true);
  });
});

describe("hashString getter", () => {
  it("returns a string", () => {
    const sah = new SchemaAndHash(true, HASH_A);
    expect(typeof sah.hashString).toBe("string");
  });

  it("matches hash.toString()", () => {
    const sah = new SchemaAndHash(true, HASH_A);
    expect(sah.hashString).toBe(sah.hash.toString());
  });

  it("different hashes produce different hashStrings", () => {
    const sahA = new SchemaAndHash(true, HASH_A);
    const sahB = new SchemaAndHash(true, HASH_B);
    expect(sahA.hashString).not.toBe(sahB.hashString);
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
