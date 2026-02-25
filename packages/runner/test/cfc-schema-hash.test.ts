import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "../src/builder/types.ts";
import { computeCfcSchemaHash } from "../src/cfc/schema-hash.ts";

describe("computeCfcSchemaHash", () => {
  it("is stable for semantically identical schemas", async () => {
    const schemaA: JSONSchema = {
      type: "object",
      required: ["a", "b"],
      properties: {
        b: { type: "number" },
        a: { type: "string", ifc: { classification: ["secret"] } },
      },
      ifc: { classification: ["secret"] },
    };

    const schemaB: JSONSchema = {
      ifc: { classification: ["secret"] },
      properties: {
        a: { ifc: { classification: ["secret"] }, type: "string" },
        b: { type: "number" },
      },
      required: ["a", "b"],
      type: "object",
    };

    const hashA = await computeCfcSchemaHash(schemaA);
    const hashB = await computeCfcSchemaHash(schemaB);
    expect(hashA).toBe(hashB);
  });

  it("changes when schema changes", async () => {
    const schemaA: JSONSchema = {
      type: "object",
      properties: { value: { type: "number" } },
    };
    const schemaB: JSONSchema = {
      type: "object",
      properties: { value: { type: "string" } },
    };

    const hashA = await computeCfcSchemaHash(schemaA);
    const hashB = await computeCfcSchemaHash(schemaB);
    expect(hashA).not.toBe(hashB);
  });
});
