import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-labelmap-components");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

type StoredCfcDocument = {
  cfc?: { labelMap?: { entries: StoredEntry[] } };
};

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: URI,
): StoredEntry[] => {
  const document = storageManager.open(signer.did()).replica.getDocument(id) as
    | StoredCfcDocument
    | undefined;
  return document?.cfc?.labelMap?.entries ?? [];
};

// labelMap v2 components (S16 design): persisted entries carry their
// provenance component so each can follow its own update discipline —
// `declared` (schema store policy, monotone), `link` (reference-carried,
// replaced when the link is rewritten), `derived` (default-transition flow
// labels, replaced on overwrite). Effective label = join of components.
describe("CFC labelMap component origins", () => {
  it("tags schema-derived entries as declared", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const guarded = internSchema(
        {
          type: "object",
          properties: {
            secret: { type: "string", ifc: { confidentiality: ["secret"] } },
          },
          required: ["secret"],
        } satisfies JSONSchema,
        true,
      );

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-components-declared",
        guarded.schema,
        tx,
      );
      cell.set({ secret: "hello" });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const entry = replicaEntries(storageManager, persistedId).find((e) =>
        e.path.length === 1 && e.path[0] === "secret"
      );
      expect(entry).toBeDefined();
      expect(entry!.origin).toBe("declared");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("skips the labelMap write when recomputed metadata is unchanged", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const guarded = internSchema(
        {
          type: "object",
          properties: {
            secret: { type: "string", ifc: { confidentiality: ["secret"] } },
          },
          required: ["secret"],
        } satisfies JSONSchema,
        true,
      );

      const seed = runtime.edit();
      const seedCell = runtime.getCell(
        signer.did(),
        "cfc-components-unchanged",
        guarded.schema,
        seed,
      );
      seedCell.set({ secret: "v1" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      // Re-write the labeled path through the same schema: the recomputed
      // labelMap is identical, so persistence must be a no-op — reactive
      // re-runs re-derive labels constantly and must not churn storage.
      // The mechanism is the journal's novelty diffing (value-identical
      // writes never become write details / commit ops); this pins that
      // end-to-end so a future persistence change can't regress it.
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-components-unchanged",
        guarded.schema,
        tx,
      );
      cell.set({ secret: "v2" });
      tx.prepareCfc();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const cfcWrites = [...(tx.getWriteDetails?.(signer.did()) ?? [])]
        .filter((write) =>
          write.address.id === persistedId && write.address.path[0] === "cfc"
        );
      expect(cfcWrites).toEqual([]);
      expect((await tx.commit()).ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("tags link-write entries as link", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-components-link-source",
        {
          type: "object",
          ifc: { confidentiality: ["shared-space"] },
          properties: { title: { type: "string" } },
        } satisfies JSONSchema,
        seed,
      );
      source.set({ title: "pointed-at" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const linkedSource = runtime.getCell(
        signer.did(),
        "cfc-components-link-source",
        undefined,
        tx,
      );
      const holder = runtime.getCell(
        signer.did(),
        "cfc-components-link-holder",
        undefined,
        tx,
      );
      holder.set(linkedSource);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = holder.getAsNormalizedFullLink().id;
      const entry = replicaEntries(storageManager, persistedId).find((e) =>
        e.path.length === 0
      );
      expect(entry).toBeDefined();
      expect(entry!.origin).toBe("link");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
