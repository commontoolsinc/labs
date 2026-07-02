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
}) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: opts.storageManager,
    cfcEnforcementMode: "enforce-explicit",
    ...(opts.cfcWriteFloor !== undefined
      ? { cfcWriteFloor: opts.cfcWriteFloor }
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

  it("a write elsewhere on the doc does not trip an untouched floor path", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const schema = {
        type: "object",
        properties: {
          out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
          note: { type: "string" },
        },
      } as const satisfies JSONSchema;
      // Establish the doc with the floor path present (via the minting shape),
      // then touch only the unprotected sibling.
      const seedTx = runtime.edit();
      const seeded = runtime.getCell(
        signer.did(),
        "wf-sibling-sink",
        {
          type: "object",
          properties: {
            out: {
              type: "string",
              ifc: {
                requiredIntegrity: [ADMIN_ATOM],
                addIntegrity: [ADMIN_ATOM],
              },
            },
            note: { type: "string" },
          },
        } as const satisfies JSONSchema,
        seedTx,
      );
      seeded.set({ out: "endorsed", note: "a" });
      seedTx.prepareCfc();
      expect((await seedTx.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "wf-sibling-sink",
        schema,
        tx,
      );
      sink.key("note").set("b");
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
