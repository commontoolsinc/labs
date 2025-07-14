import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Cell, isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { ID, type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Nested Cell Array", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should show the difference between array with and without asCell on items", () => {
    // Schema WITHOUT asCell on items
    const normalArraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "number" },
        },
        required: ["name", "value"],
        // Note: NO asCell: true here
      },
      default: [],
    } as const satisfies JSONSchema;

    // Schema WITH asCell on items
    const cellArraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "number" },
        },
        required: ["name", "value"],
        asCell: true, // This wraps each item in a Cell
      },
      default: [],
    } as const satisfies JSONSchema;

    // Create cells with each schema
    const normalArray = runtime.getCell(
      space,
      "normal-array",
      normalArraySchema,
    );
    const cellArray = runtime.getCell(space, "cell-array", cellArraySchema);

    // Add the same data to both
    const testData = { name: "test", value: 42 };
    normalArray.push(testData);
    cellArray.push(testData as any);

    // Compare behavior
    const normalItems = normalArray.get();
    const cellItems = cellArray.get();

    // Both are arrays
    expect(Array.isArray(normalItems)).toBe(true);
    expect(Array.isArray(cellItems)).toBe(true);

    // Normal array: items are plain objects
    expect(isCell(normalItems[0])).toBe(false);
    expect(normalItems[0]).toEqual(testData);

    // Cell array: items are cells containing objects
    expect(isCell(cellItems[0])).toBe(true);
    expect(cellItems[0].get()).toEqual(testData);

    // cellItems[0].get() should NOT be a cell
    expect(isCell(cellItems[0].get())).toBe(false);
  });

  it("[ID] property converts to entity in diffAndUpdate - test this works", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "number" },
        },
        required: ["name", "value"],
        asCell: true,
      },
      default: [],
    } as const satisfies JSONSchema;
    const arrayCell = runtime.getCell(space, "test-array-with-id", schema);

    // Push an object WITHOUT [ID]
    arrayCell.push({
      name: "without-id",
      value: 1,
    });

    // Push an object WITH [ID]
    arrayCell.push({
      [ID]: "test/id",
      name: "with-id",
      value: 2,
    } as any);

    const items = arrayCell.get();
    expect(isCell(items[0])).toBe(true);
    expect(isCell(items[0].get())).toBe(false);

    expect(isCell(items[1])).toBe(true);
    expect(isCell(items[1].get())).toBe(false);
  });
});
