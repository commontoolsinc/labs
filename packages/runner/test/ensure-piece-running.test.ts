import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type Recipe, TYPE } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { ensurePieceRunning } from "../src/ensure-piece-running.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("ensurePieceRunning", () => {
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
    // Create a cell that has no piece structure (no process cell, no recipe)
    const orphanCell = runtime.getCell<{ $stream: true }>(
      space,
      "orphan-cell-test",
      undefined,
      tx,
    );
    orphanCell.set({ $stream: true });

    await tx.commit();
    tx = runtime.edit();

    // ensurePieceRunning should return false - no piece to start
    const result = await ensurePieceRunning(
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

    // ensurePieceRunning should return false - no TYPE means no recipe
    const result = await ensurePieceRunning(
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

    // ensurePieceRunning should return false - no resultRef
    const result = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(false);
  });

  it("should start a piece with valid process cell structure", async () => {
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
      "valid-piece-test-result",
      undefined,
      tx,
    );

    // Create process cell
    const processCell = runtime.getCell(
      space,
      "valid-piece-test-process",
      undefined,
      tx,
    );

    // Set up the structure
    resultCell.set({
      doubled: {
        $alias: { path: ["internal", "doubled"], cell: processCell.entityId },
      },
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

    // ensurePieceRunning should return true and start the piece
    const result = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(true);

    // Wait for the piece to run
    await resultCell.pull();

    expect(recipeRan).toBe(true);
  });

  it("should be idempotent - calling multiple times is safe", async () => {
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
      "idempotent-start-test-result",
      undefined,
      tx,
    );

    const processCell = runtime.getCell(
      space,
      "idempotent-start-test-process",
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

    // First call should return true (piece started)
    const result1 = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result1).toBe(true);

    await resultCell.pull();

    // Second call should also return true - ensurePieceRunning doesn't track
    // previous calls because runtime.runSynced() is idempotent for already-running pieces
    const result2 = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result2).toBe(true);

    // The piece's lift should only have run once because runSynced is idempotent
    expect(startCount).toBe(1);
  });

  it("should restart a stopped piece when called again", async () => {
    // Create a simple recipe that tracks how many times it starts
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
      "restart-after-stop-test-result",
      undefined,
      tx,
    );

    const processCell = runtime.getCell(
      space,
      "restart-after-stop-test-process",
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

    // First call should start the piece
    const result1 = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result1).toBe(true);

    await resultCell.pull();
    expect(startCount).toBe(1);

    // Stop the piece
    runtime.runner.stop(resultCell);

    // Call again - should restart the piece since it was stopped
    const result2 = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );
    expect(result2).toBe(true);

    await resultCell.pull();

    // The piece's lift should have run twice now (once for each start)
    expect(startCount).toBe(2);
  });

  it("should handle events for cells without associated pieces gracefully", async () => {
    // Create a cell that has no piece structure
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

  it("should start piece when event sent to result cell path, but not retry if no handler", async () => {
    // Create a recipe with a reactive lift (to prove it starts) but NO event handler
    let liftRunCount = 0;

    const recipe: Recipe = {
      argumentSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      },
      resultSchema: {
        type: "object",
        properties: {
          doubled: { type: "number" },
          events: { type: "object" },
        },
      },
      initial: {
        internal: {
          events: { $stream: true },
        },
      },
      result: {
        doubled: { $alias: { path: ["internal", "doubled"] } },
        events: { $alias: { path: ["internal", "events"] } },
      },
      nodes: [
        {
          // This lift will run when the piece starts, proving the piece started
          module: {
            type: "javascript",
            implementation: (value: number) => {
              liftRunCount++;
              return value * 2;
            },
          },
          inputs: { $alias: { path: ["argument", "value"] } },
          outputs: { $alias: { path: ["internal", "doubled"] } },
        },
        // Note: NO handler node for events - this is intentional
      ],
    };

    const recipeId = runtime.recipeManager.registerRecipe(recipe);

    // Create result cell
    const resultCell = runtime.getCell(
      space,
      "no-handler-start-test-result",
      undefined,
      tx,
    );

    // Create process cell
    const processCell = runtime.getCell(
      space,
      "no-handler-start-test-process",
      undefined,
      tx,
    );

    // Set up result cell - events points to internal/events in process cell
    resultCell.set({
      doubled: {
        $alias: { path: ["internal", "doubled"], cell: processCell.entityId },
      },
      events: {
        $alias: { path: ["internal", "events"], cell: processCell.entityId },
      },
    });
    resultCell.setSourceCell(processCell);

    // Set up process cell - internal.events must be set to $stream: true
    // (both in recipe.initial and directly on the cell)
    processCell.set({
      [TYPE]: recipeId,
      argument: { value: 5 },
      resultRef: resultCell.getAsLink({ base: processCell }),
      internal: {
        events: { $stream: true },
      },
    });

    await tx.commit();
    tx = runtime.edit();

    // Verify piece is not running yet
    expect(liftRunCount).toBe(0);

    // Send an event to the result cell's events path
    // ensurePieceRunning will:
    // 1. Get cell at resultCell (with path removed)
    // 2. Follow getSourceCell() to find processCell
    // 3. Find TYPE and resultRef in processCell
    // 4. Start the piece
    const eventsLink = resultCell.key("events").getAsNormalizedFullLink();
    runtime.scheduler.queueEvent(eventsLink, { type: "click" });

    // Wait for processing
    await resultCell.pull();

    // The piece should have been started (lift ran)
    expect(liftRunCount).toBe(1);

    // The result should show the lift's output
    expect(resultCell.getAsQueryResult()).toMatchObject({ doubled: 10 });

    // Send another event - ensurePieceRunning may be called again but
    // runSynced is idempotent so the piece won't restart
    runtime.scheduler.queueEvent(eventsLink, { type: "click" });

    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.idle();

    // Lift should still only have run once because runSynced is idempotent
    expect(liftRunCount).toBe(1);
  });

  it("should start piece and process event when handler is defined", async () => {
    // Create a recipe with a handler that reads from the stream
    let liftRunCount = 0;
    let handlerRunCount = 0;
    const receivedEvents: any[] = [];

    const recipe: Recipe = {
      argumentSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      },
      resultSchema: {
        type: "object",
        properties: {
          doubled: { type: "number" },
          events: { type: "object" },
          eventCount: { type: "number" },
        },
      },
      initial: {
        internal: {
          events: { $stream: true },
          eventCount: 0,
        },
      },
      result: {
        doubled: { $alias: { path: ["internal", "doubled"] } },
        events: { $alias: { path: ["internal", "events"] } },
        eventCount: { $alias: { path: ["internal", "eventCount"] } },
      },
      nodes: [
        {
          // This lift will run when the piece starts
          module: {
            type: "javascript",
            implementation: (value: number) => {
              liftRunCount++;
              return value * 2;
            },
          },
          inputs: { $alias: { path: ["argument", "value"] } },
          outputs: { $alias: { path: ["internal", "doubled"] } },
        },
        {
          // Handler that reads from the stream
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: any, ctx: { eventCount: number }) => {
              handlerRunCount++;
              receivedEvents.push(event);
              ctx.eventCount = (ctx.eventCount || 0) + 1;
            },
          },
          inputs: {
            $event: { $alias: { path: ["internal", "events"] } },
            $ctx: {
              eventCount: { $alias: { path: ["internal", "eventCount"] } },
            },
          },
          outputs: {
            eventCount: { $alias: { path: ["internal", "eventCount"] } },
          },
        },
      ],
    };

    const recipeId = runtime.recipeManager.registerRecipe(recipe);

    // Create result cell
    const resultCell = runtime.getCell(
      space,
      "with-handler-start-test-result",
      undefined,
      tx,
    );

    // Create process cell
    const processCell = runtime.getCell(
      space,
      "with-handler-start-test-process",
      undefined,
      tx,
    );

    // Set up result cell
    resultCell.set({
      doubled: {
        $alias: { path: ["internal", "doubled"], cell: processCell.entityId },
      },
      events: {
        $alias: { path: ["internal", "events"], cell: processCell.entityId },
      },
      eventCount: {
        $alias: {
          path: ["internal", "eventCount"],
          cell: processCell.entityId,
        },
      },
    });
    resultCell.setSourceCell(processCell);

    // Set up process cell - internal.events must be set to $stream: true
    // (both in recipe.initial and directly on the cell)
    processCell.set({
      [TYPE]: recipeId,
      argument: { value: 5 },
      resultRef: resultCell.getAsLink({ base: processCell }),
      internal: {
        events: { $stream: true },
        eventCount: 0,
      },
    });

    await tx.commit();
    tx = runtime.edit();

    // Verify piece is not running yet
    expect(liftRunCount).toBe(0);
    expect(handlerRunCount).toBe(0);

    // Send an event - should start piece and process the event
    // The handler is registered for the internal/events path on process cell
    const eventsLink = processCell.key("internal").key("events")
      .getAsNormalizedFullLink();
    runtime.scheduler.queueEvent(eventsLink, { type: "click", x: 10 });

    // Wait for processing
    await resultCell.pull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.idle();

    // The piece should have been started
    expect(liftRunCount).toBe(1);

    // The handler should have been called
    expect(handlerRunCount).toBe(1);
    expect(receivedEvents).toEqual([{ type: "click", x: 10 }]);

    // Send another event - handler should be called again
    runtime.scheduler.queueEvent(eventsLink, { type: "click", x: 20 });

    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.idle();

    // Handler should have run twice now
    expect(handlerRunCount).toBe(2);
    expect(receivedEvents).toEqual([
      { type: "click", x: 10 },
      { type: "click", x: 20 },
    ]);

    // Lift should still only have run once (piece only started once)
    expect(liftRunCount).toBe(1);
  });
});
