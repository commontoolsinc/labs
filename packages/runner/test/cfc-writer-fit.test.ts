import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { ISpaceReplica, URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cfc-writer-fit");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

const storedDocument = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: URI,
):
  | { value?: unknown; cfc?: { labelMap?: { entries: StoredEntry[] } } }
  | undefined => {
  const replica: ISpaceReplica = storageManager.open(signer.did()).replica;
  return replica.getDocument(id);
};

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: URI,
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

// Seed a source doc whose `secret` field carries a confidentiality label, and
// return a transaction that read it (tainting the per-tx flow join).
const seedSecretSource = async (runtime: Runtime, name: string) => {
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
          label: { confidentiality: ["secret"] },
        }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

// H4 writer-fit (SC-18b, spec §8.12.4): a write whose derived flow label does
// not fit the target's DECLARED store policy. Under `enforce-explicit` the
// derived component is a measurement, not a write ceiling — the write
// persists and the misfit is flagged as a diagnostic (SC-18a/c). Under
// `enforce-strict` the same misfit is a fail-closed reject (the strict-only
// delta of docs/specs/cfc-enforcement-matrix.md §4), leaving the §8.12.5
// outs: upgrade the store label in the same tx, or write to a fitting store.
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

      // Target doc declares NO store policy: its declared label is public,
      // so a secret-tainted derived component cannot fit.
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
      // The reason names the clause(s) outside the declared policy so the
      // flag identifies exactly what the store would need to declare.
      expect(result.error?.message).toContain('"secret"');
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
