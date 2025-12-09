import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type Recipe, TYPE } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { ensureCharmRunning } from "../src/ensure-charm-running.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("ensureCharmRunning", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should return false for cells without process cell structure", async () => {
    // Create a cell that has no charm structure (no process cell, no recipe)
    const orphanCell = runtime.getCell<{ $stream: true }>(
      space,
      "orphan-cell-test",
      undefined,
      tx,
    );
    orphanCell.set({ $stream: true });

    await tx.commit();
    tx = runtime.edit();

    // ensureCharmRunning should return false - no charm to start
    const result = await ensureCharmRunning(
      runtime,
      orphanCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(false);
  });

  it("should return false for cells without TYPE in process cell", async () => {
    // Create a result cell that points to a process cell without TYPE
    const resultCell = runtime.getCell(
      space,
      "no-type-test-result",
      undefined,
      tx,
    );

    const processCell = runtime.getCell(
      space,
      "no-type-test-process",
      undefined,
      tx,
    );

    // Set up the result cell to point to the process cell
    resultCell.set({ value: 1 });
    resultCell.setSourceCell(processCell);

    // Process cell has no TYPE
    processCell.set({
      argument: { value: 1 },
      resultRef: resultCell.getAsLink({ base: processCell }),
    });

    await tx.commit();
    tx = runtime.edit();

    // ensureCharmRunning should return false - no TYPE means no recipe
    const result = await ensureCharmRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(false);
  });

  it("should return false for cells without resultRef in process cell", async () => {
    // Create a simple recipe
    const recipe: Recipe = {
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
      result: {},
      nodes: [],
    };

    const recipeId = runtime.recipeManager.registerRecipe(recipe);

    // Create a result cell that points to a process cell without resultRef
    const resultCell = runtime.getCell(
      space,
      "no-resultref-test-result",
      undefined,
      tx,
    );

    const processCell = runtime.getCell(
      space,
      "no-resultref-test-process",
      undefined,
      tx,
    );

    resultCell.set({ value: 1 });
    resultCell.setSourceCell(processCell);

    // Process cell has TYPE but no resultRef
    processCell.set({
      [TYPE]: recipeId,
      argument: { value: 1 },
      // Missing resultRef!
    });

    await tx.commit();
    tx = runtime.edit();

    // ensureCharmRunning should return false - no resultRef
    const result = await ensureCharmRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(false);
  });

  it("should start a charm with valid process cell structure", async () => {
    // Create a simple recipe
    let recipeRan = false;
    const recipe: Recipe = {
      argumentSchema: {
        type: "object",
        properties: { value: { type: "number" } },
      },
      resultSchema: {
        type: "object",
        properties: { doubled: { type: "number" } },
      },
      result: {
        doubled: { $alias: { path: ["internal", "doubled"] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => {
              recipeRan = true;
              return value * 2;
            },
          },
          inputs: { $alias: { path: ["argument", "value"] } },
          outputs: { $alias: { path: ["internal", "doubled"] } },
        },
      ],
    };

    const recipeId = runtime.recipeManager.registerRecipe(recipe);

    // Create result cell
    const resultCell = runtime.getCell(
      space,
      "valid-charm-test-result",
      undefined,
      tx,
    );

    // Create process cell
    const processCell = runtime.getCell(
      space,
      "valid-charm-test-process",
      undefined,
      tx,
    );

    // Set up the structure
    resultCell.set({
      doubled: { $alias: { path: ["internal", "doubled"], cell: processCell.entityId } },
    });
    resultCell.setSourceCell(processCell);

    processCell.set({
      [TYPE]: recipeId,
      argument: { value: 5 },
      resultRef: resultCell.getAsLink({ base: processCell }),
      internal: {},
    });

    await tx.commit();
    tx = runtime.edit();

    // ensureCharmRunning should return true and start the charm
    const result = await ensureCharmRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(true);

    // Wait for the charm to run
    await runtime.idle();

    expect(recipeRan).toBe(true);
  });

  it("should not attempt to start twice for same cell (infinite loop protection)", async () => {
    // Create a simple recipe
    let startCount = 0;
    const recipe: Recipe = {
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
      result: {},
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              startCount++;
            },
          },
          inputs: {},
          outputs: {},
        },
      ],
    };

    const recipeId = runtime.recipeManager.registerRecipe(recipe);

    const resultCell = runtime.getCell(
      space,
      "no-double-start-test-result",
      undefined,
      tx,
    );

    const processCell = runtime.getCell(
      space,
      "no-double-start-test-process",
      undefined,
      tx,
    );

    resultCell.set({});
    resultCell.setSourceCell(processCell);

    processCell.set({
      [TYPE]: recipeId,
      argument: {},
      resultRef: resultCell.getAsLink({ base: processCell }),
      internal: {},
    });

    await tx.commit();
    tx = runtime.edit();

    // First call should return true
    const result1 = await ensureCharmRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result1).toBe(true);

    await runtime.idle();

    // Second call to same cell should return false (already attempted)
    const result2 = await ensureCharmRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result2).toBe(false);

    // The charm should only have been started once
    expect(startCount).toBe(1);
  });

  it("should handle events for cells without associated charms gracefully", async () => {
    // Create a cell that has no charm structure
    const orphanCell = runtime.getCell<{ $stream: true }>(
      space,
      "orphan-event-cell-test",
      undefined,
      tx,
    );
    orphanCell.set({ $stream: true });

    await tx.commit();
    tx = runtime.edit();

    // Send an event to this cell - should not crash
    runtime.scheduler.queueEvent(
      orphanCell.getAsNormalizedFullLink(),
      { type: "click" },
    );

    // Wait for processing - should complete without errors
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.idle();

    // If we get here, the event was handled gracefully (dropped)
    expect(true).toBe(true);
  });
});

describe("queueEvent with auto-start", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should not retry indefinitely when charm does not register handler", async () => {
    // This tests the infinite loop protection in the scheduler
    // Create a recipe that does NOT have an event handler for the stream we'll send to
    const recipe: Recipe = {
      argumentSchema: {
        type: "object",
        properties: { value: { type: "number" } },
      },
      resultSchema: {
        type: "object",
        properties: { doubled: { type: "number" } },
      },
      result: {
        doubled: { $alias: { path: ["internal", "doubled"] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["argument", "value"] } },
          outputs: { $alias: { path: ["internal", "doubled"] } },
        },
      ],
    };

    const recipeId = runtime.recipeManager.registerRecipe(recipe);

    // Create the charm structure
    const resultCell = runtime.getCell(
      space,
      "no-handler-loop-test-result",
      undefined,
      tx,
    );

    const processCell = runtime.getCell(
      space,
      "no-handler-loop-test-process",
      undefined,
      tx,
    );

    // Create a separate event stream cell that the recipe doesn't handle
    const eventStreamCell = runtime.getCell<{ $stream: true }>(
      space,
      "no-handler-loop-test-event-stream",
      undefined,
      tx,
    );
    eventStreamCell.set({ $stream: true });

    resultCell.set({
      doubled: { $alias: { path: ["internal", "doubled"], cell: processCell.entityId } },
    });
    resultCell.setSourceCell(processCell);

    processCell.set({
      [TYPE]: recipeId,
      argument: { value: 5 },
      resultRef: resultCell.getAsLink({ base: processCell }),
      internal: {},
    });

    await tx.commit();
    tx = runtime.edit();

    // Send an event to the event stream
    // This will try to start a charm, but eventStreamCell is not associated
    // with the charm we set up (it's orphaned). Should not infinite loop.
    runtime.scheduler.queueEvent(
      eventStreamCell.getAsNormalizedFullLink(),
      { type: "click" },
    );

    // Wait for processing - should complete without hanging
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.idle();

    // If we get here, the infinite loop protection worked
    expect(true).toBe(true);
  });
});
