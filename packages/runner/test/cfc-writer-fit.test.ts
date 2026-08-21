import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "../src/cfc/observation.ts";
import type { JSONSchema } from "../src/builder/types.ts";

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

// H4 writer-fit (SC-18b, spec §8.12.4): a write whose derived flow label does
// not fit the target's write ceiling — its DECLARED store policy joined with
// the residency clause its own space contributes. Under `enforce-explicit`
// the derived component is a measurement, not a write ceiling — the write
// persists and the misfit is flagged as a diagnostic (SC-18a/c). Under
// `enforce-strict` the same misfit is a fail-closed reject (the strict-only
// delta of docs/specs/cfc-enforcement-matrix.md §4), leaving the §8.12.5
// outs: upgrade the store label in the same tx, write to a fitting store, or
// write to a store whose space the clause already names.
describe("CFC writer-fit (canWrite, §8.12.4 / SC-18b)", () => {
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
});
