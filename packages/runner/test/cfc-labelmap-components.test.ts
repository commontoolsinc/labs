import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
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
