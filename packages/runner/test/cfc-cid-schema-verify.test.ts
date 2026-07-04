import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { loadSchemaDocument } from "../src/cfc/prepare.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// Regression guard for cid: schema-document content-address verification (S5).
//
// cid:<hash> schema documents are content-addressed but stored on an unverified
// write path any same-space writer can reach. The loaded schema drives label
// derivation for other principals' writes, so loadSchemaDocument must re-derive
// the canonical hash and reject a value that does not match its address.
const space = "did:key:cid-verify" as const;

const fakeTxReturning = (
  stored: JSONSchema,
): Pick<IExtendedStorageTransaction, "readOrThrow"> => ({
  readOrThrow: () => ({ value: stored }),
});

describe("cid schema document verification", () => {
  it("returns the schema when its content matches the address", () => {
    const { schema, taggedHashString } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    const result = loadSchemaDocument(
      fakeTxReturning(schema),
      space,
      taggedHashString,
    );
    expect(result).toEqual(schema);
  });

  it("throws when the stored content does not hash to the address (poisoned)", () => {
    const { taggedHashString } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    // A different schema served at the same cid: address.
    const poisoned = internSchema(
      { type: "string", ifc: { confidentiality: [] } } as JSONSchema,
      true,
    ).schema;
    expect(() =>
      loadSchemaDocument(fakeTxReturning(poisoned), space, taggedHashString)
    ).toThrow(/hash mismatch/);
  });
});
