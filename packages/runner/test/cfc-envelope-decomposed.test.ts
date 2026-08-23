import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { CfcMetadata } from "../src/cfc/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-envelope-decomposed");
const space = signer.did();

// A declared schema whose `$defs` member gives the decomposition something
// to split: version-2 envelopes store the root and the definition as
// separate content-addressed documents.
const DECLARED_SCHEMA = {
  type: "object",
  properties: {
    secret: { $ref: "#/$defs/Classified" },
    note: { type: "string" },
  },
  required: ["secret"],
  $defs: {
    Classified: {
      type: "string",
      ifc: { confidentiality: ["decomposed-secret"] },
    },
  },
} as const satisfies JSONSchema;

const makeRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcDecomposedEnvelopes: true,
  });

/**
 * One declared-schema write to `name`; resolves with the staged `cid:`
 * document ids and the stored metadata the commit left behind.
 */
const declaredWrite = async (
  runtime: Runtime,
  name: string,
): Promise<{ cidWrites: string[]; stored: CfcMetadata | undefined }> => {
  const tx = runtime.edit();
  const cell = runtime.getCell(space, name, DECLARED_SCHEMA, tx);
  cell.set({ secret: "classified", note: "plain" });
  tx.prepareCfc();
  const cidWrites = [...tx.getWriteDetails?.(space) ?? []]
    .map((detail) => detail.address.id)
    .filter((id) => id.startsWith("cid:"));
  expect((await tx.commit()).ok).toBeDefined();
  const targetId = cell.getAsNormalizedFullLink().id;
  const stored = (runtime.storageManager.open(space).replica as unknown as {
    getDocument(id: string): { cfc?: CfcMetadata } | undefined;
  }).getDocument(targetId);
  return { cidWrites, stored: stored?.cfc };
};

describe("CFC decomposed envelopes", () => {
  it("persists an envelope whose root and definition are separate documents", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const { cidWrites, stored } = await declaredWrite(
        runtime,
        "decomposed-target",
      );
      expect(stored?.version).toBe(1);
      expect(stored?.labelMap.entries.length).toBeGreaterThan(0);
      // The root rides the transaction, and so does the `$defs` member the
      // decomposition split out — at least two distinct documents.
      expect(cidWrites).toContain(`cid:${stored!.schemaHash}`);
      expect(new Set(cidWrites).size).toBeGreaterThanOrEqual(2);

      // The stored ROOT is the decomposed spelling: its definition arrives
      // by reference, not inline.
      const rootDoc = (runtime.storageManager.open(space)
        .replica as unknown as {
          getDocument(id: string): { value?: unknown } | undefined;
        }).getDocument(`cid:${stored!.schemaHash}`);
      expect(JSON.stringify(rootDoc?.value)).toContain('"cid:');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("re-derives the same decomposed envelope from the recomposed stored form (SC-11 skip)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const first = await declaredWrite(runtime, "decomposed-idempotent");
      expect(first.stored?.version).toBe(1);
      await storageManager.synced();

      // The same declared write again: the stored envelope loads through
      // recomposition, the merge covers the candidate, and the re-derived
      // metadata is canonically identical — nothing rewrites.
      const tx = runtime.edit();
      const cell = runtime.getCell(
        space,
        "decomposed-idempotent",
        DECLARED_SCHEMA,
        tx,
      );
      cell.set({ secret: "classified", note: "updated" });
      tx.prepareCfc();
      const cidWrites = [...tx.getWriteDetails?.(space) ?? []]
        .map((detail) => detail.address.id)
        .filter((id) => id.startsWith("cid:"));
      expect((await tx.commit()).ok).toBeDefined();
      expect(cidWrites).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("elides the confirmed closure on a second document sharing the schema", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const first = await declaredWrite(runtime, "decomposed-elide-a");
      expect(first.cidWrites.length).toBeGreaterThanOrEqual(2);
      await storageManager.synced();

      const second = await declaredWrite(runtime, "decomposed-elide-b");
      expect(second.stored?.schemaHash).toBe(first.stored?.schemaHash);
      expect(second.cidWrites).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("stores inline when the schema refuses decomposition", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      // The deprecated `definitions` keyword refuses decomposition, so the
      // envelope stays in the self-contained inline spelling, flag or not.
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "undecomposable-target", {
        type: "object",
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["kept"] } },
        },
        required: ["secret"],
        definitions: { Legacy: { type: "string" } },
      } as JSONSchema, tx);
      cell.set({ secret: "classified" });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
      const targetId = cell.getAsNormalizedFullLink().id;
      const stored = (runtime.storageManager.open(space).replica as unknown as {
        getDocument(id: string): { cfc?: CfcMetadata } | undefined;
      }).getDocument(targetId);
      const envDoc = (runtime.storageManager.open(space).replica as unknown as {
        getDocument(id: string): { value?: unknown } | undefined;
      }).getDocument(`cid:${stored!.cfc!.schemaHash}`);
      expect(JSON.stringify(envDoc?.value)).not.toContain('"cid:');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps the version-1 inline form with the flag off", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "inline-target", DECLARED_SCHEMA, tx);
      cell.set({ secret: "classified", note: "plain" });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
      const targetId = cell.getAsNormalizedFullLink().id;
      const stored = (runtime.storageManager.open(space).replica as unknown as {
        getDocument(id: string): { cfc?: CfcMetadata } | undefined;
      }).getDocument(targetId);
      expect(stored?.cfc?.version).toBe(1);
      const envDoc = (runtime.storageManager.open(space).replica as unknown as {
        getDocument(id: string): { value?: unknown } | undefined;
      }).getDocument(`cid:${stored!.cfc!.schemaHash}`);
      expect(JSON.stringify(envDoc?.value)).not.toContain('"cid:');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
