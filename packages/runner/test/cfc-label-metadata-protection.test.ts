import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { CfcLabelMetadataProtectionMode } from "../src/cfc/mod.ts";
import {
  commitCfcFieldValue,
  containsCfcFieldCommitment,
} from "../src/cfc/label-representation.ts";
import { stampExternalIngest } from "../src/cfc/external-ingest.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-label-metadata-protection",
);
const foreignSigner = await Identity.fromPassphrase(
  "runner-cfc-label-metadata-protection-foreign",
);
// The destination space (`spaceB`) and the foreign source space (`spaceA`).
const spaceB = signer.did();
const spaceA = foreignSigner.did();

type PersistedEntry = {
  path: string[];
  origin?: string;
  observes?: string;
  label: {
    confidentiality?: unknown[];
    integrity?: Array<Record<string, unknown>>;
  };
};

// Inv-12 Stage 1 (SC-25; docs/specs/cfc-label-metadata-confidentiality.md
// §2/§5; spec §4.6.4.1 "Cross-space derived labels"): at the cross-space
// persist seam, prepareBoundaryCommit applies the classification table to
// every source-bearing atom field of entries whose observations originate
// OUTSIDE the destination space — link-origin entries whose link source
// lives in another space (including the carried sigil `cfcLabelView`
// entries, the in-value copy) and flow-derived entries whose join consumed a
// labeled foreign observation. Same-space-only labels persist verbatim.
// Behind `cfcLabelMetadataProtection: off | observe | enforce`.
describe("CFC cross-space label-metadata persist transform (inv-12 Stage 1)", () => {
  const fullSource = { space: spaceA, id: "of:remote-origin", path: [] };
  const caveatAtom = {
    type: CFC_ATOM_TYPE.Caveat,
    kind: "derived-from",
    source: fullSource,
  };
  const userAtom = { type: CFC_ATOM_TYPE.User, subject: "did:key:alice" };

  const makeRuntime = (
    mode: CfcLabelMetadataProtectionMode | undefined,
    extra: { cfcFlowLabels?: "off" | "observe" | "persist" } = {},
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      ...(mode !== undefined ? { cfcLabelMetadataProtection: mode } : {}),
      ...(extra.cfcFlowLabels !== undefined
        ? { cfcFlowLabels: extra.cfcFlowLabels }
        : {}),
    });
    return { storageManager, runtime };
  };

  const persistedEntriesFor = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    space: MemorySpace,
    id: string,
  ): PersistedEntry[] => {
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: PersistedEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  // Seed a source doc in `sourceSpace` whose STORED cfc metadata carries a
  // root User clause and a sub-path Caveat entry (the authoritative label
  // state the link machinery re-derives from).
  const seedSource = async (
    runtime: Runtime,
    sourceSpace: MemorySpace,
    name: string,
  ): Promise<string> => {
    const seed = runtime.edit();
    const sourceId = parseLink(
      runtime.getCell(sourceSpace, name, undefined, seed).getAsLink(),
    ).id!;
    seed.writeOrThrow({
      space: sourceSpace,
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
            { path: [], label: { confidentiality: [userAtom] } },
            { path: ["secret"], label: { confidentiality: [caveatAtom] } },
          ],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
    return sourceId;
  };

  // One cross-space (or same-space) link write: a value write in the target
  // space plus the link-write policy input naming the seeded source, with a
  // carried `cfcLabelView` (the in-value sigil copy) that ADDS a sub-path
  // entry beyond the stored metadata.
  const commitLinkWrite = async (
    runtime: Runtime,
    sourceSpace: MemorySpace,
    sourceId: string,
    targetName: string,
  ): Promise<{ targetId: string; tx: ReturnType<Runtime["edit"]> }> => {
    const tx = runtime.edit();
    const target = runtime.getCell(spaceB, targetName, undefined, tx);
    const targetId = target.getAsNormalizedFullLink().id;
    tx.markCfcRelevant("test");
    tx.writeValueOrThrow({
      space: spaceB,
      scope: "space",
      id: targetId,
      path: ["value", "field"],
    }, "v");
    tx.recordCfcWritePolicyInput({
      kind: "link-write",
      target: {
        space: spaceB,
        scope: "space",
        id: targetId,
        path: ["value", "field"],
      },
      source: {
        space: sourceSpace,
        scope: "space",
        id: sourceId,
        path: [],
      },
      cfcLabelView: {
        version: 1,
        entries: [{
          // The carried in-value copy adds an entry the stored metadata
          // does not have — it must get the SAME transform (one transform,
          // two sinks).
          path: ["carriedOnly"],
          label: { confidentiality: [userAtom] },
        }, {
          // An eligible entry with NOTHING classified (string atom):
          // pins the transform's nothing-to-commit passthrough arm.
          path: ["stringOnly"],
          label: { confidentiality: ["opaque-tag"] },
        }],
      },
    });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return { targetId, tx };
  };

  const entryAt = (
    entries: PersistedEntry[],
    path: string[],
  ): PersistedEntry | undefined =>
    entries.find((entry) =>
      entry.path.length === path.length &&
      entry.path.every((seg, i) => seg === path[i])
    );

  describe("enforce", () => {
    it("persists committed fields for a cross-space link write (both label sources)", async () => {
      const { storageManager, runtime } = makeRuntime("enforce");
      try {
        const sourceId = await seedSource(runtime, spaceA, "xspace-source");
        const { targetId } = await commitLinkWrite(
          runtime,
          spaceA,
          sourceId,
          "xspace-target",
        );
        const entries = persistedEntriesFor(storageManager, spaceB, targetId);
        const linkEntries = entries.filter((e) => e.origin === "link");
        expect(linkEntries.length).toBeGreaterThan(0);

        // The direct source-path label: the root User clause committed.
        const rootEntry = entryAt(linkEntries, ["field"]);
        expect(rootEntry).toBeDefined();
        expect(rootEntry!.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue("did:key:alice"),
        });
        // The runtime-minted LinkReference provenance atom: source/target
        // committed per the table (display/provenance only).
        const linkRef = rootEntry!.label.integrity?.find((atom) =>
          atom.type === CFC_ATOM_TYPE.LinkReference
        );
        expect(linkRef).toBeDefined();
        expect(linkRef!.source).toEqual(
          commitCfcFieldValue({
            space: spaceA,
            id: sourceId,
            path: [],
          }),
        );

        // The re-derived label VIEW (the sigil cfcLabelView first copy):
        // the source's sub-path Caveat entry, source committed.
        const secretEntry = entryAt(linkEntries, ["field", "secret"]);
        expect(secretEntry).toBeDefined();
        expect(secretEntry!.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.Caveat,
          kind: "derived-from",
          source: commitCfcFieldValue(fullSource),
        });

        // The CARRIED view (the in-value sigil copy) gets the same
        // transform: its added entry persists committed.
        const carriedEntry = entryAt(linkEntries, ["field", "carriedOnly"]);
        expect(carriedEntry).toBeDefined();
        expect(carriedEntry!.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue("did:key:alice"),
        });
        // An eligible entry with nothing classified persists verbatim (the
        // transform's copy-on-write passthrough).
        const stringEntry = entryAt(linkEntries, ["field", "stringOnly"]);
        expect(stringEntry).toBeDefined();
        expect(stringEntry!.label.confidentiality).toContainEqual(
          "opaque-tag",
        );

        // No plaintext DID survives anywhere in the persisted entries'
        // committed families.
        expect(JSON.stringify(entries)).not.toContain("did:key:alice");
      } finally {
        await runtime.dispose();
      }
    });

    it("persists a same-space link write verbatim (nothing foreign to protect)", async () => {
      const { storageManager, runtime } = makeRuntime("enforce");
      try {
        const sourceId = await seedSource(runtime, spaceB, "same-source");
        const { targetId } = await commitLinkWrite(
          runtime,
          spaceB,
          sourceId,
          "same-target",
        );
        const entries = persistedEntriesFor(storageManager, spaceB, targetId);
        const linkEntries = entries.filter((e) => e.origin === "link");
        expect(linkEntries.length).toBeGreaterThan(0);
        const rootEntry = entryAt(linkEntries, ["field"]);
        expect(rootEntry!.label.confidentiality).toContainEqual(userAtom);
        const secretEntry = entryAt(linkEntries, ["field", "secret"]);
        expect(secretEntry!.label.confidentiality).toContainEqual(caveatAtom);
        expect(containsCfcFieldCommitment(entries)).toBe(false);
      } finally {
        await runtime.dispose();
      }
    });

    it("re-deriving a transformed envelope is a no-op (SC-11 post-transform idempotence)", async () => {
      const { storageManager, runtime } = makeRuntime("enforce");
      try {
        const sourceId = await seedSource(runtime, spaceA, "sc11-source");
        const { targetId } = await commitLinkWrite(
          runtime,
          spaceA,
          sourceId,
          "sc11-target",
        );
        const after1 = persistedEntriesFor(storageManager, spaceB, targetId);
        expect(containsCfcFieldCommitment(after1)).toBe(true);

        // Recompute: the same link-write input re-derives the same labels
        // from the (plaintext) source metadata. The canonical equality is
        // computed POST-transform, so the recompute must not rewrite the
        // ["cfc"] envelope.
        const tx2 = runtime.edit();
        tx2.markCfcRelevant("test");
        tx2.recordCfcWritePolicyInput({
          kind: "link-write",
          target: {
            space: spaceB,
            scope: "space",
            id: targetId,
            path: ["value", "field"],
          },
          source: {
            space: spaceA,
            scope: "space",
            id: sourceId,
            path: [],
          },
          cfcLabelView: {
            version: 1,
            entries: [{
              path: ["carriedOnly"],
              label: { confidentiality: [userAtom] },
            }],
          },
        });
        tx2.prepareCfc();
        const cfcWrites = [...(tx2.getWriteDetails?.(spaceB) ?? [])].filter(
          (detail) =>
            detail.address.id === targetId &&
            detail.address.path[0] === "cfc",
        );
        expect(cfcWrites).toEqual([]);
        expect((await tx2.commit()).ok).toBeDefined();
        const after2 = persistedEntriesFor(storageManager, spaceB, targetId);
        expect(after2).toEqual(after1);
      } finally {
        await runtime.dispose();
      }
    });

    it("keeps pre-existing verbatim entries while adding committed ones (mixed coexistence)", async () => {
      // The migration scenario: an envelope persisted BEFORE the dial
      // flipped holds verbatim foreign entries; flipping to enforce commits
      // only NEW cross-space entries — no rewrite of the existing ones —
      // and consumers dispatch on the marker shape, so both forms coexist.
      const { storageManager, runtime } = makeRuntime(undefined);
      try {
        const sourceId = await seedSource(runtime, spaceA, "mixed-source");
        const targetName = "mixed-target";
        // tx1 (dial off, the pre-Stage-1 world): a cross-space link write
        // persists VERBATIM foreign entries at ["legacyField"].
        const tx1 = runtime.edit();
        const target = runtime.getCell(spaceB, targetName, undefined, tx1);
        const targetId = target.getAsNormalizedFullLink().id;
        tx1.markCfcRelevant("test");
        tx1.writeValueOrThrow({
          space: spaceB,
          scope: "space",
          id: targetId,
          path: ["value", "legacyField"],
        }, "old");
        tx1.recordCfcWritePolicyInput({
          kind: "link-write",
          target: {
            space: spaceB,
            scope: "space",
            id: targetId,
            path: ["value", "legacyField"],
          },
          source: {
            space: spaceA,
            scope: "space",
            id: sourceId,
            path: [],
          },
        });
        tx1.prepareCfc();
        expect((await tx1.commit()).ok).toBeDefined();

        // tx2: RAISE the dial (raising below the pin is allowed) and add a
        // second cross-space link write at ["field"].
        const tx2 = runtime.edit();
        tx2.setCfcLabelMetadataProtectionMode("enforce");
        tx2.markCfcRelevant("test");
        tx2.writeValueOrThrow({
          space: spaceB,
          scope: "space",
          id: targetId,
          path: ["value", "field"],
        }, "v");
        tx2.recordCfcWritePolicyInput({
          kind: "link-write",
          target: {
            space: spaceB,
            scope: "space",
            id: targetId,
            path: ["value", "field"],
          },
          source: {
            space: spaceA,
            scope: "space",
            id: sourceId,
            path: [],
          },
        });
        tx2.prepareCfc();
        expect((await tx2.commit()).ok).toBeDefined();

        const entries = persistedEntriesFor(storageManager, spaceB, targetId);
        const linkEntries = entries.filter((e) => e.origin === "link");
        // Old verbatim entry carried forward untouched (no envelope
        // rewrite of pre-Stage-1 forms)…
        const legacy = entryAt(linkEntries, ["legacyField"]);
        expect(legacy).toBeDefined();
        expect(legacy!.label.confidentiality).toContainEqual(userAtom);
        // …coexisting with the new committed link entry.
        const fresh = entryAt(linkEntries, ["field"]);
        expect(fresh).toBeDefined();
        expect(fresh!.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue("did:key:alice"),
        });
      } finally {
        await runtime.dispose();
      }
    });

    it("commits flow-derived entries whose join consumed a foreign labeled read", async () => {
      const { storageManager, runtime } = makeRuntime("enforce", {
        cfcFlowLabels: "persist",
      });
      try {
        await seedSource(runtime, spaceA, "flow-source");
        const tx = runtime.edit();
        const source = runtime.getCell(spaceA, "flow-source", undefined, tx);
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("classified");
        const derived = runtime.getCell(spaceB, "flow-derived", undefined, tx);
        derived.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        const derivedId = derived.getAsNormalizedFullLink().id;
        const entries = persistedEntriesFor(storageManager, spaceB, derivedId);
        const flowEntry = entries.find((e) =>
          e.origin === "derived" && e.observes === "value"
        );
        expect(flowEntry).toBeDefined();
        // The foreign User clause landed committed; Space-free plaintext
        // DIDs are gone.
        expect(flowEntry!.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue("did:key:alice"),
        });
        expect(JSON.stringify(entries)).not.toContain("did:key:alice");
      } finally {
        await runtime.dispose();
      }
    });

    it("persists same-space flow-derived entries verbatim", async () => {
      const { storageManager, runtime } = makeRuntime("enforce", {
        cfcFlowLabels: "persist",
      });
      try {
        await seedSource(runtime, spaceB, "flow-same-source");
        const tx = runtime.edit();
        const source = runtime.getCell(
          spaceB,
          "flow-same-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const derived = runtime.getCell(
          spaceB,
          "flow-same-derived",
          undefined,
          tx,
        );
        derived.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        const derivedId = derived.getAsNormalizedFullLink().id;
        const entries = persistedEntriesFor(storageManager, spaceB, derivedId);
        const flowEntry = entries.find((e) => e.origin === "derived");
        expect(flowEntry).toBeDefined();
        expect(flowEntry!.label.confidentiality).toContainEqual(userAtom);
        expect(containsCfcFieldCommitment(entries)).toBe(false);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("observe", () => {
    it("persists verbatim and emits the divergence diagnostic", async () => {
      const { storageManager, runtime } = makeRuntime("observe");
      try {
        const sourceId = await seedSource(runtime, spaceA, "observe-source");
        const { targetId, tx } = await commitLinkWrite(
          runtime,
          spaceA,
          sourceId,
          "observe-target",
        );
        const entries = persistedEntriesFor(storageManager, spaceB, targetId);
        // Verbatim bytes: the plaintext atoms persisted, no markers.
        expect(containsCfcFieldCommitment(entries)).toBe(false);
        const linkEntries = entries.filter((e) => e.origin === "link");
        expect(entryAt(linkEntries, ["field"])!.label.confidentiality)
          .toContainEqual(userAtom);
        // The rollout metric: a structured divergence diagnostic.
        expect(
          tx.getCfcState().diagnostics.some((d) =>
            d.includes("label-metadata-protection(observe)")
          ),
        ).toBe(true);
      } finally {
        await runtime.dispose();
      }
    });

    it("emits no diagnostic for a same-space write (no divergence)", async () => {
      const { runtime } = makeRuntime("observe");
      try {
        const sourceId = await seedSource(runtime, spaceB, "observe-same-src");
        const { tx } = await commitLinkWrite(
          runtime,
          spaceB,
          sourceId,
          "observe-same-target",
        );
        expect(
          tx.getCfcState().diagnostics.some((d) =>
            d.includes("label-metadata-protection(observe)")
          ),
        ).toBe(false);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("off", () => {
    it("persists bytes identical to a runtime without the option", async () => {
      const offRun = makeRuntime("off");
      const defaultRun = makeRuntime(undefined);
      try {
        for (const { runtime } of [offRun, defaultRun]) {
          const sourceId = await seedSource(runtime, spaceA, "off-source");
          await commitLinkWrite(runtime, spaceA, sourceId, "off-target");
        }
        const offTarget = parseLink(
          offRun.runtime.getCell(spaceB, "off-target").getAsLink(),
        ).id!;
        const defaultTarget = parseLink(
          defaultRun.runtime.getCell(spaceB, "off-target").getAsLink(),
        ).id!;
        const offEntries = persistedEntriesFor(
          offRun.storageManager,
          spaceB,
          offTarget,
        );
        const defaultEntries = persistedEntriesFor(
          defaultRun.storageManager,
          spaceB,
          defaultTarget,
        );
        expect(offEntries.length).toBeGreaterThan(0);
        expect(JSON.stringify(offEntries)).toBe(
          JSON.stringify(defaultEntries),
        );
        // And those bytes are the verbatim plaintext form.
        expect(containsCfcFieldCommitment(offEntries)).toBe(false);
        expect(JSON.stringify(offEntries)).toContain("did:key:alice");
      } finally {
        await offRun.runtime.dispose();
        await defaultRun.runtime.dispose();
      }
    });
  });

  it("keeps Space.id plaintext in a committed cross-space entry (§4.9.3)", async () => {
    const { storageManager, runtime } = makeRuntime("enforce");
    try {
      // Source labeled with a Space clause plus a User clause.
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(spaceA, "space-atom-source", undefined, seed)
          .getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: spaceA,
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { shared: "v" },
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [
                  { type: CFC_ATOM_TYPE.Space, id: spaceA },
                  userAtom,
                ],
              },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const { targetId } = await commitLinkWrite(
        runtime,
        spaceA,
        sourceId,
        "space-atom-target",
      );
      const entries = persistedEntriesFor(storageManager, spaceB, targetId);
      const rootEntry = entries.filter((e) => e.origin === "link").find((e) =>
        e.path.length === 1 && e.path[0] === "field"
      );
      expect(rootEntry).toBeDefined();
      // Space.id verbatim — the §4.9.3 ACL point query dereferences it —
      // while the User clause committed.
      expect(rootEntry!.label.confidentiality).toContainEqual({
        type: CFC_ATOM_TYPE.Space,
        id: spaceA,
      });
      expect(rootEntry!.label.confidentiality).toContainEqual({
        type: CFC_ATOM_TYPE.User,
        subject: { digestOf: hashStringOf("did:key:alice") },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("mints the local external-ingest mark verbatim (no cross-space observation feeds it)", async () => {
    const { storageManager, runtime } = makeRuntime("enforce");
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(spaceB, "ingest-target", undefined, tx);
      const targetId = target.getAsNormalizedFullLink().id;
      target.set({ inbox: ["hello"] });
      stampExternalIngest(tx, {
        target: {
          space: spaceB,
          scope: "space",
          id: targetId as never,
          path: [],
        },
        channel: "email",
        audience: "did:key:local-user",
        receivedAt: "2026-07-09T00:00:00Z",
        valueDigest: "digest",
      });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
      const entries = persistedEntriesFor(storageManager, spaceB, targetId);
      const mark = entries.find((e) => e.origin === "external-ingest");
      expect(mark).toBeDefined();
      const atom = mark!.label.integrity?.[0] as Record<string, unknown>;
      expect(atom.audience).toBe("did:key:local-user");
    } finally {
      await runtime.dispose();
    }
  });

  describe("legacy maxConfidentiality fit on committed labels (policy evaluation off)", () => {
    // The default `cfcPolicyEvaluation: "off"` decision path for schema
    // `maxConfidentiality` froze the pre-dial deepEqual membership check. A
    // consumed read whose stored label carries a COMMITTED clause must still
    // fit a plaintext ceiling naming the same principal (digest the
    // candidate and compare — same-form matching), and still reject a
    // ceiling naming someone else (codex/cubic P1 on this PR).
    const seedCommitted = async (runtime: Runtime, name: string) => {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(spaceB, name, undefined, seed).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: spaceB,
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "classified" },
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [{
                  type: CFC_ATOM_TYPE.User,
                  subject: commitCfcFieldValue("did:key:alice"),
                }],
              },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();
    };

    const writeUnderCeiling = async (
      runtime: Runtime,
      sourceName: string,
      targetName: string,
      ceiling: unknown[],
    ) => {
      const tx = runtime.edit();
      const source = runtime.getCell(spaceB, sourceName, undefined, tx);
      expect((source.getRaw() as { secret?: string }).secret).toBe(
        "classified",
      );
      const targetSchema: JSONSchema = {
        type: "object",
        properties: {
          out: {
            type: "string",
            ifc: { maxConfidentiality: ceiling } as never,
          },
        },
        required: ["out"],
      };
      const target = runtime.getCell<{ out: string }>(
        spaceB,
        targetName,
        targetSchema as never,
        tx,
      );
      target.set({ out: "derived" });
      tx.prepareCfc();
      return await tx.commit();
    };

    it("fits a committed User clause under a plaintext ceiling naming the same principal", async () => {
      const { runtime } = makeRuntime(undefined);
      try {
        await seedCommitted(runtime, "legacy-fit-source");
        const result = await writeUnderCeiling(
          runtime,
          "legacy-fit-source",
          "legacy-fit-target",
          [userAtom],
        );
        expect(result.ok).toBeDefined();
      } finally {
        await runtime.dispose();
      }
    });

    it("still rejects a committed clause under a ceiling naming another principal", async () => {
      const { runtime } = makeRuntime(undefined);
      try {
        await seedCommitted(runtime, "legacy-reject-source");
        const result = await writeUnderCeiling(
          runtime,
          "legacy-reject-source",
          "legacy-reject-target",
          [{ type: CFC_ATOM_TYPE.User, subject: "did:key:bob" }],
        );
        expect(result.error?.message).toContain("maxConfidentiality failed");
      } finally {
        await runtime.dispose();
      }
    });
  });

  it("uses cfcAtom helpers consistently (guard against constant drift)", () => {
    // The seeded caveat matches the canonical helper output so the tests
    // above exercise the same shapes production mints.
    expect(cfcAtom.caveat("derived-from", fullSource as never)).toEqual(
      caveatAtom,
    );
  });
});
