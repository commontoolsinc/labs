import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Pattern } from "../src/builder/types.ts";
import { getSigilLink } from "../src/runner-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { ensurePieceRunning } from "../src/ensure-piece-running.ts";
import { trustPattern } from "./support/trusted-builder.ts";
import { getMetaCell } from "../src/link-utils.ts";
import { setResultCell } from "../src/result-utils.ts";

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
    // Create a cell that has no piece structure (no process cell, no pattern)
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

  it("should return false for cells without pattern metadata", async () => {
    // Create a result cell with no pattern metadata.
    const resultCell = runtime.getCell(
      space,
      "no-pattern-test-result",
      undefined,
      tx,
    );

    resultCell.set({ value: 1 });
    resultCell.setMetaRaw("argument", { value: 1 });

    await tx.commit();
    tx = runtime.edit();

    // ensurePieceRunning should return false - no pattern in result metadata
    const result = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(false);
  });

  it("should return false when result cell pattern cannot be loaded", async () => {
    // Create a result cell whose pattern metadata points at a missing pattern.
    const resultCell = runtime.getCell(
      space,
      "no-resultref-test-result",
      undefined,
      tx,
    );

    resultCell.set({ value: 1 });
    resultCell.setMetaRaw("pattern", getSigilLink("of:missing-pattern-test"));
    resultCell.setMetaRaw("argument", { value: 1 });

    await tx.commit();
    tx = runtime.edit();

    // ensurePieceRunning should return false - pattern cannot be loaded
    const result = await ensurePieceRunning(
      runtime,
      resultCell.getAsNormalizedFullLink(),
    );

    expect(result).toBe(false);
  });

  it("should start a piece with valid process cell structure", async () => {
    // Create a simple pattern
    let patternRan = false;
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { value: { type: "number" } },
      },
      resultSchema: {
        type: "object",
        properties: { doubled: { type: "number" } },
      },
      result: {
        doubled: { $alias: { cell: "internal", path: ["doubled"] } }, // bound to resultCell.internal.doubled
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => {
              patternRan = true;
              return value * 2;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } }, // bound to resultCell.argument.value
          outputs: { $alias: { cell: "internal", path: ["doubled"] } }, // bound to resultCell.internal.doubled
        },
      ],
    };

    const patternId = runtime.patternManager.registerPattern(
      trustPattern(runtime, pattern),
    );

    // Create result cell
    const resultCell = runtime.getCell(
      space,
      "valid-piece-test-result",
      pattern.resultSchema,
      tx,
    );

    // Set up the structure
    // FIXME: Because this is a regular link, we aren't doing that special alias parsing we do for bindings,
    // so I don't really expect this to work.
    resultCell.set({
      doubled: {
        $alias: { path: ["internal", "doubled"] },
      },
    });
    const argumentCell = getMetaCell(
      resultCell,
      "argument",
      tx,
      pattern.argumentSchema,
    );
    const internalCell = getMetaCell(resultCell, "internal", tx);

    resultCell.setMetaRaw("pattern", getSigilLink(patternId));
    resultCell.setMetaRaw("argument", argumentCell.getAsWriteRedirectLink());
    resultCell.setMetaRaw("internal", internalCell.getAsWriteRedirectLink());
    argumentCell.set({ value: 5 });
    internalCell.set({});

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

    expect(patternRan).toBe(true);
  });

  it("should be idempotent - calling multiple times is safe", async () => {
    // Create a simple pattern
    let startCount = 0;
    const pattern: Pattern = {
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

    const patternId = runtime.patternManager.registerPattern(
      trustPattern(runtime, pattern),
    );

    const resultCell = runtime.getCell(
      space,
      "idempotent-start-test-result",
      undefined,
      tx,
    );

    const argumentCell = getMetaCell(
      resultCell,
      "argument",
      tx,
      pattern.argumentSchema,
    );
    const internalCell = getMetaCell(resultCell, "internal", tx);

    resultCell.set({});
    resultCell.setMetaRaw("pattern", getSigilLink(patternId));
    resultCell.setMetaRaw("argument", argumentCell.getAsWriteRedirectLink());
    resultCell.setMetaRaw("internal", internalCell.getAsWriteRedirectLink());
    argumentCell.set({});
    internalCell.set({});

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
    // Create a simple pattern that tracks how many times it starts
    let startCount = 0;
    const pattern: Pattern = {
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

    const patternId = runtime.patternManager.registerPattern(
      trustPattern(runtime, pattern),
    );

    const resultCell = runtime.getCell(
      space,
      "restart-after-stop-test-result",
      undefined,
      tx,
    );

    const argumentCell = getMetaCell(
      resultCell,
      "argument",
      tx,
      pattern.argumentSchema,
    );
    const internalCell = getMetaCell(resultCell, "internal", tx);

    resultCell.set({});
    resultCell.setMetaRaw("pattern", getSigilLink(patternId));
    resultCell.setMetaRaw("argument", argumentCell.getAsWriteRedirectLink());
    resultCell.setMetaRaw("internal", internalCell.getAsWriteRedirectLink());
    argumentCell.set({});
    internalCell.set({});

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
    // Create a pattern with a reactive lift (to prove it starts) but NO event handler
    let liftRunCount = 0;

    const pattern: Pattern = {
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
        doubled: { $alias: { cell: "internal", path: ["doubled"] } },
        events: { $alias: { cell: "internal", path: ["events"] } },
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
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: { $alias: { cell: "internal", path: ["doubled"] } },
        },
        // Note: NO handler node for events - this is intentional
      ],
    };

    const patternId = runtime.patternManager.registerPattern(
      trustPattern(runtime, pattern),
    );

    // Create result cell
    const resultCell = runtime.getCell(
      space,
      "no-handler-start-test-result",
      undefined,
      tx,
    );

    // Create a internal and argument cells, and attach them to resultCell.
    // This would be done inside setupInternal, but we want to proactively set up links
    // to that internal cell in our result cell.
    const internalCell = getMetaCell(resultCell, "internal", tx);
    const argumentCell = getMetaCell(resultCell, "argument", tx);

    // Set up result cell - events points to internal/events in process cell
    resultCell.setRaw({
      doubled: internalCell.key("doubled").getAsWriteRedirectLink(),
      events: internalCell.key("events").getAsWriteRedirectLink(),
    });
    resultCell.setMetaRaw("pattern", getSigilLink(patternId));
    resultCell.setMetaRaw("argument", argumentCell.getAsWriteRedirectLink());
    resultCell.setMetaRaw("internal", internalCell.getAsWriteRedirectLink());
    argumentCell.set({ value: 5 });
    internalCell.setRaw({ events: { $stream: true } });

    await tx.commit();
    tx = runtime.edit();

    // Verify piece is not running yet
    expect(liftRunCount).toBe(0);

    // Send an event to the result cell's events path
    // ensurePieceRunning will:
    // 1. Get cell at resultCell (with path removed)
    // 2. Find pattern metadata in resultCell
    // 3. Start the piece
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
    // Create a pattern with a handler that reads from the stream
    let liftRunCount = 0;
    let handlerRunCount = 0;
    const receivedEvents: any[] = [];

    const pattern: Pattern = {
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
        doubled: { $alias: { cell: "internal", path: ["doubled"] } },
        events: { $alias: { cell: "internal", path: ["events"] } },
        eventCount: { $alias: { cell: "internal", path: ["eventCount"] } },
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
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: { $alias: { cell: "internal", path: ["doubled"] } },
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
            $event: { $alias: { cell: "internal", path: ["events"] } },
            $ctx: {
              eventCount: {
                $alias: { cell: "internal", path: ["eventCount"] },
              },
            },
          },
          outputs: {
            eventCount: { $alias: { cell: "internal", path: ["eventCount"] } },
          },
        },
      ],
    };

    const patternId = runtime.patternManager.registerPattern(
      trustPattern(runtime, pattern),
    );

    // Create result cell
    const resultCell = runtime.getCell(
      space,
      "with-handler-start-test-result",
      undefined,
      tx,
    );

    // Create a internal and argument cells, and attach them to resultCell.
    // This would be done inside setupInternal, but we want to proactively set up links
    // to that internal cell in our result cell.
    const internalCell = getMetaCell(resultCell, "internal", tx);
    const argumentCell = getMetaCell(resultCell, "argument", tx);

    // Set up result cell - events points to events in internal cell
    resultCell.setRaw({
      doubled: internalCell.key("doubled").getAsWriteRedirectLink(),
      events: internalCell.key("events").getAsWriteRedirectLink(),
      eventCount: internalCell.key("eventCount").getAsWriteRedirectLink(),
    });
    resultCell.setMetaRaw("pattern", getSigilLink(patternId));
    resultCell.setMetaRaw("argument", argumentCell.getAsWriteRedirectLink());
    resultCell.setMetaRaw("internal", internalCell.getAsWriteRedirectLink());
    argumentCell.set({ value: 5 });
    // Set up internal cell - events must be set to $stream: true
    internalCell.setRaw({ events: { $stream: true }, eventCount: 0 });
    setResultCell(internalCell, resultCell);

    await tx.commit();
    tx = runtime.edit();

    // Verify piece is not running yet
    expect(liftRunCount).toBe(0);
    expect(handlerRunCount).toBe(0);

    // Send an event - should start piece and process the event
    // The handler is registered for the events path on internal cell
    const eventsLink = internalCell.key("events").getAsNormalizedFullLink();
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

  it("should follow chained result metadata before auto-starting for an event", async () => {
    let liftRunCount = 0;
    let handlerRunCount = 0;
    const receivedEvents: any[] = [];

    const pattern: Pattern = {
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
        doubled: { $alias: { cell: "internal", path: ["doubled"] } },
        events: { $alias: { cell: "internal", path: ["events"] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => {
              liftRunCount++;
              return value * 2;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: { $alias: { cell: "internal", path: ["doubled"] } },
        },
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: any) => {
              handlerRunCount++;
              receivedEvents.push(event);
            },
          },
          inputs: {
            $event: { $alias: { cell: "internal", path: ["events"] } },
          },
          outputs: {},
        },
      ],
    };

    const patternId = runtime.patternManager.registerPattern(
      trustPattern(runtime, pattern),
    );

    const resultCell = runtime.getCell(
      space,
      "with-handler-chained-result-test-result",
      undefined,
      tx,
    );
    const intermediateCell = runtime.getCell(
      space,
      "with-handler-chained-result-test-intermediate",
      undefined,
      tx,
    );

    const internalCell = getMetaCell(resultCell, "internal", tx);
    const argumentCell = getMetaCell(resultCell, "argument", tx);

    resultCell.setRaw({
      doubled: internalCell.key("doubled").getAsWriteRedirectLink(),
      events: internalCell.key("events").getAsWriteRedirectLink(),
    });
    resultCell.setMetaRaw("pattern", getSigilLink(patternId));
    resultCell.setMetaRaw("argument", argumentCell.getAsWriteRedirectLink());
    resultCell.setMetaRaw("internal", internalCell.getAsWriteRedirectLink());
    argumentCell.set({ value: 6 });
    internalCell.setRaw({ events: { $stream: true } });
    intermediateCell.setRaw({});

    setResultCell(internalCell, intermediateCell);
    setResultCell(intermediateCell, resultCell);

    await tx.commit();
    tx = runtime.edit();

    expect(liftRunCount).toBe(0);
    expect(handlerRunCount).toBe(0);

    const eventsLink = internalCell.key("events").getAsNormalizedFullLink();
    runtime.scheduler.queueEvent(eventsLink, { type: "click", x: 42 });

    await resultCell.pull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.idle();

    expect(liftRunCount).toBe(1);
    expect(handlerRunCount).toBe(1);
    expect(receivedEvents).toEqual([{ type: "click", x: 42 }]);
    expect(resultCell.getAsQueryResult()).toMatchObject({
      doubled: 12,
    });
  });
});
