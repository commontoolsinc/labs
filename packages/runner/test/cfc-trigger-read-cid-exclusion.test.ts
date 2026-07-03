import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-trigger-cid");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): StoredEntry[] => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      cfc?: { labelMap?: { entries: StoredEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
};

// §8.9.2 trigger reads name runtime-surface documents only by accident or
// forgery: `addCfcTriggerReads` drops them at ingest (`flowReadExcluded` on
// the raw notification path), and `forEachFlowObservation` keeps an id-based
// `cid:` skip as defense in depth for entries that arrive by other
// construction paths. That second layer matters because `cid:` schema docs
// live on an unverified write path any same-space writer can reach (audit
// S5): a poisoned labelMap on one must not join the flow derivation through
// a smuggled trigger entry.
describe("CFC trigger reads: cid: exclusion", () => {
  it("keeps cid: trigger reads out of the flow derivation even when they bypass ingest filtering", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    try {
      // A legitimately labeled user doc — its trigger read SHOULD join, which
      // proves the derivation machinery ran (the cid: assertion below is not
      // vacuously green).
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-trigger-cid-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      // A cid: doc carrying a labelMap — writable by any same-space
      // principal, so its label is attacker-controlled and must stay out of
      // flow joins.
      const cidId = "cid:trigger-read-poison" as typeof sourceId;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: cidId,
        path: [],
      }, {
        value: { secret: "poisoned" },
        cfc: {
          version: 1,
          schemaHash: "poison-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["cid-secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      // Ingest layer: `addCfcTriggerReads` drops the cid: address, keeps the
      // user doc's.
      tx.addCfcTriggerReads([
        {
          space: signer.did(),
          id: sourceId,
          type: "application/json",
          path: ["value", "secret"],
        },
        {
          space: signer.did(),
          id: cidId,
          type: "application/json",
          path: ["value", "secret"],
        },
      ]);
      expect(tx.getCfcState().triggerReads.length).toBe(1);
      expect(tx.getCfcState().triggerReads[0].id).toBe(sourceId);

      // Derivation layer: smuggle a cid: trigger entry past ingest, the way
      // a divergent construction path (or a bug in one) would. Stored
      // entries are canonical, so push the canonical form.
      (tx.getCfcState().triggerReads as unknown as {
        space: string;
        id: string;
        scope: string;
        path: string[];
      }[]).push({
        space: signer.did(),
        id: cidId,
        scope: "space",
        path: ["secret"],
      });

      // The transaction reads nothing — only the triggers connect it to the
      // labeled docs.
      const out = runtime.getCell(
        signer.did(),
        "cfc-trigger-cid-out",
        undefined,
        tx,
      );
      out.set({ flag: 1 });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const outId = out.getAsNormalizedFullLink().id;
      const entries = replicaEntries(storageManager, outId);
      const derived = entries.find((e) => e.origin === "derived");
      // The legitimate trigger joined…
      expect(derived).toBeDefined();
      expect(derived!.label.confidentiality).toContainEqual("secret");
      // …the poisoned cid: trigger did not — on ANY entry of the out doc.
      for (const entry of entries) {
        expect(entry.label.confidentiality ?? []).not.toContainEqual(
          "cid-secret",
        );
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
