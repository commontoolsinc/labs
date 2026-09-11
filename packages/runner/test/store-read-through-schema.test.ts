import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { EntityDocument } from "@commonfabric/memory/v2";

import { decomposeSchema } from "../src/schema-decompose.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { URI } from "../src/storage/interface.ts";

const schema = {
  type: "object",
  properties: { leaf: { $ref: "#/$defs/Leaf" } },
  $defs: {
    Leaf: { type: "object", properties: { text: { type: "string" } } },
  },
} as const;

describe("store read-through schema metadata", () => {
  for (const contentAddressed of [false, true]) {
    it(`loads and refreshes metadata dependencies for ${contentAddressed ? "content-addressed" : "ordinary"} documents`, async () => {
      const signer = await Identity.fromPassphrase("metadata read through");
      const manager = StorageManager.emulate({ as: signer });
      const decomposed = decomposeSchema(schema);
      const value = { leaf: { text: "present" } };
      const id = (contentAddressed
        ? `cid:${taggedHashStringOf(value)}`
        : "of:metadata-carrier") as URI;
      const carrier = { value, schema: { $ref: decomposed.rootRef } };
      const docs = new Map<string, EntityDocument>([
        [id, carrier],
        ...[...decomposed.documents].map(([hash, document]) =>
          [`cid:${hash}`, { value: document }] as [string, EntityDocument]
        ),
      ]);
      const reads: string[] = [];
      let seq = 1;
      try {
        manager.installStoreReadThrough(signer.did(), ({ id, scopeKey }) => {
          reads.push(id);
          const doc = docs.get(id);
          return {
            branch: "",
            id,
            scope: "space",
            scopeKey,
            ...(doc === undefined
              ? { seq: 0, deleted: true as const }
              : { seq, doc }),
          };
        });
        const replica = manager.open(signer.did()).replica;
        expect(replica.getDocument(id)).toEqual(carrier);
        expect(reads).toHaveLength(1 + decomposed.documents.size);
        for (const [hash, document] of decomposed.documents) {
          expect(replica.getDocument(`cid:${hash}` as URI)?.value)
            .toEqual(document);
        }

        const updated = decomposeSchema({ ...schema, description: "updated" });
        const updatedCarrier = { value, schema: { $ref: updated.rootRef } };
        docs.set(id, updatedCarrier);
        for (const [hash, document] of updated.documents) {
          docs.set(`cid:${hash}`, { value: document });
        }
        seq++;
        reads.length = 0;
        expect(manager.integrateStoreWrites(signer.did(), [{
          id,
          scopeKey: "space",
        }])).toBe(1);
        expect(replica.getDocument(id)).toEqual(updatedCarrier);
        expect(reads).toContain(updated.rootRef);
      } finally {
        await manager.close();
      }
    });
  }

  it("quarantines malformed metadata on an initial read", async () => {
    const signer = await Identity.fromPassphrase(
      "malformed metadata read through",
    );
    const manager = StorageManager.emulate({ as: signer });
    const { rootRef } = decomposeSchema(schema);
    try {
      manager.installStoreReadThrough(signer.did(), ({ id, scopeKey }) => ({
        branch: "",
        id,
        scope: "space",
        scopeKey,
        seq: 1,
        doc: { value: "invalid", schema: { $ref: rootRef, type: "object" } },
      }));
      const replica = manager.open(signer.did()).replica;
      expect(replica.getDocument("of:malformed-carrier" as URI))
        .toBeUndefined();
    } finally {
      await manager.close();
    }
  });

  it("keeps a malformed refresh from blocking valid sibling documents", async () => {
    const signer = await Identity.fromPassphrase("mixed metadata read through");
    const manager = StorageManager.emulate({ as: signer });
    const invalidId = "of:malformed-carrier" as URI;
    const validId = "of:valid-carrier" as URI;
    const original = { value: "original" };
    const { rootRef } = decomposeSchema(schema);
    const docs = new Map<string, EntityDocument>([
      [invalidId, original],
      [validId, original],
    ]);
    let seq = 1;
    try {
      manager.installStoreReadThrough(signer.did(), ({ id, scopeKey }) => ({
        branch: "",
        id,
        scope: "space",
        scopeKey,
        seq,
        doc: docs.get(id)!,
      }));
      const replica = manager.open(signer.did()).replica;
      expect(replica.getDocument(invalidId)).toEqual(original);
      expect(replica.getDocument(validId)).toEqual(original);
      docs.set(invalidId, {
        value: "invalid",
        schema: { $ref: rootRef, type: "object" },
      });
      const updated = { value: "updated" };
      docs.set(validId, updated);
      seq++;
      expect(manager.integrateStoreWrites(signer.did(), [
        { id: invalidId, scopeKey: "space" },
        { id: validId, scopeKey: "space" },
      ])).toBe(2);
      expect(replica.getDocument(invalidId)).toEqual(original);
      expect(replica.getDocument(validId)).toEqual(updated);
    } finally {
      await manager.close();
    }
  });
});
