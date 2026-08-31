import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { getDerivedInternalCellLink, parseLink } from "../src/link-utils.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "../src/cfc/observation.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_PIECE_SUBSTRATE,
  CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
} from "../src/cfc/types.ts";
import type { JSONSchema, Pattern } from "../src/builder/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("runner-cfc-writer-fit");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

const storedDocument = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
):
  | { value?: unknown; cfc?: { labelMap?: { entries: StoredEntry[] } } }
  | undefined => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      value?: unknown;
      cfc?: { labelMap?: { entries: StoredEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id);
};

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): StoredEntry[] =>
  storedDocument(storageManager, id)?.cfc?.labelMap?.entries ?? [];

const newRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // The shipped shell posture (enforcement-matrix §3): explicit + flow
    // persist. Individual transactions escalate to `enforce-strict` per-tx,
    // which is exactly the seam H4 differentiates.
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });

// The space principal of the space every doc in this file lives in — the
// clause residency admits (§8.12.4).
const ownSpacePrincipal = {
  type: "https://commonfabric.org/cfc/atom/Space",
  id: signer.did(),
};

// A second person, who is neither this space's DID nor its acting signer.
const OTHER_PRINCIPAL = "did:key:zOtherPerson";

// The three spellings of one principal (§15.2): the identity atom, the
// personal-space atom naming its owner, and the legacy bare DID string.
const userPrincipal = (subject: string) => ({
  type: "https://commonfabric.org/cfc/atom/User",
  subject,
});
const personalSpacePrincipal = (owner: string) => ({
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner,
});

// A target schema whose store policy is exactly `confidentiality`.
const declaring = (
  ...confidentiality: readonly FabricValue[]
): JSONSchema => ({
  type: "object",
  properties: { copied: { type: "string" } },
  ifc: { confidentiality: [...confidentiality] },
} as JSONSchema);

// Seed a source doc whose `secret` field carries `confidentiality`, so a
// transaction reading it takes those clauses into the per-tx flow join.
const seedSecretSource = async (
  runtime: Runtime,
  name: string,
  confidentiality: readonly FabricValue[] = ["secret"],
) => {
  const seed = runtime.edit();
  const sourceCell = runtime.getCell(
    signer.did(),
    name,
    {
      type: "object",
      properties: { secret: { type: "string" } },
    },
  );
  const sourceId = parseLink(sourceCell.getAsLink()).id!;
  writeSeedEnvelopeDoc(seed, signer.did());
  seed.writeOrThrow({
    space: signer.did(),
    scope: "space",
    id: sourceId,
    path: [],
  }, {
    value: { secret: "s3cr3t" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: [...confidentiality] },
        }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

// Read the seeded source in a fresh transaction at `mode`, derive a value
// into `targetName`, and commit. `targetSchema` declares the target's store
// policy; omitted, the target declares nothing.
const deriveIntoTarget = async (
  runtime: Runtime,
  sourceName: string,
  targetName: string,
  mode: "enforce-strict" | "enforce-explicit" = "enforce-strict",
  targetSchema?: JSONSchema,
) => {
  const tx = runtime.edit();
  tx.setCfcEnforcementMode(mode);
  const source = runtime.getCell(signer.did(), sourceName, undefined, tx);
  const raw = source.getRaw() as { secret?: string };
  const target = runtime.getCell<{ copied?: string }>(
    signer.did(),
    targetName,
    targetSchema,
    tx,
  );
  target.set({ copied: `${raw.secret}!` });
  const targetId = target.getAsNormalizedFullLink().id;
  tx.prepareCfc();
  return { tx, targetId, result: await tx.commit() };
};

// The writer-fit reasons this transaction recorded, whether they rejected the
// commit or landed as persist-and-flag diagnostics.
const writerFitDiagnostics = (
  tx: { getCfcState(): { diagnostics: string[] } },
) => tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit"));

// The marker the runner records for each document it instantiates a piece
// into, naming the piece's result document as the source.
const recordPieceSubstrate = (
  tx: ReturnType<Runtime["edit"]>,
  resultCell: {
    getAsNormalizedFullLink(): { space: string; scope: string; id: string };
  },
  substrateCell: {
    getAsNormalizedFullLink(): {
      space: string;
      scope: string;
      id: string;
      path: readonly string[];
    };
  },
): void => {
  const result = resultCell.getAsNormalizedFullLink();
  const substrate = substrateCell.getAsNormalizedFullLink();
  tx.recordCfcWritePolicyInput({
    kind: "structural-provenance",
    target: {
      space: substrate.space as `did:${string}:${string}`,
      scope: substrate.scope as "space",
      id: substrate.id,
      path: [...substrate.path],
    },
    claim: CFC_STRUCTURAL_PROVENANCE_PIECE_SUBSTRATE,
    sources: [{
      space: result.space as `did:${string}:${string}`,
      scope: result.scope as "space",
      id: result.id,
      path: [],
    }],
  });
};

describe("CFC writer-fit (canWrite, §8.12.4 / SC-18b)", () => {
  // H4 writer-fit (SC-18b, spec §8.12.4): a write whose derived flow label does
  // not fit the target's write ceiling — its DECLARED store policy joined with
  // the residency clause its own space contributes. Under `enforce-explicit`
  // the derived component is a measurement, not a write ceiling — the write
  // persists and the misfit is flagged as a diagnostic (SC-18a/c). Under
  // `enforce-strict` the same misfit is a fail-closed reject (the strict-only
  // delta of docs/specs/cfc-enforcement-matrix.md §4), leaving the §8.12.5
  // outs: upgrade the store label in the same tx, write to a fitting store, or
  // write to a store whose space the clause already names.

  it("rejects a confidentiality misfit under enforce-strict with the SC-18c reason", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-strict-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-strict-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");

      // Target doc declares NO store policy, so residency is its whole
      // ceiling: a `secret`-tainted component, naming no space, cannot fit.
      const derived = runtime.getCell(
        signer.did(),
        "writer-fit-strict-derived",
        undefined,
        tx,
      );
      derived.set({ copied: `${raw.secret}!` });
      const derivedId = derived.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeDefined();
      // SC-18c error contract: stable reason naming the rule id and path.
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain(`for ${derivedId} at /`);
      expect(result.error?.message).toContain("(canWrite, §8.12.4)");

      // Fail-closed: the rejected transaction persisted nothing.
      expect(storedDocument(storageManager, derivedId)).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the measurement and flags the misfit under enforce-explicit", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-explicit-source");

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-explicit-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const derived = runtime.getCell(
        signer.did(),
        "writer-fit-explicit-derived",
        undefined,
        tx,
      );
      derived.set({ copied: `${raw.secret}!` });
      const derivedId = derived.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      // Persist-and-flag, half one: the derived component records the
      // value's actual taint (unchanged shipped behavior — readers stay
      // protected by the effective-label floor).
      const entries = replicaEntries(storageManager, derivedId);
      const flowEntry = entries.find((e) => e.origin === "derived");
      expect(flowEntry).toBeDefined();
      expect(flowEntry!.label.confidentiality).toContainEqual("secret");

      // Persist-and-flag, half two: the misfit is flagged as a diagnostic
      // carrying the same SC-18c reason string the strict reject uses.
      const flags = tx.getCfcState().diagnostics.filter((d) =>
        d.includes("writer-fit(persist-and-flag)")
      );
      expect(flags.length).toBeGreaterThan(0);
      expect(flags[0]).toContain("writer-fit confidentiality misfit");
      expect(flags[0]).toContain(`for ${derivedId} at /`);
      expect(flags[0]).toContain("(canWrite, §8.12.4)");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a fitting write under enforce-strict when the declared policy covers the join", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-covered-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-covered-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      // §8.12.5 route 2, atomically in one tx: the write rides a schema that
      // declares a store policy at least as strict as the derived join.
      const covered = runtime.getCell(
        signer.did(),
        "writer-fit-covered-derived",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["secret"] },
        },
        tx,
      );
      covered.set({ copied: `${raw.secret}!` });
      const coveredId = covered.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, coveredId);
      expect(entries.some((e) =>
        e.origin === "declared" &&
        (e.label.confidentiality ?? []).includes("secret")
      )).toBe(true);
      expect(entries.some((e) => e.origin === "derived")).toBe(true);
      expect(
        tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit")),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("ignores pointer-classed declared policy for a value write under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-followref-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-followref-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      // The target's ONLY declared confidentiality is classed
      // `observes: "followRef"` — pointer policy. Value readers never
      // consume it (C0 §4), so it is not part of the floor a value reader
      // is tainted with and must not serve as the writer-fit ceiling
      // (bot review on this PR: pointer policy admitting a secret value
      // write would under-block exactly the readers the check protects).
      const pointerOnly = runtime.getCell(
        signer.did(),
        "writer-fit-followref-derived",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["secret"], observes: "followRef" },
        },
        tx,
      );
      pointerOnly.set({ copied: `${raw.secret}!` });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("names the offending clause when the declared policy only partially covers", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-partial-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-partial-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const partial = runtime.getCell(
        signer.did(),
        "writer-fit-partial-derived",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["internal"] },
        },
        tx,
      );
      partial.set({ copied: `${raw.secret}!` });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      // The reason names the clause(s) outside the write ceiling so the
      // flag identifies exactly what the store would need to declare.
      expect(result.error?.message).toContain('"secret"');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a same-space principal clause into an undeclared store under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // The source's confidentiality names this space's own principal, so
      // residency fits the tainted write below even though the target
      // declares nothing.
      await seedSecretSource(runtime, "wf-samespace-source", [
        ownSpacePrincipal,
      ]);
      const { tx, targetId, result } = await deriveIntoTarget(
        runtime,
        "wf-samespace-source",
        "wf-samespace-derived",
      );
      expect(result.error?.message).toBeUndefined();

      // The fit is a write admission, not a label drop: the derived stamp
      // still carries the space principal for the egress gates.
      const flowEntry = replicaEntries(storageManager, targetId)
        .find((e) => e.origin === "derived");
      expect(flowEntry).toBeDefined();
      expect(flowEntry!.label.confidentiality).toContainEqual(
        ownSpacePrincipal,
      );
      expect(writerFitDiagnostics(tx)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a clause carrying the space principal as one alternative", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // Residency reaches into an OR-clause: the ceiling clause subsumes a
      // label clause listing the space among its alternatives.
      await seedSecretSource(runtime, "wf-alternative-source", [{
        anyOf: [
          {
            type: "https://commonfabric.org/cfc/atom/User",
            subject: "did:key:zReader",
          },
          ownSpacePrincipal,
        ],
      }]);
      const { tx, result } = await deriveIntoTarget(
        runtime,
        "wf-alternative-source",
        "wf-alternative-derived",
      );
      expect(result.error?.message).toBeUndefined();
      expect(writerFitDiagnostics(tx)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("raises no persist-and-flag diagnostic for a same-space clause under enforce-explicit", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // The measurement is one computation feeding both the strict reject and
      // the lower-mode diagnostic, so a residency fit is silent at every rung.
      await seedSecretSource(runtime, "wf-explicit-source", [
        ownSpacePrincipal,
      ]);
      const { tx, result } = await deriveIntoTarget(
        runtime,
        "wf-explicit-source",
        "wf-explicit-derived",
        "enforce-explicit",
      );
      expect(result.error?.message).toBeUndefined();
      expect(writerFitDiagnostics(tx)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a principal naming a space other than the target's", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "wf-foreignspace-source", [{
        type: "https://commonfabric.org/cfc/atom/Space",
        id: "did:key:zForeignSpace",
      }]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-foreignspace-source",
        "wf-foreignspace-derived",
      );
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain("zForeignSpace");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects the personal-space principal form under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "wf-personalspace-source", [{
        type: "https://commonfabric.org/cfc/atom/PersonalSpace",
        owner: signer.did(),
      }]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-personalspace-source",
        "wf-personalspace-derived",
      );
      // `PersonalSpace` gates by equality against one acting reader, so its
      // audience is a person rather than the space's reader set. Residency
      // does not admit it, even though the owner DID matches this space's.
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain("PersonalSpace");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects the bare DID-string principal that the declared policy omits", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // Two clauses: one the target's declared policy lists, one it does not
      // — the bare DID-string spelling, which names a reader by identity
      // rather than naming the container.
      await seedSecretSource(runtime, "wf-baredid-source", [
        "internal",
        signer.did(),
      ]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-baredid-source",
        "wf-baredid-derived",
        "enforce-strict",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["internal"] },
        },
      );
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain(signer.did());
      expect(result.error?.message).not.toContain('"internal"');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a read-failed marker clause that lists a same-space alternative", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // The ungrantable marker stays outside every ceiling, the residency
      // clause included. This is also the fence against reimplementing the
      // rule as a filter over the measured label, which would drop the
      // clause before the marker check ever ran.
      await seedSecretSource(runtime, "wf-poisoned-source", [{
        anyOf: [CFC_LABEL_READ_FAILED_ATOM, ownSpacePrincipal],
      }]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-poisoned-source",
        "wf-poisoned-derived",
      );
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain(CFC_LABEL_READ_FAILED_ATOM);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("a personal space's owner is one of its readers", () => {
    // §8.10.3 fit kernel: a `PersonalSpace(P)` LABEL fits a store declaring
    // `User(P)`, because §3.6.4 makes P an owner and so a reader of that
    // space. The reverse does not hold — §3.6.5 gives a member added later
    // access to all data in the space with no label rewriting, so a store
    // declaring the atom is not read by P alone.

    it("admits a personal-space clause into a store declaring that owner", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-owner-source", [
          personalSpacePrincipal(OTHER_PRINCIPAL),
        ]);
        const { tx, targetId, result } = await deriveIntoTarget(
          runtime,
          "wf-owner-source",
          "wf-owner-derived",
          "enforce-strict",
          declaring(userPrincipal(OTHER_PRINCIPAL)),
        );
        expect(result.error?.message).toBeUndefined();
        expect(writerFitDiagnostics(tx)).toEqual([]);

        // A write admission, not a relabeling: the derived stamp still
        // carries the atom the flow measured, so the egress and display
        // gates read the unchanged label.
        const flowEntry = replicaEntries(storageManager, targetId)
          .find((e) => e.origin === "derived");
        expect(flowEntry!.label.confidentiality).toContainEqual(
          personalSpacePrincipal(OTHER_PRINCIPAL),
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("admits a clause carrying the personal space as one alternative", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-owner-alt-source", [{
          anyOf: [personalSpacePrincipal(OTHER_PRINCIPAL), "internal"],
        }]);
        const { result } = await deriveIntoTarget(
          runtime,
          "wf-owner-alt-source",
          "wf-owner-alt-derived",
          "enforce-strict",
          declaring(userPrincipal(OTHER_PRINCIPAL)),
        );
        expect(result.error?.message).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a User clause into a store declaring that person's personal space", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        // The direction §3.6.5 denies: the store's audience is the space's
        // readers, which a later membership change widens without touching
        // any label.
        await seedSecretSource(runtime, "wf-owner-ceiling-source", [
          userPrincipal(OTHER_PRINCIPAL),
        ]);
        const { result } = await deriveIntoTarget(
          runtime,
          "wf-owner-ceiling-source",
          "wf-owner-ceiling-derived",
          "enforce-strict",
          declaring(personalSpacePrincipal(OTHER_PRINCIPAL)),
        );
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(OTHER_PRINCIPAL);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a personal space the declared owner does not name", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        // The neighbouring case: the same rule, one DID apart.
        await seedSecretSource(runtime, "wf-owner-mismatch-source", [
          personalSpacePrincipal(OTHER_PRINCIPAL),
        ]);
        const { result } = await deriveIntoTarget(
          runtime,
          "wf-owner-mismatch-source",
          "wf-owner-mismatch-derived",
          "enforce-strict",
          declaring(userPrincipal(signer.did())),
        );
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(OTHER_PRINCIPAL);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a User clause naming the acting principal into an undeclared store", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        // No self exemption. The acting principal signs this transaction and
        // its DID is this space's, so residency contributes `Space(<that
        // DID>)` — and the store is still public, which is what refuses the
        // write. A person writing their own secret to a world-readable store
        // is the disclosure the ceiling exists to catch.
        await seedSecretSource(runtime, "wf-owner-self-source", [
          userPrincipal(signer.did()),
        ]);
        const { result } = await deriveIntoTarget(
          runtime,
          "wf-owner-self-source",
          "wf-owner-self-derived",
        );
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(signer.did());
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("meta-seam exemption", () => {
    // The measurement quantifies over paths a schema could have declared a
    // policy at, and the raw meta seam is not one: `setMetaRaw` lands on a
    // document-root sibling of `value` (`schema`, `internal`, and the rest of
    // the `MetaField` union), which no value schema describes.
    //
    // One route does reach a ceiling there — a document-root declaration
    // resolves at every meta path by longest prefix — but it widens the
    // ceiling over the whole payload, and a declaration on a single result
    // field, which is how a pattern normally labels one, leaves the seam's
    // ceiling empty. Such a pattern is then un-updatable: the pattern updater,
    // `setsrc`, and setup over an existing piece all stamp meta.
    //
    // The seam is outside the check at every rung, so these cases assert on
    // both the strict reject and the persist-and-flag diagnostic below it.

    // Pinned rather than inherited: this exemption is only observable at the
    // strictness where the misfit rejects.
    const strictRuntime = (
      storageManager: ReturnType<typeof StorageManager.emulate>,
    ) =>
      new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });

    /** Seed `cause` as a plain document declaring no store policy. */
    const seedUndeclaredTarget = async (
      runtime: Runtime,
      cause: string,
      payload: FabricValue = { note: "public" },
    ) => {
      const id = runtime.getCell(signer.did(), cause)
        .getAsNormalizedFullLink().id;
      const seed = runtime.edit();
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id,
        path: [],
      }, { value: payload });
      expect((await seed.commit()).ok).toBeDefined();
      return id;
    };

    it("admits a meta write of a tainted join into an undeclared store", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-source");
        const targetId = await seedUndeclaredTarget(runtime, "wf-meta-target");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("s3cr3t");
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-target",
          undefined,
          tx,
        );
        await target.sync();
        // The two paths the piece-update flows land on, and the two the
        // strict measurement used to reject at.
        target.setMetaRaw(
          "schema",
          { type: "object" },
          rawMetaWriteAuthorization,
        );
        target.setMetaRaw(
          "internal",
          { derived: raw.secret },
          rawMetaWriteAuthorization,
        );
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error).toBeUndefined();
        expect(result.ok).toBeDefined();
        // Not merely "did not reject": no measurement named a meta path at
        // all, at either rung (a strict reject and an explicit flag carry the
        // identical reason string).
        expect(writerFitDiagnostics(tx)).toEqual([]);

        // The taint is not lost with the measurement. The join still lands as
        // the derived component on the meta paths, so the egress, display,
        // and observation gates read the unchanged label. (Each path carries
        // the C2 per-class split — a `value` entry and a `shape` entry — so
        // the paths are compared as a set.)
        const stamped = replicaEntries(storageManager, targetId).filter((e) =>
          e.origin === "derived" &&
          (e.label.confidentiality ?? []).includes("secret")
        );
        expect([...new Set(stamped.map((e) => e.path.join("/")))].sort())
          .toEqual(["internal", "schema"]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("raises no persist-and-flag diagnostic for a meta write under enforce-explicit", async () => {
      // The exemption is a statement about what the check can measure, not
      // about what a rung does with a misfit, so it holds below strict too.
      // Were it scoped to the reject, the shipped posture would keep flagging
      // a measurement the strict rung had already declared meaningless.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-explicit-source");
        await seedUndeclaredTarget(runtime, "wf-meta-explicit-target");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-explicit-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-explicit-target",
          undefined,
          tx,
        );
        await target.sync();
        target.setMetaRaw("slug", `${raw.secret}!`, rawMetaWriteAuthorization);
        tx.prepareCfc();

        expect((await tx.commit()).ok).toBeDefined();
        expect(writerFitDiagnostics(tx)).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("still rejects an ordinary value write of the same join into the same store", async () => {
      // The control: the exemption is about paths a schema cannot reach, not
      // about this transaction's join or this target's store. Swap the meta
      // write above for a payload write into the same undeclared document and
      // the misfit is back.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-control-source");
        const targetId = await seedUndeclaredTarget(
          runtime,
          "wf-meta-control-target",
        );

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-control-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "note"],
        }, `${raw.secret}!`);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error).toBeDefined();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${targetId} at /note`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("skips the measurement even where a root declaration resolves at the meta path", async () => {
      // The skip is unconditional, and this pins that. A document-root
      // declared entry is a prefix of every meta path, so longest-prefix
      // resolution hands the meta path a non-empty ceiling — but that
      // reaches the envelope seam only because canonicalization strips a
      // leading `"value"`, making the payload root and the document root one
      // logical path. It says nothing about the seam, and honoring it would
      // make a piece updatable or not according to whether its pattern
      // carries a root `ifc`.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-rooted-source");

        // A root declaration that does NOT cover the join the tx will carry.
        const targetId = runtime.getCell(signer.did(), "wf-meta-rooted-target")
          .getAsNormalizedFullLink().id;
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, signer.did());
        seed.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: [],
        }, {
          value: { note: "public" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { confidentiality: ["unrelated"] },
              }],
            },
          },
        });
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-rooted-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-rooted-target",
          undefined,
          tx,
        );
        await target.sync();
        target.setMetaRaw("slug", `${raw.secret}!`, rawMetaWriteAuthorization);
        tx.prepareCfc();

        expect((await tx.commit()).ok).toBeDefined();
        expect(writerFitDiagnostics(tx)).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps measuring a payload field that shares a meta field's logical path", async () => {
      // A payload field literally named `schema` lives at raw
      // `["value","schema"]` and canonicalizes onto the meta root's logical
      // path. The exemption is recorded per path across every write that
      // reached it, so writing both in one transaction leaves the path
      // measured — and an exempt meta path must not collapse a value write
      // below it out of the measurement either.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-collide-source");
        // The payload carries a `schema` object of its own, so the write
        // below materializes at its own path instead of at the document root.
        const targetId = await seedUndeclaredTarget(
          runtime,
          "wf-meta-collide-target",
          { schema: { existing: true } },
        );

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-collide-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-collide-target",
          undefined,
          tx,
        );
        await target.sync();
        target.setMetaRaw(
          "schema",
          { type: "object" },
          rawMetaWriteAuthorization,
        );
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "schema", "leaked"],
        }, `${raw.secret}!`);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error).toBeDefined();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(
          `for ${targetId} at /schema/leaked`,
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  it("admits a reserved grant document under enforce-strict", async () => {
    // Reserved CFC documents (policy manifests, release grants) hold policy
    // state the runtime persists through its privileged writers, so they are
    // not value-write targets the fit measures. The grant document declares no
    // store policy of its own, and the transaction that authors one has read
    // the resource it releases — a tainted join.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-grant-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-grant-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");
      // The trusted policy-writer authors under a builtin identity, the one
      // sanctioned writer of the reserved grant namespace.
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "cfc-grant-writer",
      });
      const written = tx.writeCfcGrant({
        kind: "ShareGrant",
        owner: signer.did(),
        resource: "of:writer-fit-grant-resource",
        audience: [cfcAtom.user(
          "did:key:z6MkfZ3gV6ZKqmyWLTPYnPYRUYQBqTHTNCJgqbCkNBzYqZ4H",
        )],
        grantedAt: 1000,
      });
      expect(tx.prepareCfc()).not.toBe("");
      expect((await tx.commit()).ok).toBeDefined();

      // The grant persisted, carrying no derived label of its own: a
      // consultation reading it inherits nothing from the releasing
      // transaction.
      const stored = storedDocument(storageManager, written.id);
      expect(stored?.value).toBeDefined();
      expect(stored?.cfc).toBeUndefined();
      expect(
        tx.getCfcState().diagnostics.filter((diagnostic) =>
          diagnostic.includes(written.id)
        ),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("leaves untainted writes untouched under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const plain = runtime.getCell(
        signer.did(),
        "writer-fit-plain",
        undefined,
        tx,
      );
      plain.set({ note: "public" });
      const plainId = plain.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
      expect(replicaEntries(storageManager, plainId)).toEqual([]);
      expect(
        tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit")),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // The pattern the end-to-end cases set up: one argument field, and one
  // derived internal cell the result projects to.
  const seamResultSchema = {
    type: "object",
    properties: { savedTitle: { type: "string" } },
    required: ["savedTitle"],
  } as const satisfies JSONSchema;

  const seamPattern = {
    argumentSchema: {
      type: "object",
      properties: { title: { type: "string" } },
    } as const,
    resultSchema: seamResultSchema,
    derivedInternalCells: [{
      partialCause: "savedTitle",
      schema: { type: "string", default: "" },
    }],
    result: {
      savedTitle: { $alias: { partialCause: "savedTitle", path: [] } },
    },
    nodes: [],
  } satisfies Pattern;

  describe("the piece-substrate declaration (§8.12.5 route 2)", () => {
    // A piece's substrate is filled by the runtime out of whatever the setup
    // transaction read: the argument document, and the internal documents
    // and streams the result projects to. No value schema can declare a
    // covering policy for them, because the atoms are a property of the
    // transaction rather than of the pattern, so the transaction declares
    // that policy itself. `docs/specs/cfc-enforcement-matrix.md` §4 states
    // the route and the four conditions on it; one test per condition
    // follows.

    it("declares the join on a document the substrate marker names", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-substrate",
          undefined,
          tx,
        );
        recordPieceSubstrate(tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        const entries = replicaEntries(storageManager, substrateId);
        expect(entries.some((entry) =>
          entry.origin === "declared" &&
          (entry.label.confidentiality ?? []).includes("secret")
        )).toBe(true);

        // A permanent change to a store's policy leaves a trace even at the
        // rung that admits it.
        const flags = writerFitDiagnostics(tx);
        expect(flags.length).toBe(1);
        expect(flags[0]).toContain("writer-fit(piece-substrate-declared)");
        expect(flags[0]).toContain(`${substrateId} at /`);
        expect(flags[0]).toContain('"secret"');
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects the same write on a document no substrate marker names", async () => {
      // The negative twin of the test above: one transaction, one marker, and
      // a second target the marker does not name. The route reaches the seam
      // and stops there.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-bystander-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-bystander-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-bystander-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-bystander-substrate",
          undefined,
          tx,
        );
        recordPieceSubstrate(tx, result, substrate);
        const bystander = runtime.getCell(
          signer.did(),
          "writer-fit-seam-bystander",
          undefined,
          tx,
        );
        bystander.set({ copied: `${raw.secret}!` });
        const bystanderId = bystander.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain(`for ${bystanderId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("grows the declaration when a later transaction carries a wider join", async () => {
      // The declared component only ever tightens (§8.12.1), so a second
      // atom joins the first rather than replacing it. A piece created
      // before its inputs were labeled reaches the same path: nothing was
      // declared at birth, and the write that first carries a join declares
      // it then.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-grow-first");
        await seedSecretSource(runtime, "writer-fit-seam-grow-second", [
          "other",
        ]);

        const born = runtime.edit();
        const untainted = runtime.getCell(
          signer.did(),
          "writer-fit-seam-grow-substrate",
          undefined,
          born,
        );
        untainted.set({ copied: "public" });
        const substrateId = untainted.getAsNormalizedFullLink().id;
        expect((await born.commit()).ok).toBeDefined();
        expect(replicaEntries(storageManager, substrateId)).toEqual([]);

        const declaredClauses = async (sources: readonly string[]) => {
          const tx = runtime.edit();
          tx.setCfcEnforcementMode("enforce-strict");
          const copied = sources.map((name) =>
            (runtime.getCell(signer.did(), name, undefined, tx)
              .getRaw() as { secret?: string }).secret
          ).join("/");
          const result = runtime.getCell(
            signer.did(),
            "writer-fit-seam-grow-result",
            undefined,
            tx,
          );
          const substrate = runtime.getCell(
            signer.did(),
            "writer-fit-seam-grow-substrate",
            undefined,
            tx,
          );
          recordPieceSubstrate(tx, result, substrate);
          substrate.set({ copied });
          tx.prepareCfc();
          expect((await tx.commit()).ok).toBeDefined();
          const declared = replicaEntries(storageManager, substrateId)
            .filter((entry) => entry.origin === "declared");
          // One entry per path per component: a second declaration at the
          // same path would coalesce, and a stored one that failed to
          // coalesce would rewrite the envelope on every reconcile.
          expect(declared.length).toBe(1);
          return declared[0].label.confidentiality ?? [];
        };

        expect(await declaredClauses(["writer-fit-seam-grow-first"]))
          .toEqual(["secret"]);
        // Re-declaring the same join changes nothing.
        expect(await declaredClauses(["writer-fit-seam-grow-first"]))
          .toEqual(["secret"]);
        const grown = await declaredClauses([
          "writer-fit-seam-grow-first",
          "writer-fit-seam-grow-second",
        ]);
        expect(grown).toContain("secret");
        expect(grown).toContain("other");
        // And the wider declaration survives a transaction that carries only
        // the narrower join: the declared component never shrinks.
        expect(await declaredClauses(["writer-fit-seam-grow-first"]))
          .toEqual(grown);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a substrate write at a path its own schema declares", async () => {
      // A schema that declares at the written path owns the store's policy
      // there, and widening it from the join would make the walk's own
      // re-mint non-monotone on the next write. That store's route 2 is the
      // author's, in the schema.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-declared-source");

        // The field has to exist already: a key write into a document this
        // transaction is also creating materializes the whole document, and
        // lands at the root rather than at the declared field.
        const create = runtime.edit();
        runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-seam-declared-substrate",
          undefined,
          create,
        ).set({ copied: "public" });
        expect((await create.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-declared-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-declared-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-seam-declared-substrate",
          {
            type: "object",
            properties: {
              copied: {
                type: "string",
                ifc: { confidentiality: ["policy"] },
              },
            },
          },
          tx,
        );
        recordPieceSubstrate(tx, result, substrate);
        substrate.key("copied").set(`${raw.secret}!`);
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain("at /copied");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a substrate write whose marker names only part of the document", async () => {
      // The route declares a policy for the whole store, so it takes a
      // marker only where the marker claims the whole store. Setup records
      // the empty path for every document it mints from a result cell, so
      // this excludes a stored argument link that points inside some other
      // document.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-partial-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-partial-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-partial-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-seam-partial-substrate",
          undefined,
          tx,
        );
        recordPieceSubstrate(tx, result, substrate.key("copied"));
        substrate.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a clause naming a space other than the target's", async () => {
      // A `Space` clause is honored by a replica set, not by a reader check,
      // which is why residency admits only the target's own. Declaring a
      // foreign one would put the bytes in front of this space's members
      // under a promise made to another space's readers.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-foreign-source", [{
          type: "https://commonfabric.org/cfc/atom/Space",
          id: "did:key:z6MkfZ3gV6ZKqmyWLTPYnPYRUYQBqTHTNCJgqbCkNBzYqZ4H",
        }]);

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-foreign-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-foreign-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-foreign-substrate",
          undefined,
          tx,
        );
        recordPieceSubstrate(tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(storedDocument(storageManager, substrateId)).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a substrate write named by a different provenance claim", async () => {
      // The claim discriminates. The seed-materialization marker records a
      // whole-document address too, so without it that unrelated runtime
      // marker would carry the route.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-claim-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-claim-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-claim-substrate",
          undefined,
          tx,
        );
        const link = substrate.getAsNormalizedFullLink();
        tx.recordCfcWritePolicyInput({
          kind: "structural-provenance",
          target: {
            space: link.space,
            scope: link.scope,
            id: link.id,
            path: [],
          },
          claim: CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
          sources: [{
            space: link.space,
            scope: link.scope,
            id: link.id,
            path: [],
          }],
        });
        substrate.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a poisoned measurement on a substrate document", async () => {
      // The ungrantable read-failed marker is outside every ceiling, so it
      // is outside what the route may declare: a measurement the runtime
      // could not take proves nothing about the audience, and declaring it
      // would write a clause no reader can ever satisfy.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-poisoned-source", [{
          anyOf: [CFC_LABEL_READ_FAILED_ATOM, ownSpacePrincipal],
        }]);

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-poisoned-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-poisoned-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-poisoned-substrate",
          undefined,
          tx,
        );
        recordPieceSubstrate(tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain(CFC_LABEL_READ_FAILED_ATOM);
        expect(storedDocument(storageManager, substrateId)).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps the clauses an ancestor path already declared", async () => {
      // The route declares the resolved ceiling as well as the offending
      // clauses. Reads resolve declared entries by longest prefix, so a mint
      // that carried only what was offending would shadow the ancestor
      // declaration at every path below it — lowering the store's promise
      // through the very entry meant to raise it.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-ancestor-first");
        await seedSecretSource(runtime, "writer-fit-seam-ancestor-second", [
          "other",
        ]);

        const writeUnder = async (sourceName: string, field: string) => {
          const tx = runtime.edit();
          tx.setCfcEnforcementMode("enforce-strict");
          const source = runtime.getCell(
            signer.did(),
            sourceName,
            undefined,
            tx,
          );
          const raw = source.getRaw() as { secret?: string };
          const result = runtime.getCell(
            signer.did(),
            "writer-fit-seam-ancestor-result",
            undefined,
            tx,
          );
          const substrate = runtime.getCell<Record<string, string>>(
            signer.did(),
            "writer-fit-seam-ancestor-substrate",
            undefined,
            tx,
          );
          recordPieceSubstrate(tx, result, substrate);
          if (field === "") {
            substrate.set({ first: `${raw.secret}!` });
          } else {
            substrate.key(field).set(`${raw.secret}!`);
          }
          const substrateId = substrate.getAsNormalizedFullLink().id;
          tx.prepareCfc();
          expect((await tx.commit()).ok).toBeDefined();
          return replicaEntries(storageManager, substrateId);
        };

        // The document root declares the first join.
        expect(
          (await writeUnder("writer-fit-seam-ancestor-first", ""))
            .filter((entry) =>
              entry.origin === "declared" && entry.path.length === 0
            )
            .flatMap((entry) => entry.label.confidentiality ?? []),
        ).toEqual(["secret"]);

        // A later write below it carries a join the root does not cover, so
        // the route declares at the deeper path — and that declaration is
        // what a reader of the deeper path resolves, so it has to carry the
        // root's clause too.
        const deeper = (await writeUnder(
          "writer-fit-seam-ancestor-second",
          "second",
        ))
          .filter((entry) =>
            entry.origin === "declared" && entry.path.join("/") === "second"
          )
          .flatMap((entry) => entry.label.confidentiality ?? []);
        expect(deeper).toContain("secret");
        expect(deeper).toContain("other");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("leaves the persist-and-flag diagnostic in place under enforce-explicit", async () => {
      // The route is the strict rung's, like the reject it replaces. Every
      // rung below keeps the diagnostic that is its rollout signal, and
      // stores no declared policy it could never take back.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-explicit-source");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-explicit-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-explicit-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-explicit-substrate",
          undefined,
          tx,
        );
        recordPieceSubstrate(tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        const flags = writerFitDiagnostics(tx);
        expect(flags.length).toBeGreaterThan(0);
        expect(flags[0]).toContain("writer-fit(persist-and-flag)");
        expect(
          replicaEntries(storageManager, substrateId)
            .filter((entry) => entry.origin === "declared"),
        ).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("declares on both documents a real setup writes", async () => {
      // Drives the production recorder rather than the marker the tests
      // above hand-record: `setup` marks the argument document and each
      // internal document its result projects to, and a first setup inside
      // a labeled transaction writes both.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      try {
        await seedSecretSource(runtime, "writer-fit-seam-both-source");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-both-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const resultCell = runtime.getCell(
          signer.did(),
          "writer-fit-seam-both",
          seamResultSchema,
          tx,
        );
        await runtime.setup(
          tx,
          seamPattern,
          { title: `${raw.secret}!` },
          resultCell,
        );
        const argumentId = parseLink(
          resultCell.getMetaRaw("argument"),
          resultCell,
        )!.id!;
        const internalId = getDerivedInternalCellLink(
          resultCell,
          seamPattern.derivedInternalCells[0],
        ).id;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        for (const id of [argumentId, internalId]) {
          expect(
            replicaEntries(storageManager, id).filter((entry) =>
              entry.origin === "declared" &&
              (entry.label.confidentiality ?? []).includes("secret")
            ).length,
          ).toBe(1);
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a setup whose stored argument link names another document", async () => {
      // `setup` reads the argument address back out of the result cell's
      // stored meta, where it need not name the document that result cell's
      // cause mints. The marker follows the minted address, so a stored link
      // aimed elsewhere carries no route and that document keeps its own
      // ceiling.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      try {
        await seedSecretSource(runtime, "writer-fit-seam-aimed-source");

        const aim = runtime.edit();
        const resultCell = runtime.getCell(
          signer.did(),
          "writer-fit-seam-aimed",
          seamResultSchema,
          aim,
        );
        const bystander = runtime.getCell<{ note?: string }>(
          signer.did(),
          "writer-fit-seam-aimed-bystander",
          undefined,
          aim,
        );
        bystander.set({ note: "public" });
        const bystanderId = bystander.getAsNormalizedFullLink().id;
        resultCell.withTx(aim).setMetaRaw(
          "argument",
          bystander.getAsWriteRedirectLink({ base: resultCell }),
          rawMetaWriteAuthorization,
        );
        expect((await aim.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-aimed-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const reused = runtime.getCell(
          signer.did(),
          "writer-fit-seam-aimed",
          seamResultSchema,
          tx,
        );
        await runtime.setup(
          tx,
          seamPattern,
          { title: `${raw.secret}!` },
          reused,
        );
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(
          replicaEntries(storageManager, bystanderId)
            .filter((entry) => entry.origin === "declared"),
        ).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("commits a piece instantiation whose transaction read labeled data", async () => {
      // The end-to-end shape the hand-recorded marker above stands in for: a
      // real `setup` writing a real piece's argument document. The piece is
      // set up twice — first with nothing labeled in the transaction, then
      // inside one that read a labeled document — so the second setup
      // finds an argument document that already exists and declares
      // nothing, which a create-only route would refuse.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      try {
        await seedSecretSource(runtime, "writer-fit-seam-piece-source");

        const tx = runtime.edit();
        const resultCell = runtime.getCell(
          signer.did(),
          "writer-fit-seam-piece",
          seamResultSchema,
          tx,
        );
        await runtime.setup(
          tx,
          seamPattern,
          { title: "public" },
          resultCell,
        );
        const argumentId = parseLink(
          resultCell.getMetaRaw("argument"),
          resultCell,
        )!.id!;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        const labeled = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-piece-source",
          undefined,
          labeled,
        );
        const raw = source.getRaw() as { secret?: string };
        const reused = runtime.getCell(
          signer.did(),
          "writer-fit-seam-piece",
          seamResultSchema,
          labeled,
        );
        await runtime.setup(
          labeled,
          seamPattern,
          { title: `${raw.secret}!` },
          reused,
        );
        labeled.prepareCfc();
        expect((await labeled.commit()).ok).toBeDefined();

        const entries = replicaEntries(storageManager, argumentId);
        expect(entries.some((entry) =>
          entry.origin === "declared" &&
          (entry.label.confidentiality ?? []).includes("secret")
        )).toBe(true);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
