import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
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
} satisfies FabricValue;

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
      }, forgedMetadata);

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
      }, forgedMetadata);

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

  it("exposes no privilege-escalation method on the transaction (S18 review)", async () => {
    // The reviewer's scenario: (cell.tx as any).runPrivilegedSystemWrite(() =>
    // cell.tx.writeOrThrow({ path: ["cfc"] }, forged)). The scope is now an
    // ECMAScript #private method, so no such property exists on the tx — and a
    // direct ["cfc"] write therefore still fails closed.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      expect("runPrivilegedSystemWrite" in tx).toBe(false);
      // And nothing under the tx wrapper exposes it either.
      expect("runPrivilegedSystemWrite" in tx.tx).toBe(false);
      await tx.commit();
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

  it("records a ['cfc'] write made while disabled so a mid-tx escalation to enforce rejects", async () => {
    // setCfcEnforcementMode permits raising the mode mid-transaction
    // (disabled/observe impose no floor — audit S3), so a forged ["cfc"] write
    // performed in a disabled window must not survive a later escalation to
    // enforce. Like every other CFC signal, the write is recorded
    // unconditionally and only evaluated against the mode at prepare/commit
    // time.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-escalate",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      // Forge the label map while the transaction is still disabled.
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);
      // The forgery is recorded even though enforcement is disabled.
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(1);

      tx.setCfcEnforcementMode("enforce-explicit");
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

  it("still commits a never-escalated transaction under disabled mode", async () => {
    // `disabled` leaves CFC inert end-to-end: the forged write is recorded
    // (see above) but prepareBoundaryCommit never runs for a transaction whose
    // mode is still disabled at commit, so nothing turns the record into a
    // rejection.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-disabled",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate value-path writes", async () => {
    // The Cell API writes value paths, never the document ["cfc"] field, so
    // ordinary pattern writes are unaffected.
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

  it("does not gate a path-[] full-document write carrying a cfc field", async () => {
    // Documented deferred residual: the guard keys on path[0] === "cfc", so a
    // path-[] full-document write whose value embeds a `cfc` record is NOT
    // gated. This is the shape hydration delivers and the raw-seed idiom other
    // CFC tests rely on (seedPrivilegedCfc in cfc-boundary.test.ts); per the
    // sandbox invariant only the logical `value` surface is exposed to
    // untrusted or user-authored code (docs/plans/runner_cfc_implementation.md
    // "Document Surface Rules"), so untrusted code cannot reach this vector.
    // If document-root writes ever become reachable from untrusted code, this
    // test documents the seam that must then be gated.
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
        "s18-root-seed",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      // Mirror seedPrivilegedCfc: read the current doc, then write the whole
      // envelope at path [] with the cfc record embedded.
      const docAddress = {
        space: signer.did(),
        id,
        type: "application/json" as const,
        path: [],
      };
      let current: unknown;
      try {
        current = tx.readOrThrow(docAddress);
      } catch {
        current = undefined;
      }
      const base = current && typeof current === "object" ? current : {};
      tx.writeOrThrow(
        docAddress,
        { ...base, cfc: forgedMetadata },
      );
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(0);

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
