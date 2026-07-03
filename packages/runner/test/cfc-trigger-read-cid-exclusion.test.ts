import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

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
  const document = storageManager.open(signer.did()).replica.getDocument(
    id as `${string}:${string}`,
  ) as { cfc?: { labelMap?: { entries: StoredEntry[] } } } | undefined;
  return document?.cfc?.labelMap?.entries ?? [];
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

      // Derivation layer: the state itself is sealed (getCfcState() is a
      // read-only view, #4517), so smuggling by mutating it now throws —
      // that seals the external construction path this test used to
      // simulate.
      expect(() => {
        Reflect.apply(
          Array.prototype.push,
          tx.getCfcState().triggerReads,
          [{
            space: signer.did(),
            id: cidId,
            scope: "space",
            path: ["secret"],
          }],
        );
      }).toThrow("read-only");
      // The guard still matters for INTERNAL construction paths that might
      // bypass the ingest filter, so exercise it directly: hand
      // deriveFlowJoin a state carrying the smuggled canonical entry via a
      // delegating wrapper tx (methods bound to the real tx so its
      // ES-private state keeps working).
      const smuggledState = {
        ...tx.getCfcState(),
        triggerReads: [
          ...tx.getCfcState().triggerReads,
          {
            space: signer.did(),
            id: cidId,
            scope: "space",
            path: ["secret"],
          },
        ],
      };
      const smuggledTx = new Proxy(tx, {
        get(target, prop) {
          if (prop === "getCfcState") return () => smuggledState;
          const member = Reflect.get(target, prop, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      }) as IExtendedStorageTransaction;
      const join = deriveFlowJoin(smuggledTx);
      // The legitimate trigger's label joins; the poisoned cid: one is
      // skipped by the derivation-side guard.
      expect(join.confidentiality).toContainEqual("secret");
      expect(join.confidentiality).not.toContainEqual("cid-secret");

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
