// Tests that don't fit other categories. If a theme emerges, factor out
// a new file.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { isCell } from "../src/cell.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Miscellaneous", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({
      lift,
      pattern,
      handler,
      byRef,
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should support referenced modules", async () => {
    runtime.moduleRegistry.addModuleByRef(
      "double",
      lift((x: number) => x * 2),
    );

    const double = byRef("double");

    const simplePattern = pattern<{ value: number }>(
      ({ value }) => {
        const doubled = double(value);
        return { result: doubled };
      },
    );

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should support referenced modules",
      undefined,
      tx,
    );
    const result = runtime.run(tx, simplePattern, {
      value: 5,
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect(value).toMatchObject({ result: 10 });
  });

  it("should handle pushing objects that reference their containing array", async () => {
    const addItemHandler = handler(
      // Event schema
      {
        type: "object",
        properties: {
          detail: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
        required: ["detail"],
      },
      // State schema with self-referential items via $defs
      {
        $defs: {
          Items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                items: { $ref: "#/$defs/Items" },
              },
              required: ["title", "items"],
            },
            default: [],
          },
        },
        type: "object",
        properties: {
          items: { $ref: "#/$defs/Items", asCell: true },
        },
        required: ["items"],
      },
      (event, { items }) => {
        const title = event.detail?.message?.trim();
        if (title) {
          items.push({ title, items });
        }
      },
    );

    const itemsPattern = pattern<
      { items: Array<{ title: string; items: any[] }> }
    >(
      ({ items }) => {
        return { items, stream: addItemHandler({ items }) };
      },
    );

    const resultCell = runtime.getCell<{ items: any[]; stream: any }>(
      space,
      "should handle pushing objects that reference their containing array",
      undefined,
      tx,
    );
    const result = runtime.run(tx, itemsPattern, { items: [] }, resultCell);
    tx.commit();

    await result.pull();

    // Add first item
    result.key("stream").send({ detail: { message: "First Item" } });
    let value = await result.pull();

    expect(value.items).toHaveLength(1);
    expect(value.items[0].title).toBe("First Item");

    // Test reuse of proxy for array items
    expect(value.items[0].items).toBe(value.items);

    // Add second item
    result.key("stream").send({ detail: { message: "Second Item" } });
    value = await result.pull();
    expect(value.items).toHaveLength(2);
    expect(value.items[1].title).toBe("Second Item");

    // All three should point to the same array
    expect(value.items[0].items).toBe(value.items);
    expect(value.items[1].items).toBe(value.items);

    // And triple check that it actually refers to the same underlying array
    expect(value.items[0].items[1].title).toBe("Second Item");

    const recurse = ({ items }: { items: { items: any[] }[] }): any =>
      items.map((item) => recurse(item));

    // Now test that we catch infinite recursion
    expect(() => recurse(value as any)).toThrow();
  });

  it("should allow sending cells to an event handler", async () => {
    const addToList = handler(
      // == { piece: Cell<any> }
      {
        type: "object",
        properties: { piece: { type: "object", asCell: true } },
        required: ["piece"],
      },
      // == { list: Cell<any>[] }
      {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: { type: "object", asCell: true },
            asCell: true,
          },
        },
        required: ["list"],
      },
      ({ piece }, { list }) => {
        list.push(piece);
      },
    );

    const listPattern = pattern<{ list: any[] }>(
      ({ list }) => {
        return { list, stream: addToList({ list }) };
      },
    );

    const testCell = runtime.getCell<{ value: number }>(
      space,
      "should allow sending cells to an event handler",
      undefined,
      tx,
    );

    const pieceCell = runtime.getCell(
      space,
      "should allow sending cells to an event handler",
      listPattern.resultSchema,
      tx,
    );

    const piece = runtime.run(tx, listPattern, { list: [] }, pieceCell);
    tx.commit();

    await piece.pull();

    piece.key("stream").send({ piece: testCell });
    await piece.pull();

    // Add schema so we get the entry as a cell and can compare the two
    const listCell = piece.key("list").asSchema({
      type: "array",
      items: { type: "object", asCell: true },
    });
    expect(isCell(listCell.get()[0])).toBe(true);
    expect(listCell.get()[0].equals(testCell.get())).toBe(true);
  });

  it("should wait for lift before handler that reads lift output from event", async () => {
    // This test verifies that when handler A creates a lift and sends its output
    // as an event to handler B, the scheduler waits for the lift to complete
    // before running handler B.
    //
    // Flow:
    // 1. Send { value: 5 } to streamA
    // 2. Handler A creates a lift (double(value)) and sends its output to streamB
    // 3. Handler B receives the lift output cell, reads its value, and logs it
    // 4. The lift must run before handler B can read the correct value (10)
    //
    // This test should FAIL if populateDependencies doesn't receive the event,
    // because then the scheduler won't know handler B depends on the lift output.

    const log: number[] = [];

    // Lift that doubles a number
    const double = lift((x: number) => x * 2);

    // Handler B receives an event (a cell reference) and logs its value
    const handlerB = handler(
      // Event: a cell reference (link to the doubled output)
      { type: "number", asCell: true },
      // No state needed
      {},
      (eventCell, _state) => {
        // Read the cell value and log it
        const value = eventCell.get();
        log.push(value);
      },
    );

    // Handler A receives a value, creates a lift, and sends its output to streamB
    const handlerA = handler(
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      {
        type: "object",
        properties: {
          streamB: { asStream: true },
        },
        required: ["streamB"],
      },
      ({ value }, { streamB }) => {
        // Create the lift dynamically and send its output to streamB
        const doubled = double(value);
        streamB.send(doubled);
        return doubled;
      },
    );

    const testPattern = pattern(
      () => {
        // Create handler B's stream (receives cell references, logs values)
        const streamB = handlerB({});

        // Create handler A's stream (creates lift and dispatches to streamB)
        const streamA = handlerA({ streamB });

        return { streamA };
      },
    );

    const resultCell = runtime.getCell<{ streamA: any }>(
      space,
      "should wait for lift before handler that reads lift output from event",
      undefined,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    // Verify initial state
    expect(log).toEqual([]);

    // Send an event to handler A with value 5
    result.key("streamA").send({ value: 5 });
    await result.pull();

    // Handler B should have logged 10 (5 * 2) - the lift must have run first
    // If the lift didn't run before handler B, we'd get undefined or wrong value
    expect(log).toEqual([10]);

    // Send another event to verify consistent behavior
    result.key("streamA").send({ value: 7 });
    await result.pull();

    // Handler B should have logged 14 (7 * 2)
    expect(log).toEqual([10, 14]);
  });
});
