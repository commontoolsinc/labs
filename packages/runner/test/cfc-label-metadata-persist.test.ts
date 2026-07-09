import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-label-metadata");

// Inv-12 Stage 0 (SC-14/SC-25 prerequisite; docs/specs/
// cfc-label-metadata-confidentiality.md §3): the carried `cfcLabelView` on a
// link write round-trips through the main thread (worker →
// `CellHandle.deserialize` → `mapCellRefsToSigilLinks` → worker) and is
// main-thread-influenceable. `prepareBoundaryCommit` must therefore treat an
// inbound view as an untrusted display artifact and persist link-origin
// labels from the worker-authoritative source — the link source's STORED
// label map — so a tampered/redacted/incomplete view cannot WEAKEN what the
// stored metadata provides (the round-trip hazard confirmed on the labs#4622
// review thread: response-side redaction would otherwise persist redacted,
// under-labeled views on copy-forward writes).
describe("CFC persist-seam link-label re-derivation (inv-12 Stage 0)", () => {
  type PersistedEntry = {
    path: string[];
    origin?: string;
    label: {
      confidentiality?: unknown[];
      integrity?: Array<{ type?: string }>;
    };
  };

  const setup = async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });

    // Seed a source doc whose STORED cfc metadata is the authoritative label
    // state: a root clause plus a sub-path entry carrying a full Caveat (with
    // its `source` identity). Tests seed stored ["cfc"] metadata via an
    // ungated path-[] full-document write (the same shape hydration
    // delivers).
    const sourceId = parseLink(
      runtime.getCell(signer.did(), "cfc-rederive-source").getAsLink(),
    ).id!;
    const fullCaveat = cfcAtom.caveat("derived-from", "did:key:alice");
    const seed = runtime.edit();
    seed.writeOrThrow({
      space: signer.did(),
      scope: "space",
      id: sourceId,
      path: [],
    }, {
      value: { secret: "classified", plain: "public" },
      cfc: {
        version: 1,
        schemaHash: "seed-schema",
        labelMap: {
          version: 1,
          entries: [
            { path: [], label: { confidentiality: ["source-root"] } },
            { path: ["secret"], label: { confidentiality: [fullCaveat] } },
          ],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();

    return { storageManager, runtime, sourceId, fullCaveat };
  };

  const persistedEntriesFor = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ): PersistedEntry[] => {
    const replica = storageManager.open(signer.did()).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: PersistedEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const commitLinkWrite = async (
    runtime: Runtime,
    sourceId: string,
    cfcLabelView: {
      version: 1;
      entries: Array<
        { path: string[]; label: { confidentiality?: unknown[] } }
      >;
    },
  ) => {
    const tx = runtime.edit();
    const target = runtime.getCell(
      signer.did(),
      "cfc-rederive-target",
      undefined,
      tx,
    );
    const targetId = target.getAsNormalizedFullLink().id;
    tx.markCfcRelevant("test");
    tx.writeValueOrThrow({
      space: signer.did(),
      scope: "space",
      id: targetId,
      path: ["value", "field"],
    }, "v");
    // The link-write policy input a round-tripped write records: the source
    // address is authoritative (derived from the sigil link itself), but the
    // carried view is whatever the main thread handed back.
    tx.recordCfcWritePolicyInput({
      kind: "link-write",
      target: {
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["value", "field"],
      },
      source: {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      },
      cfcLabelView,
    });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return parseLink(target.getAsLink()).id!;
  };

  it("persists the stored sub-path entry a tampered view dropped", async () => {
    const { storageManager, runtime, sourceId, fullCaveat } = await setup();
    try {
      // Round-tripped view with the ["secret"] entry (its whole clause)
      // dropped — the weakening the inbound view must not be able to cause.
      const persistedId = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [
          { path: [], label: { confidentiality: ["source-root"] } },
        ],
      });

      const entries = persistedEntriesFor(storageManager, persistedId);
      const secretEntry = entries.find((entry) =>
        entry.path.join("/") === "field/secret" && entry.origin === "link"
      );
      // Re-derived from the source's stored label map, independent of the
      // carried view: the full caveat (with `source`) must be persisted.
      expect(secretEntry).toBeDefined();
      expect(secretEntry!.label.confidentiality).toContainEqual(fullCaveat);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the full caveat when the view carries a redacted copy", async () => {
    const { storageManager, runtime, sourceId, fullCaveat } = await setup();
    try {
      // Round-tripped view whose caveat lost its `source` — exactly what a
      // display-redacted view (redactCaveatSourcesForDisplay) looks like
      // after a main-thread round trip.
      const redactedCaveat = {
        type: CFC_ATOM_TYPE.Caveat,
        kind: "derived-from",
      };
      const persistedId = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [
          { path: [], label: { confidentiality: ["source-root"] } },
          { path: ["secret"], label: { confidentiality: [redactedCaveat] } },
        ],
      });

      const entries = persistedEntriesFor(storageManager, persistedId);
      const secretEntries = entries.filter((entry) =>
        entry.path.join("/") === "field/secret" && entry.origin === "link"
      );
      const atoms = secretEntries.flatMap((entry) =>
        entry.label.confidentiality ?? []
      );
      // The authoritative stored atom wins outright: the persisted entry
      // carries the caveat WITH its source, no matter what the view dropped.
      expect(atoms).toContainEqual(fullCaveat);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps re-derived link labels under the runtime-evidence mint gate", async () => {
    // The re-derived entries take the same gate as carried ones (audit S4):
    // a non-builtin link write must not re-mint runtime evidence atoms at
    // the target, even when they come from the source's stored metadata.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const sourceId = parseLink(
        runtime.getCell(signer.did(), "cfc-rederive-evidence-source")
          .getAsLink(),
      ).id!;
      const seed = runtime.edit();
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { attested: "x" },
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["attested"],
              label: {
                integrity: [{ type: CFC_ATOM_TYPE.InjectionSafe }],
              },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-rederive-evidence-target",
        undefined,
        tx,
      );
      const targetId = target.getAsNormalizedFullLink().id;
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["value", "field"],
      }, "v");
      tx.recordCfcWritePolicyInput({
        kind: "link-write",
        target: {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "field"],
        },
        source: {
          space: signer.did(),
          scope: "space",
          id: sourceId,
          path: [],
        },
      });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(target.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: { integrity?: Array<{ type?: string }> };
              }>;
            };
          };
        } | undefined;
      };
      const entries =
        replica.getDocument(persistedId)?.cfc?.labelMap?.entries ?? [];
      const allIntegrity = entries.flatMap((e) => e.label.integrity ?? []);
      expect(
        allIntegrity.some((a) => a?.type?.endsWith("/InjectionSafe")),
      ).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
