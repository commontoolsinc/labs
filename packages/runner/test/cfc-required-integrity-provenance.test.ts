import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-ri-provenance");

// Audit S7: verifyInputRequirements quantifies requiredIntegrity over EVERY
// labeled read in the transaction (transaction-global). A read that carries
// only structural/identity PROVENANCE (a link dereference, a current-principal
// claim) — never an endorsement — then false-rejects an unrelated protected
// write. Concrete in cfc-group-chat-demo: granting admin reads
// adminRegistry.bootstrapAdmin.subject (label [represents-principal,
// LinkReference]) and that read fails the admins list's
// requiredIntegrity:[group-chat-admin]. Fix (audit candidate D, vetted by the
// oracle as the only incremental scoping that keeps the cross-cell
// prompt-injection screen sound): drop a consumed read from the gate only when
// it carries no confidentiality and its integrity is entirely non-endorsement
// provenance. A confidentiality-bearing read (the prompt-injection briefing)
// still gates.
const LINK_REFERENCE_ATOM = {
  type: "https://commonfabric.org/cfc/atom/LinkReference",
};
const REPRESENTS_PRINCIPAL_ATOM = {
  kind: "represents-principal",
  subject: signer.did(),
};
const ADMIN_ATOM = "group-chat-admin";

// Seed a doc's stored CFC metadata directly via an ungated path-[] full-document
// write (how the runtime persists it), so a later read picks up the given label.
const seedLabeledDoc = async (
  runtime: Runtime,
  id: string,
  value: unknown,
  label: { integrity?: unknown[]; confidentiality?: unknown[] },
): Promise<void> => {
  const seed = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, undefined, seed);
  const docId = cell.getAsNormalizedFullLink().id as URI;
  seed.writeOrThrow({
    space: signer.did(),
    id: docId,
    type: "application/json",
    path: [],
  }, {
    value,
    cfc: {
      version: 1,
      schemaHash: `seed-${id}`,
      labelMap: { version: 1, entries: [{ path: [], label }] },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

const SINK_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

describe("CFC requiredIntegrity provenance scoping (S7)", () => {
  it("a provenance-only read does not gate a requiredIntegrity write", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      // A lookup doc whose stored label is entirely provenance: a link
      // reference + a current-principal claim, no confidentiality.
      await seedLabeledDoc(runtime, "ri-prov-lookup", "lookup", {
        integrity: [REPRESENTS_PRINCIPAL_ATOM, LINK_REFERENCE_ATOM],
      });

      const tx = runtime.edit();
      // Read the provenance-only lookup (records a confidential-free, provenance
      // labeled read), then write the protected sink in the same tx.
      runtime.getCell(signer.did(), "ri-prov-lookup", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "ri-prov-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "granted" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a confidentiality-bearing read still gates requiredIntegrity (prompt-injection soundness)", async () => {
    // The security side: a read that carries confidentiality (like the
    // prompt-injection briefing) and lacks the required atom must STILL fail —
    // it is a genuine data input, not provenance. This is what keeps the
    // cross-cell prompt-injection screen sound under the fix.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      await seedLabeledDoc(runtime, "ri-conf-src", "briefing", {
        confidentiality: ["prompt-injection-risk"],
      });

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "ri-conf-src", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "ri-conf-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "derived" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "requiredIntegrity failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a read mixing a real integrity atom with provenance still gates", async () => {
    // Only ENTIRELY-provenance reads are excluded. A read carrying a genuine
    // (non-provenance) integrity atom that isn't the required one must still
    // fail — provenance riding alongside real data must not launder it.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      await seedLabeledDoc(runtime, "ri-mixed-src", "data", {
        // "other-endorsement" is a genuine endorsement atom, not provenance.
        integrity: [LINK_REFERENCE_ATOM, "other-endorsement"],
      });

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "ri-mixed-src", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "ri-mixed-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "derived" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "requiredIntegrity failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
