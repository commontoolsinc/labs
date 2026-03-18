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

  it("treats legacy and normalized IFC label encodings as the same schema", async () => {
    const legacySchema: JSONSchema = {
      type: "object",
      properties: {
        value: {
          type: "number",
          ifc: { classification: ["secret"] },
        },
      },
      ifc: { classification: ["secret"] },
    };
    const normalizedSchema: JSONSchema = {
      type: "object",
      properties: {
        value: {
          type: "number",
          ifc: { classification: [["secret"]] },
        },
      },
      ifc: { classification: [["secret"]] },
    };

    const legacyHash = await computeCfcSchemaHash(legacySchema);
    const normalizedHash = await computeCfcSchemaHash(normalizedSchema);
    expect(legacyHash).toBe(normalizedHash);
  });

  it("allows repeated shared object references without treating them as cycles", async () => {
    const sharedDeviceAtom = {
      type: "https://commonfabric.org/cfc/atom/DeviceIdentity",
      device: "did:key:alice-phone-1",
    } as const;
    const schema = {
      type: "string",
      ifc: {
        declassify: {
          confidentialityPre: [sharedDeviceAtom],
          integrityPre: [sharedDeviceAtom],
          removeMatchedClauses: true,
          postCondition: {
            confidentiality: [{
              type: "https://commonfabric.org/cfc/atom/User",
              subject: "did:key:alice",
            }],
          },
          releaseCondition: true,
        },
      },
    } as const satisfies JSONSchema;

    await expect(computeCfcSchemaHash(schema)).resolves.toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
