import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcWriteFloorMode } from "../src/cfc/mod.ts";

const signer = await Identity.fromPassphrase("runner-cfc-write-floor");

// Epic D3 (§8.12.4.1 / SC-18): the write-side `requiredIntegrity` FLOOR. The
// read-side gate (verifyInputRequirements) quantifies over consumed reads; the
// floor tests the WRITTEN VALUE's integrity — schema `addIntegrity` mints,
// carried link-view integrity, the flow hereditary meet — against the declared
// floor. Dial `cfcWriteFloor: off | observe | enforce`, default off.
const ADMIN_ATOM = "admin-approved";
const LLM_DERIVED_ATOM = {
  type: "https://commonfabric.org/cfc/atom/LlmDerived",
};

const FLOOR_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

// The declaring schema also MINTS the floor atom: writes through it carry the
// integrity they require (the authoring pattern for floor-protected paths).
const MINT_SCHEMA = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: {
        requiredIntegrity: [ADMIN_ATOM],
        addIntegrity: [ADMIN_ATOM],
      },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const makeRuntime = (opts: {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  cfcWriteFloor?: CfcWriteFloorMode;
  cfcFlowLabels?: "off" | "observe" | "persist";
}) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: opts.storageManager,
    cfcEnforcementMode: "enforce-explicit",
    ...(opts.cfcWriteFloor !== undefined
      ? { cfcWriteFloor: opts.cfcWriteFloor }
      : {}),
    ...(opts.cfcFlowLabels !== undefined
      ? { cfcFlowLabels: opts.cfcFlowLabels }
      : {}),
  });

// Seed a doc's stored CFC metadata directly via an ungated path-[] full-document
// write (how the runtime persists it), so a later link to it carries the label.
const seedLabeledDoc = async (
  runtime: Runtime,
  id: string,
  value: unknown,
  label: { integrity?: unknown[]; confidentiality?: unknown[] },
  path: string[] = [],
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
      labelMap: { version: 1, entries: [{ path, label }] },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

describe("CFC write-side requiredIntegrity floor (D3, §8.12.4.1)", () => {
  it("rejects an integrity-less write to a floor-declaring path under enforce", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-bare-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("flow-persist with an empty hereditary meet does not weaken the floor", async () => {
    // Under cfcFlowLabels:"persist" the floor credits the flow meet — but an
    // empty meet (the common case: some unlabeled read empties it) credits
    // nothing, so an unendorsed write still rejects. Pins the flowPersist
    // credit branch AND that flow mode cannot become an accidental bypass.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      cfcWriteFloor: "enforce",
      cfcFlowLabels: "persist",
    });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-flow-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("dial off (the default): the same write commits — byte-compat", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-off-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("observe: the write commits and a diagnostic records the miss", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "observe" });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-observe-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.includes("write-floor(observe)") && d.includes("write floor")
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a schema minting its own floor atom passes (addIntegrity credits the value)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-mint-sink",
        MINT_SCHEMA,
        tx,
      );
      sink.set({ out: "endorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("the floor is a minimum: extra minted integrity is fine", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          out: {
            type: "string",
            ifc: {
              requiredIntegrity: [ADMIN_ATOM],
              addIntegrity: [ADMIN_ATOM, "second-endorsement"],
            },
          },
        },
        required: ["out"],
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "wf-min-sink", schema, tx);
      sink.set({ out: "endorsed-plus" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an overwrite is checked against the DECLARED floor only, never the prior value's integrity", async () => {
    // Write 1 links /out to a source whose stored integrity is
    // [ADMIN_ATOM, "extra-endorsement"] — the prior VALUE's integrity exceeds
    // the floor. Write 2 replaces it with a plain value minting only the floor
    // atom. SC-18: sibling replacement B≱A with both ≥ floor conforms — the
    // prior value's richer integrity is never consulted (no meet across
    // successive writes), and integrity legitimately does not regrow.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(runtime, "wf-overwrite-src", "endorsed-rich", {
        integrity: [ADMIN_ATOM, "extra-endorsement"],
      });
      const seedTx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-overwrite-src",
        undefined,
        seedTx,
      );
      const first = runtime.getCell(
        signer.did(),
        "wf-overwrite-sink",
        MINT_SCHEMA,
        seedTx,
      );
      first.set({ out: src as unknown as string });
      seedTx.prepareCfc();
      expect((await seedTx.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-overwrite-sink",
        MINT_SCHEMA,
        tx,
      );
      sink.set({ out: "new" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a forged runtime-minted atom cannot satisfy a floor keyed to it (mint gate strips first)", async () => {
    // A pattern-authored schema self-attaching LlmDerived: the S4 mint gate
    // strips it from the persisted label, so the written value's integrity is
    // empty and the floor (keyed to LlmDerived) fails — forging evidence
    // satisfies nothing.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          out: {
            type: "string",
            ifc: {
              requiredIntegrity: [LLM_DERIVED_ATOM],
              addIntegrity: [LLM_DERIVED_ATOM],
            },
          },
        },
        required: ["out"],
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "wf-forged-sink", schema, tx);
      sink.set({ out: "forged" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a link whose source carries the floor atom passes (carried link-view integrity)", async () => {
    // The D2 by-reference contract on the write side: a floor-protected slot
    // accepts a REFERENCE to a value that genuinely carries the endorsement.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(runtime, "wf-link-src-good", "endorsed-value", {
        integrity: [ADMIN_ATOM],
      });
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-link-src-good",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-link-sink-good",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: src as unknown as string });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a link whose source lacks the floor atom is rejected", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      // An empty stored label: the source read is excluded from the READ-side
      // gate (same trust level as unlabeled), so the write-side FLOOR is the
      // check that rejects — which is the point of this test.
      await seedLabeledDoc(runtime, "wf-link-src-bad", "unendorsed-value", {});
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-link-src-bad",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-link-sink-bad",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: src as unknown as string });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a floor-less ifc entry on the same schema is skipped", async () => {
    // A confidentiality-only sibling declares an ifc entry with NO
    // requiredIntegrity — the floor loop skips it (floor.length === 0) and
    // still enforces the real floor field.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          pub: { type: "string", ifc: { confidentiality: ["c"] } },
          out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
        },
        required: ["pub", "out"],
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-floorless-sink",
        schema,
        tx,
      );
      sink.set({ pub: "visible", out: "unendorsed" });
      tx.prepareCfc();
      const result = await tx.commit();
      // The floor field still rejects; the confidentiality-only field is inert.
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed at /out",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a wildcard (*) floor entry is not enforced by the write floor (read-gate only, v1)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      // Array items produce a `*` floor entry path (walkIfcSchema), which the
      // write floor skips in v1 — the per-element read gate still covers it.
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "string",
              ifc: { requiredIntegrity: [ADMIN_ATOM] },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-wildcard-sink",
        schema,
        tx,
      );
      sink.set({ items: ["unendorsed"] });
      tx.prepareCfc();
      const result = await tx.commit();
      // The wildcard floor is skipped by verifyWriteFloor (v1 scope), so no
      // write-floor rejection.
      expect(
        String((result.error as Error | undefined)?.message ?? ""),
      ).not.toContain("write floor failed");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a link with no derivable source label is skipped by the floor (reason recorded elsewhere)", async () => {
    // A link whose source has no stored metadata and no candidate schema is
    // underivable: derivePersistedLinkLabel returns a reason (the persist loop
    // reports it), and the floor does not double-count it as a contribution.
    // The whole commit still rejects — via that missing-source reason.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-link-nometa-src",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-link-nometa-sink",
        FLOOR_SCHEMA,
        tx,
      );
      sink.set({ out: src as unknown as string });
      tx.prepareCfc();
      const result = await tx.commit();
      // Underivable link source => the commit rejects (missing link source
      // metadata), and the floor contributes nothing spurious.
      expect(result.error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an ancestor link cannot smuggle an unendorsed value under a nested floor", async () => {
    // Floor at /out/secret; the write links /out (an ANCESTOR) to a source
    // whose .secret carries no integrity. The nested value reconstructs as
    // undefined through the link, so without the ancestor-link check the floor
    // entry would be skipped entirely — the bypass this test pins closed.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(
        runtime,
        "wf-anc-src-bad",
        { secret: "unendorsed" },
        {},
      );
      const nestedFloor = {
        type: "object",
        properties: {
          out: {
            type: "object",
            properties: {
              secret: {
                type: "string",
                ifc: { requiredIntegrity: [ADMIN_ATOM] },
              },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-anc-src-bad",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-anc-sink-bad",
        nestedFloor,
        tx,
      );
      sink.set({ out: src as unknown as { secret: string } });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed at /out/secret",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an ancestor link whose source carries the nested floor atom passes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      await seedLabeledDoc(
        runtime,
        "wf-anc-src-good",
        { secret: "endorsed" },
        { integrity: [ADMIN_ATOM] },
        ["secret"],
      );
      const nestedFloor = {
        type: "object",
        properties: {
          out: {
            type: "object",
            properties: {
              secret: {
                type: "string",
                ifc: { requiredIntegrity: [ADMIN_ATOM] },
              },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const src = runtime.getCell(
        signer.did(),
        "wf-anc-src-good",
        undefined,
        tx,
      );
      const sink = runtime.getCell(
        signer.did(),
        "wf-anc-sink-good",
        nestedFloor,
        tx,
      );
      sink.set({ out: src as unknown as { secret: string } });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("clearing a floor-declaring path (delete) is not a floored write", async () => {
    // Establish the floor field with an endorsed value, then delete it. A
    // delete writes no value at the path, so the floor (which governs values,
    // not absence) does not reject.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          out: {
            type: "string",
            ifc: {
              requiredIntegrity: [ADMIN_ATOM],
              addIntegrity: [ADMIN_ATOM],
            },
          },
        },
      } as const satisfies JSONSchema;
      const seedTx = runtime.edit();
      const seeded = runtime.getCell(
        signer.did(),
        "wf-delete-sink",
        schema,
        seedTx,
      );
      seeded.set({ out: "endorsed" });
      seedTx.prepareCfc();
      expect((await seedTx.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "wf-delete-sink", schema, tx);
      sink.set({});
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("the enforce pin cannot be weakened mid-transaction", async () => {
    // Once the runtime sets `enforce` at tx creation, code that can reach the
    // transaction must not be able to dial the floor back down and slip a
    // violation through (mirrors the flow-labels persist pin).
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      expect(() => tx.setCfcWriteFloorMode("off")).toThrow(
        "cannot be weakened",
      );
      expect(() => tx.setCfcWriteFloorMode("observe")).toThrow(
        "cannot be weakened",
      );
      // Re-asserting enforce is fine.
      tx.setCfcWriteFloorMode("enforce");
      expect(tx.getCfcState().writeFloorMode).toBe("enforce");
      await tx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an unwritten floor path on the same schema is not enforced (only touched paths)", async () => {
    // The schema declares a floor at /out but only the unprotected /note is
    // written. `out` is absent from the attempted writes, so the floor entry
    // does not apply (ifcEntryAppliesToAttemptedWrite=false) and no rejection
    // follows — the floor governs paths this commit actually wrote.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
          note: { type: "string" },
        },
        required: ["note"],
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "wf-sibling-sink", schema, tx);
      sink.set({ note: "b" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
