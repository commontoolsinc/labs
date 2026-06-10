import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-privileged-system-write",
);

// Audit S18: a write addressed directly at a document's ["cfc"] label-map path
// forges the CFC metadata that drives label derivation for OTHER writes,
// bypassing the commit-boundary derivation + mint-gating (S4) entirely. Only the
// runtime's own persistence (inside prepareBoundaryCommit's privileged scope)
// may write there; a non-privileged ["cfc"] write must fail closed in enforce
// mode and surface a diagnostic in observe.
const forgedMetadata = {
  version: 1,
  schemaHash: "forged",
  labelMap: {
    version: 1,
    entries: [{
      path: [],
      // The exact runtime-evidence atom the prompt-injection screen trusts.
      label: { integrity: [{ kind: "InjectionSafe" }] },
    }],
  },
};

describe("CFC privileged system write (S18)", () => {
  it("rejects a non-privileged ['cfc'] metadata write in enforce mode", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-enforce",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      // Forge the label map directly at the document's ["cfc"] path.
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata as unknown as Record<string, unknown>);

      const result = await tx.commit();
      expect(result.error).toBeDefined();
      expect(String((result.error as Error).message).toLowerCase()).toContain(
        "cfc",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows the write but records a diagnostic in observe mode", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-observe",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata as unknown as Record<string, unknown>);

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.toLowerCase().includes("unprivileged") && d.includes("cfc")
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("permits the runtime's own label persistence (privileged) to commit", async () => {
    // A normal labeled write: the runtime derives + persists ["cfc"] metadata
    // inside prepareBoundaryCommit's privileged scope. This must NOT trip the
    // guard — i.e. legitimate CFC persistence still commits in enforce mode.
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
            secret: { type: "string", ifc: { confidentiality: ["base"] } },
          },
          required: ["secret"],
        } satisfies JSONSchema,
        true,
      );
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "s18-legit-persist",
        guarded.schema,
        tx,
      );
      cell.set({ secret: "value" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate value-path writes or full-document seeds (path [])", async () => {
    // The Cell API writes value paths, never the document ["cfc"] field, so
    // ordinary pattern writes are unaffected. A path-[] full-document seed
    // (the legitimate hydration/seed vector) is likewise not gated.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const plain = runtime.getCell<{ note: string }>(
        signer.did(),
        "s18-plain-value",
        undefined,
        tx,
      );
      plain.set({ note: "hello" });
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
