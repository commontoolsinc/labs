import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type Cell } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type IExtendedStorageTransaction,
  type StorageNotification,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test conflict");
const space = signer.did();

interface Item {
  id?: string;
}

describe("Conflict Reproduction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let cell: ReturnType<typeof createBuilder>["commontools"]["cell"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];
  let conflictErrors: Error[];

  beforeEach(() => {
    conflictErrors = [];
    storageManager = StorageManager.emulate({ as: signer });

    // Subscribe to storage notifications to capture conflicts
    let txCounter = 0;
    storageManager.subscribe({
      next: (notification: StorageNotification) => {
        // Log all commit and revert events to understand the sequence
        if (notification.type === "commit") {
          txCounter++;
          const changes = Array.from(notification.changes);
          console.log(`[TX-${txCounter}] COMMIT - ${changes.length} changes`);
        }

        if (notification.type === "revert") {
          console.log(`[REVERT] Reason: ${notification.reason.name}`);
        }

        if (
          notification.type === "revert" &&
          notification.reason.name === "ConflictError"
        ) {
          const error = notification.reason as any;
          console.log("\n=== ConflictError Details ===");
          console.log("Conflicting fact:", error.conflict.of);
          console.log("Expected version:", error.conflict.expected?.toString());
          console.log(
            "Actual version:",
            error.conflict.actual?.cause?.toString(),
          );
          console.log(
            "Transaction was trying to update:",
            Object.keys(error.transaction.args.changes)[0],
          );
          console.log(
            "Same fact?",
            Object.keys(error.transaction.args.changes)[0] ===
              error.conflict.of,
          );
          console.log("============================\n");
          conflictErrors.push(notification.reason);
        }
        return undefined;
      },
    });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder(runtime);
    ({ lift, recipe, cell, handler } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should reproduce conflict with minimal handler", async () => {
    console.log(
      "\n========== TEST: With lift (should have conflicts) ==========\n",
    );
    const action = handler<
      undefined,
      { items: Cell<Item[]>; sequence: Cell<number> }
    >({}, {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } } },
          asCell: true,
        },
        sequence: { type: "number", asCell: true },
      },
      required: ["items", "sequence"],
    }, (_event, context) => {
      // Minimal repro: Removing either of these removes the conflict
      context.items.set([]);
      context.sequence.set(context.sequence.get() + 1);
    });

    const conflictRepro = recipe<{ items: Item[] }>(
      "Conflict Repro",
      ({ items }) => {
        const sequence = cell(0);

        // Minimal repro: Removing the lift and the map removes the conflict
        lift((item: Item[]) => item.map((_) => ({})))(items);

        return {
          action: action({
            items,
            sequence,
          }),
        };
      },
    );

    const resultCell = runtime.getCell<{ action: any }>(
      space,
      "should reproduce conflict with minimal handler",
      undefined,
      tx,
    );
    const result = runtime.run(tx, conflictRepro, {
      items: [{ id: "test" }],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    console.log("\n--- Before handler invocation ---");
    console.log("Result value:", JSON.stringify(result.get(), null, 2));

    // Trigger the handler
    console.log("\n--- Invoking handler ---");
    result.key("action").send({});
    await runtime.idle();

    console.log("\n--- After handler invocation ---");
    console.log("Result value:", JSON.stringify(result.get(), null, 2));

    expect(result.get()).toMatchObject({ action: expect.anything() });

    // Give time for async conflict notifications to be processed
    // The conflict happens during the optimistic transaction retry,
    // which completes asynchronously after runtime.idle()
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that conflicts were captured
    console.log(`\n✓ Conflicts captured: ${conflictErrors.length}\n`);
    expect(conflictErrors.length).toBeGreaterThan(0);
  });

  it("should NOT have conflicts without lift", async () => {
    console.log(
      "\n========== TEST: Without lift (should have NO conflicts) ==========\n",
    );
    conflictErrors = []; // Reset

    const action = handler<
      undefined,
      { items: Cell<Item[]>; sequence: Cell<number> }
    >({}, {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } } },
          asCell: true,
        },
        sequence: { type: "number", asCell: true },
      },
      required: ["items", "sequence"],
    }, (_event, context) => {
      // Same handler logic
      context.items.set([]);
      context.sequence.set(context.sequence.get() + 1);
    });

    const conflictReproNoLift = recipe<{ items: Item[] }>(
      "Conflict Repro No Lift",
      ({ items }) => {
        const sequence = cell(0);

        // NO lift - this should eliminate conflicts

        return {
          action: action({
            items,
            sequence,
          }),
        };
      },
    );

    const resultCell = runtime.getCell<{ action: any }>(
      space,
      "should NOT have conflicts without lift",
      undefined,
      tx,
    );
    const result = runtime.run(tx, conflictReproNoLift, {
      items: [{ id: "test" }],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    // Trigger the handler
    result.key("action").send({});
    await runtime.idle();

    // Give time for async conflict notifications
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that NO conflicts were captured
    console.log(
      `\n✓ Conflicts captured: ${conflictErrors.length} (expected 0)\n`,
    );
    expect(conflictErrors.length).toBe(0);
  });
});
