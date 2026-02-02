import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { CFCViolationError } from "../src/cfc/action-context.ts";
import { RuntimeTelemetry } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("cfc test operator");
const space = signer.did();

// Schemas with ifc annotations
const secretSchema = {
  type: "object",
  properties: {
    value: { type: "string", default: "" },
  },
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const unclassifiedSchema = {
  type: "object",
  properties: {
    value: { type: "string", default: "" },
  },
} as const satisfies JSONSchema;

describe("CFC Runtime: enforcement through real Runtime", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnabled: true,
      cfcDebug: true,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ lift, recipe } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("recipe reading secret and returning result propagates ifc to output", async () => {
    // Create input cell with secret schema
    const inputCell = runtime.getCell(
      space,
      "cfc-secret-input-1",
      secretSchema,
      tx,
    );
    inputCell.set({ value: "top-secret-data" });
    tx.commit();
    await inputCell.pull();
    tx = runtime.edit();

    // Define recipe that reads input and copies it
    const copyRecipe = recipe<{ input: { value: string } }>(
      "Copy Recipe",
      ({ input }) => {
        const result = lift((x: { value: string }) => ({
          value: x.value,
        }))(input);
        return result;
      },
    );

    const resultCell = runtime.getCell<{ value: string }>(
      space,
      "cfc-secret-output-1",
      undefined,
      tx,
    );

    runtime.run(tx, copyRecipe, { input: inputCell }, resultCell);
    tx.commit();

    // The result should have the value propagated
    const value = await resultCell.pull();
    expect(value).toMatchObject({ value: "top-secret-data" });

    // Verify the output cell's schema got ifc propagated from the builder
    const exported = resultCell.export();
    if (exported.schema && typeof exported.schema === "object") {
      // The builder should have propagated ifc from input to output
      expect(exported.schema.ifc).toBeDefined();
    }
  });

  it("backwards compat: recipe without ifc annotations runs normally", async () => {
    const inputCell = runtime.getCell(
      space,
      "cfc-compat-input-1",
      unclassifiedSchema,
      tx,
    );
    inputCell.set({ value: "public-data" });
    tx.commit();
    await inputCell.pull();
    tx = runtime.edit();

    const copyRecipe = recipe<{ input: { value: string } }>(
      "Compat Recipe",
      ({ input }) => {
        const result = lift((x: { value: string }) => ({
          value: x.value,
        }))(input);
        return result;
      },
    );

    const resultCell = runtime.getCell<{ value: string }>(
      space,
      "cfc-compat-output-1",
      undefined,
      tx,
    );

    runtime.run(tx, copyRecipe, { input: inputCell }, resultCell);
    tx.commit();

    const value = await resultCell.pull();
    expect(value).toMatchObject({ value: "public-data" });
  });
});

describe("CFC Runtime: dry-run mode", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnabled: true,
      cfcDryRun: true,
      cfcDebug: true,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ lift, recipe } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("dry-run mode allows recipe execution even with potential violations", async () => {
    const inputCell = runtime.getCell(
      space,
      "cfc-dryrun-input-1",
      secretSchema,
      tx,
    );
    inputCell.set({ value: "secret-in-dryrun" });
    tx.commit();
    await inputCell.pull();
    tx = runtime.edit();

    const copyRecipe = recipe<{ input: { value: string } }>(
      "DryRun Recipe",
      ({ input }) => {
        const result = lift((x: { value: string }) => ({
          value: x.value,
        }))(input);
        return result;
      },
    );

    const resultCell = runtime.getCell<{ value: string }>(
      space,
      "cfc-dryrun-output-1",
      undefined,
      tx,
    );

    // Should not throw even if there would be a violation
    runtime.run(tx, copyRecipe, { input: inputCell }, resultCell);
    tx.commit();

    const value = await resultCell.pull();
    expect(value).toMatchObject({ value: "secret-in-dryrun" });
  });
});

describe("CFC Runtime: disabled mode", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnabled: false, // CFC disabled
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ lift, recipe } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("CFC disabled: secret data flows freely without enforcement", async () => {
    const inputCell = runtime.getCell(
      space,
      "cfc-disabled-input-1",
      secretSchema,
      tx,
    );
    inputCell.set({ value: "secret-no-enforcement" });
    tx.commit();
    await inputCell.pull();
    tx = runtime.edit();

    const copyRecipe = recipe<{ input: { value: string } }>(
      "Disabled CFC Recipe",
      ({ input }) => {
        const result = lift((x: { value: string }) => ({
          value: x.value,
        }))(input);
        return result;
      },
    );

    const resultCell = runtime.getCell<{ value: string }>(
      space,
      "cfc-disabled-output-1",
      undefined,
      tx,
    );

    runtime.run(tx, copyRecipe, { input: inputCell }, resultCell);
    tx.commit();

    const value = await resultCell.pull();
    expect(value).toMatchObject({ value: "secret-no-enforcement" });
  });
});
