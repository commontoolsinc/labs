import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import {
  loadSchemaDocument,
  loadStoredCfcEnvelope,
} from "../src/cfc/prepare.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// Regression guard for cid: schema-document content-address verification (S5).
//
// cid:<hash> schema documents are content-addressed but stored on an unverified
// write path any same-space writer can reach. The loaded schema drives label
// derivation for other principals' writes, so loadSchemaDocument must re-derive
// the canonical hash and reject a value that does not match its address.
const space = "did:key:cid-verify" as const;

const fakeTxReturning = (stored: JSONSchema): IExtendedStorageTransaction =>
  ({
    readOrThrow: () => ({ value: stored }),
  }) as unknown as IExtendedStorageTransaction;

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

// `loadStoredCfcEnvelope` is the ONE gatherer of a document's stored CFC schema
// envelope: the commit path's merge loop and the `cf piece setsrc --check`
// preflight both call it, so its three outcomes ARE the shared failure
// taxonomy. `unreadable` in particular has to stay its own state — the commit
// records it as a rejection reason and refuses the write, so a caller that
// mistook it for "no envelope" would green-light an update the real commit
// then rejects.
const fakeTxOverDocuments = (
  documents: Record<string, unknown>,
): IExtendedStorageTransaction =>
  ({
    // Honors the read PATH like the real transaction (the stored-metadata
    // read is scoped to ["cfc"] — a path-blind stub would hand a whole
    // document to a subtree read and misreport "no metadata" as a
    // malformed envelope).
    readOrThrow: (target: { id: string; path?: readonly string[] }) => {
      let value: unknown = documents[target.id];
      for (const segment of target.path ?? []) {
        if (value === null || typeof value !== "object") return undefined;
        value = (value as Record<string, unknown>)[segment];
      }
      return value;
    },
  }) as unknown as IExtendedStorageTransaction;

const envelopeTarget = { space, id: "of:doc", scope: "space" } as const;

const metadataNaming = (schemaHash: string) => ({
  cfc: { version: 1, schemaHash, labelMap: { version: 1, entries: [] } },
});

describe("stored CFC envelope gathering", () => {
  it("reports a document with no stored metadata as none", () => {
    expect(
      loadStoredCfcEnvelope(
        fakeTxOverDocuments({ "of:doc": { value: 1 } }),
        envelopeTarget,
      ),
    ).toEqual({ status: "none" });
  });

  it("loads and verifies the envelope the metadata names", () => {
    const { schema, taggedHashString } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({
        "of:doc": metadataNaming(taggedHashString),
        [`cid:${taggedHashString}`]: { value: schema },
      }),
      envelopeTarget,
    );

    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(result.schema).toEqual(schema);
      // The metadata rides along for the commit path, which also needs the
      // stored label map.
      expect(result.metadata.schemaHash).toBe(taggedHashString);
    }
  });

  it("reports a missing envelope document as unreadable, not as none", () => {
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({ "of:doc": metadataNaming("missing-hash") }),
      envelopeTarget,
    );

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("missing or unreadable");
    }
  });

  it("reports a poisoned envelope document as unreadable", () => {
    const { taggedHashString } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    const poisoned = internSchema(
      { type: "string", ifc: { confidentiality: [] } } as JSONSchema,
      true,
    ).schema;
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({
        "of:doc": metadataNaming(taggedHashString),
        [`cid:${taggedHashString}`]: { value: poisoned },
      }),
      envelopeTarget,
    );

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("hash mismatch");
    }
  });
});
