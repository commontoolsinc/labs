import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { isOrClause } from "../src/cfc/clause.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-clause-authoring");

// Epic A4 (docs/plans/cfc-future-work-implementation.md): authors may write
// disjunctive confidentiality clauses (`{anyOf:[…]}`) in schema
// `ifc.confidentiality`. Principal-like alternatives persist intact; Expires /
// Caveat alternatives are rejected fail-closed (spec §3.1.8).

const userA = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "did",
  subject: "did:key:alice",
};
const userB = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "did",
  subject: "did:key:bob",
};

describe("CFC authored disjunctive confidentiality", () => {
  it("persists a principal-like OR-clause intact", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const schema = {
        type: "string",
        ifc: { confidentiality: [{ anyOf: [userB, userA] }] },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "authored-or", schema, tx);
      cell.set("participant-readable");
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const readTx = runtime.edit();
      const metadata = readStoredCfcMetadata(readTx, {
        space: signer.did(),
        id: runtime.getCell(signer.did(), "authored-or", schema, readTx)
          .getAsNormalizedFullLink().id,
      });
      readTx.commit();

      const conf = (metadata?.labelMap.entries ?? []).flatMap(
        (entry) => entry.label.confidentiality ?? [],
      );
      const orClause = conf.find(isOrClause) as
        | { anyOf: unknown[] }
        | undefined;
      expect(orClause).toBeDefined();
      // The wire form is preserved (a clause-unaware reader sees one opaque
      // object, never a flattened atom list) and canonically ordered.
      expect(orClause!.anyOf).toHaveLength(2);
      expect(orClause!.anyOf).toContainEqual(userA);
      expect(orClause!.anyOf).toContainEqual(userB);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a Caveat alternative fail-closed (spec §3.1.8)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const caveat = {
        type: "https://commonfabric.org/cfc/atom/Caveat",
        kind: "https://commonfabric.org/cfc/concepts/prompt-injection-risk",
        source: userA,
      };
      const schema = {
        type: "string",
        ifc: { confidentiality: [{ anyOf: [userA, caveat] }] },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "authored-caveat", schema, tx);
      cell.set("bad");
      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit();
      expect(result.error?.message).toContain("OR-clause alternative");
      expect(result.error?.message).toContain("Caveat");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects an Expires alternative fail-closed", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const expires = {
        type: "https://commonfabric.org/cfc/atom/Expires",
        timestamp: 1781000000,
      };
      const schema = {
        type: "string",
        ifc: { confidentiality: [{ anyOf: [userA, expires] }] },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "authored-expires",
        schema,
        tx,
      );
      cell.set("bad");
      expect(tx.prepareCfc()).toBe("");
      const result = await tx.commit();
      expect(result.error?.message).toContain("OR-clause alternative");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
