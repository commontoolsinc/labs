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
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let cell: ReturnType<typeof createBuilder>["commontools"]["cell"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];
  let conflictErrors: Error[];

  beforeEach(() => {
    conflictErrors = [];
    storageManager = StorageManager.emulate({ as: signer });

    // Subscribe to storage notifications to capture conflicts
    storageManager.subscribe({
      next: (notification: StorageNotification) => {
        if (
          notification.type === "revert" &&
          notification.reason.name === "ConflictError"
        ) {
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

    const { commontools } = createBuilder();
    ({ lift, pattern, cell, handler } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should NOT have conflicts with lift (fixed)", async () => {
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
        sequence: { asCell: true },
      },
      required: ["items", "sequence"],
    }, (_event, context) => {
      // Minimal repro: Removing either of these removes the conflict
      context.items.set([]);
      context.sequence.set(context.sequence.get() + 1);
    });

    const conflictRepro = pattern<{ items: Item[] }>(
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
          sequence,
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
    await tx.commit();

    await runtime.idle();

    // Verify initial state
    expect(result.get().sequence).toBe(0);

    // Trigger the handler
    result.key("action").send({});
    await runtime.idle();

    // After handler: sequence should be incremented to 1
    expect(result.get().sequence).toBe(1);

    // Give time for async conflict notifications to be processed
    // The conflict happens during the optimistic transaction retry,
    // which completes asynchronously after runtime.idle()
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that conflicts were NOT captured
    expect(conflictErrors.length).toBe(0);
  });

  it("should NOT have conflicts without lift", async () => {
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
        sequence: { asCell: true },
      },
      required: ["items", "sequence"],
    }, (_event, context) => {
      // Same handler logic
      context.items.set([]);
      context.sequence.set(context.sequence.get() + 1);
    });

    const conflictReproNoLift = pattern<{ items: Item[] }>(
      "Conflict Repro No Lift",
      ({ items }) => {
        const sequence = cell(0);

        // NO lift - this should eliminate conflicts

        return {
          action: action({
            items,
            sequence,
          }),
          sequence,
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
    await tx.commit();

    await runtime.idle();

    // Verify initial state
    expect(result.get().sequence).toBe(0);

    // Trigger the handler
    result.key("action").send({});
    await runtime.idle();

    // After handler: sequence should be incremented to 1
    expect(result.get().sequence).toBe(1);

    // Give time for async conflict notifications
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that NO conflicts were captured
    expect(conflictErrors.length).toBe(0);
  });
});
