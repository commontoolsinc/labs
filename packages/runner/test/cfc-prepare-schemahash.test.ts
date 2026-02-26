import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import { computeCfcSchemaHash } from "../src/cfc/schema-hash.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc prepare schemahash test");
const space = signer.did();

const ifcObjectSchema = {
  type: "object",
  properties: {
    count: { type: "number" },
  },
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const differentIfcObjectSchema = {
  type: "object",
  properties: {
    count: { type: "string" },
  },
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const nestedIfcObjectSchema = {
  type: "object",
  properties: {
    public: { type: "number" },
    secret: {
      type: "number",
      ifc: { classification: ["secret"] },
    },
    signed: {
      type: "string",
      ifc: { integrity: ["trusted-source"] },
    },
  },
  ifc: { classification: ["confidential"] },
} as const satisfies JSONSchema;

const exactCopyIfcObjectSchema = {
  type: "object",
  properties: {
    count: {
      type: "number",
      ifc: {
        exactCopyOf: "/source",
      },
    },
  },
  ifc: {
    classification: ["secret"],
  },
} as const satisfies JSONSchema;

describe("CFC prepare schema hash", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function readCfcPath(
    id: URI,
    path: readonly string[],
  ): Promise<unknown> {
    const tx = runtime.edit();
    const value = tx.readOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", ...path],
    });
    const { error } = await tx.commit();
    if (error) {
      throw new Error(`failed to read schemaHash: ${error.name}`);
    }
    return value;
  }

  async function readSchemaHash(id: URI): Promise<unknown> {
    return await readCfcPath(id, ["schemaHash"]);
  }

  it("persists cfc.schemaHash during prepare for relevant writes", async () => {
    const tx = runtime.edit();
    const cell = runtime.getCell<{ count: number }>(
      space,
      "cfc-prepare-schemahash-persist",
      ifcObjectSchema,
      tx,
    );
    const link = cell.getAsNormalizedFullLink();
    cell.set({ count: 1 });

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();

    const persistedSchemaHash = await readSchemaHash(link.id);
    const expectedSchemaHash = await computeCfcSchemaHash(ifcObjectSchema);
    expect(persistedSchemaHash).toBe(expectedSchemaHash);
  });

  it("persists cfc.labels including inherited path classifications", async () => {
    const tx = runtime.edit();
    const cell = runtime.getCell<{ count: number }>(
      space,
      "cfc-prepare-labels-persist",
      ifcObjectSchema,
      tx,
    );
    const link = cell.getAsNormalizedFullLink();
    cell.set({ count: 1 });

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();

    const persistedLabels = await readCfcPath(link.id, ["labels"]);
    expect(persistedLabels).toEqual({
      "/": {
        classification: ["secret"],
      },
      "/count": {
        classification: ["secret"],
      },
    });
  });

  it("persists nested path labels with classification joins and integrity", async () => {
    const tx = runtime.edit();
    const cell = runtime.getCell<
      { public: number; secret: number; signed: string }
    >(
      space,
      "cfc-prepare-labels-nested-persist",
      nestedIfcObjectSchema,
      tx,
    );
    const link = cell.getAsNormalizedFullLink();
    cell.set({
      public: 1,
      secret: 2,
      signed: "ok",
    });

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();

    const persistedLabels = await readCfcPath(link.id, ["labels"]);
    expect(persistedLabels).toEqual({
      "/": {
        classification: ["confidential"],
      },
      "/public": {
        classification: ["confidential"],
      },
      "/secret": {
        classification: ["secret"],
      },
      "/signed": {
        classification: ["confidential"],
        integrity: ["trusted-source"],
      },
    });
  });

  it("commits when existing cfc.schemaHash matches", async () => {
    const tx1 = runtime.edit();
    const cell1 = runtime.getCell<{ count: number }>(
      space,
      "cfc-prepare-schemahash-match",
      ifcObjectSchema,
      tx1,
    );
    const link = cell1.getAsNormalizedFullLink();
    cell1.set({ count: 1 });
    await prepareCfcCommitIfNeeded(tx1);
    const firstCommit = await tx1.commit();
    expect(firstCommit.error).toBeUndefined();

    const tx2 = runtime.edit();
    const cell2 = runtime.getCell<{ count: number }>(
      space,
      "cfc-prepare-schemahash-match",
      ifcObjectSchema,
      tx2,
    );
    cell2.set({ count: 2 });
    await prepareCfcCommitIfNeeded(tx2);
    const secondCommit = await tx2.commit();
    expect(secondCommit.error).toBeUndefined();

    const persistedSchemaHash = await readSchemaHash(link.id);
    const expectedSchemaHash = await computeCfcSchemaHash(ifcObjectSchema);
    expect(persistedSchemaHash).toBe(expectedSchemaHash);
  });

  it("rejects prepare when existing cfc.schemaHash mismatches", async () => {
    const id = runtime.getCell(space, "cfc-prepare-schemahash-mismatch")
      .getAsNormalizedFullLink().id;
    const mismatchedSchemaHash = await computeCfcSchemaHash(
      differentIfcObjectSchema,
    );

    const seedTx = runtime.edit();
    seedTx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, { count: 0 });
    seedTx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "schemaHash"],
    }, mismatchedSchemaHash);
    const seeded = await seedTx.commit();
    expect(seeded.error).toBeUndefined();

    const tx = runtime.edit();
    const cell = runtime.getCell<{ count: number }>(
      space,
      "cfc-prepare-schemahash-mismatch",
      ifcObjectSchema,
      tx,
    );
    cell.set({ count: 1 });

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcSchemaHashMismatchError",
    );
    expect(
      (thrown as { expectedSchemaHash?: string } | undefined)
        ?.expectedSchemaHash,
    ).toBe(mismatchedSchemaHash);
  });

  it("rejects on schema hash mismatch before output transition checks", async () => {
    const id = runtime.getCell(space, "cfc-prepare-schemahash-priority")
      .getAsNormalizedFullLink().id;
    const mismatchedSchemaHash = await computeCfcSchemaHash(ifcObjectSchema);

    const seedTx = runtime.edit();
    seedTx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, { count: 0 });
    seedTx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "schemaHash"],
    }, mismatchedSchemaHash);
    const seeded = await seedTx.commit();
    expect(seeded.error).toBeUndefined();

    const tx = runtime.edit();
    const cell = runtime.getCell<{ count: number }>(
      space,
      "cfc-prepare-schemahash-priority",
      exactCopyIfcObjectSchema,
      tx,
    );
    cell.set({ count: 1 });

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcSchemaHashMismatchError",
    );
  });

  it("rejects prepare when relevant write has no captured schema", async () => {
    const id = runtime.getCell(space, "cfc-prepare-schemahash-missing-context")
      .getAsNormalizedFullLink().id;

    const tx = runtime.edit();
    const writeResult = tx.write({
      space,
      id,
      type: "application/json",
      path: [],
    }, { value: { x: 1 } });
    expect(writeResult.error).toBeUndefined();
    tx.markCfcRelevant("ifc-write-schema");

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcPrepareSchemaUnavailableError",
    );
  });

  it("allows schema hash migration when explicit hook authorizes it", async () => {
    const id = runtime.getCell(space, "cfc-prepare-schemahash-migration-hook")
      .getAsNormalizedFullLink().id;
    const mismatchedSchemaHash = await computeCfcSchemaHash(
      differentIfcObjectSchema,
    );

    const seedTx = runtime.edit();
    seedTx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, { count: 0 });
    seedTx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "schemaHash"],
    }, mismatchedSchemaHash);
    const seeded = await seedTx.commit();
    expect(seeded.error).toBeUndefined();

    const tx = runtime.edit();
    const cell = runtime.getCell<{ count: number }>(
      space,
      "cfc-prepare-schemahash-migration-hook",
      ifcObjectSchema,
      tx,
    );
    cell.set({ count: 1 });

    await prepareBoundaryCommit(tx, {
      allowSchemaHashMigration: () => true,
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();

    const persistedSchemaHash = await readSchemaHash(id);
    const expectedSchemaHash = await computeCfcSchemaHash(ifcObjectSchema);
    expect(persistedSchemaHash).toBe(expectedSchemaHash);
  });
});
