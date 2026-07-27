import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// `loadStoredCfcEnvelope` is the ONE gatherer of a document's stored CFC
// schema envelope: the commit path's merge loop in `prepareCfc` and the
// `cf piece setsrc --check` preflight both call it, so its three outcomes ARE
// the shared failure taxonomy. In particular `unreadable` (metadata exists,
// envelope cannot be loaded) must stay a distinct, surfaced state: the commit
// records it as a rejection reason, and a preflight that mistook it for "no
// envelope" would green-light an update the real commit then refuses — the
// false-COMPATIBLE class this function exists to prevent.

const space = "did:key:stored-envelope" as const;

const fakeTx = (
  documents: Record<string, unknown>,
): IExtendedStorageTransaction =>
  ({
    readOrThrow: (target: { id: string }) => documents[target.id],
  }) as unknown as IExtendedStorageTransaction;

const target = { space, id: "of:doc", scope: "space" } as const;

const metadataNaming = (schemaHash: string) => ({
  cfc: {
    version: 1,
    schemaHash,
    labelMap: { version: 1, entries: [] },
  },
});

describe("loadStoredCfcEnvelope", () => {
  it("reports a document with no stored metadata as none", () => {
    expect(loadStoredCfcEnvelope(fakeTx({ "of:doc": { value: 1 } }), target))
      .toEqual({ status: "none" });
  });

  it("loads and verifies the envelope the metadata names", () => {
    const { schema, taggedHashString } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    const result = loadStoredCfcEnvelope(
      fakeTx({
        "of:doc": metadataNaming(taggedHashString),
        [`cid:${taggedHashString}`]: { value: schema },
      }),
      target,
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
      fakeTx({ "of:doc": metadataNaming("missing-hash") }),
      target,
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
    // A different schema served at the claimed cid: address (audit S5).
    const poisoned = internSchema(
      { type: "string", ifc: { confidentiality: [] } } as JSONSchema,
      true,
    ).schema;
    const result = loadStoredCfcEnvelope(
      fakeTx({
        "of:doc": metadataNaming(taggedHashString),
        [`cid:${taggedHashString}`]: { value: poisoned },
      }),
      target,
    );

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("hash mismatch");
    }
  });
});
