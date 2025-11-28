import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("mapByKey builtin", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let mapByKey: ReturnType<typeof createBuilder>["commontools"]["mapByKey"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ lift, recipe, mapByKey } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should map items with identity key (no keyPath)", async () => {
    const getName = lift<{ element: { id: number; name: string } }>(
      ({ element }) => ({ n: element.name }),
    );

    const mapRecipe = recipe<{ items: { id: number; name: string }[] }>(
      "Identity Key Map",
      ({ items }) => {
        const result = mapByKey(items, (item) => getName({ element: item }));
        return { result };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should map items with identity key",
      {
        type: "object",
        properties: {
          result: {
            type: "array",
            items: {
              type: "object",
              properties: { n: { type: "string" } },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, mapRecipe, {
      items: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
      result: [{ n: "Alice" }, { n: "Bob" }, { n: "Charlie" }],
    });
  });

  it("should map items with keyPath", async () => {
    const getName = lift<{ element: { id: number; name: string } }>(
      ({ element }) => ({ n: element.name }),
    );

    const mapRecipe = recipe<{ items: { id: number; name: string }[] }>(
      "KeyPath Map",
      ({ items }) => {
        const result = mapByKey(items, "id", (item) =>
          getName({ element: item }));
        return { result };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should map items with keyPath",
      {
        type: "object",
        properties: {
          result: {
            type: "array",
            items: {
              type: "object",
              properties: { n: { type: "string" } },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, mapRecipe, {
      items: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
      result: [{ n: "Alice" }, { n: "Bob" }, { n: "Charlie" }],
    });
  });

  it("should handle empty arrays", async () => {
    const getName = lift<{ element: { id: number; name: string } }>(
      ({ element }) => ({ n: element.name }),
    );

    const mapRecipe = recipe<{ items: { id: number; name: string }[] }>(
      "Empty Array Map",
      ({ items }) => {
        const result = mapByKey(items, "id", (item) =>
          getName({ element: item }));
        return { result };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle empty arrays",
      {
        type: "object",
        properties: {
          result: { type: "array", items: { type: "object" } },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, mapRecipe, { items: [] }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ result: [] });
  });

  it("should handle undefined input", async () => {
    const getName = lift<{ element: { id: number; name: string } }>(
      ({ element }) => ({ n: element.name }),
    );

    const mapRecipe = recipe<{ items?: { id: number; name: string }[] }>(
      "Undefined Array Map",
      ({ items }) => {
        const result = mapByKey(items, "id", (item) =>
          getName({ element: item }));
        return { result };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle undefined input",
      {
        type: "object",
        properties: {
          result: { type: "array", items: { type: "object" } },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, mapRecipe, { items: undefined }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ result: [] });
  });

  it("should deduplicate items with same key (first wins)", async () => {
    const getValue = lift<{ element: { id: number; value: string } }>(
      ({ element }) => ({ v: element.value }),
    );

    const mapRecipe = recipe<{ items: { id: number; value: string }[] }>(
      "Dedup Map",
      ({ items }) => {
        const result = mapByKey(items, "id", (item) =>
          getValue({ element: item }));
        return { result };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should deduplicate items with same key",
      {
        type: "object",
        properties: {
          result: {
            type: "array",
            items: {
              type: "object",
              properties: { v: { type: "string" } },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, mapRecipe, {
      items: [
        { id: 1, value: "first-1" },
        { id: 2, value: "first-2" },
        { id: 1, value: "duplicate-1" }, // Duplicate key - should be ignored
        { id: 3, value: "first-3" },
      ],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    // Should only have 3 items, with the first occurrence of id=1
    expect(result.get()).toMatchObjectIgnoringSymbols({
      result: [{ v: "first-1" }, { v: "first-2" }, { v: "first-3" }],
    });
  });

  it("should handle nested keyPath", async () => {
    const getValue = lift<
      { element: { nested: { id: number }; value: string } }
    >(
      ({ element }) => ({ v: element.value }),
    );

    const mapRecipe = recipe<
      { items: { nested: { id: number }; value: string }[] }
    >(
      "Nested KeyPath Map",
      ({ items }) => {
        // Use array keyPath for nested access
        const result = mapByKey(items, ["nested", "id"], (item) =>
          getValue({ element: item }));
        return { result };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle nested keyPath",
      {
        type: "object",
        properties: {
          result: {
            type: "array",
            items: {
              type: "object",
              properties: { v: { type: "string" } },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, mapRecipe, {
      items: [
        { nested: { id: 1 }, value: "a" },
        { nested: { id: 2 }, value: "b" },
        { nested: { id: 3 }, value: "c" },
      ],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
      result: [{ v: "a" }, { v: "b" }, { v: "c" }],
    });
  });

  it("should handle simple number array with identity key", async () => {
    const double = lift<{ element: number }>(({ element }) => element * 2);

    const mapRecipe = recipe<{ items: number[] }>(
      "Number Array Map",
      ({ items }) => {
        const result = mapByKey(items, (item) => double({ element: item }));
        return { result };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle simple number array with identity key",
      {
        type: "object",
        properties: {
          result: { type: "array", items: { type: "number" } },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, mapRecipe, {
      items: [1, 2, 3],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
      result: [2, 4, 6],
    });
  });

  it("should handle reactivity when input changes", async () => {
    const getValue = lift<{ element: { id: number; value: string } }>(
      ({ element }) => ({ v: element.value }),
    );

    const mapRecipe = recipe<{ items: { id: number; value: string }[] }>(
      "Reactive Map",
      ({ items }) => {
        const result = mapByKey(items, "id", (item) =>
          getValue({ element: item }));
        return { result };
      },
    );

    const inputCell = runtime.getCell<{ id: number; value: string }[]>(
      space,
      "reactive input",
      undefined,
      tx,
    );
    inputCell.withTx(tx).set([
      { id: 1, value: "a" },
      { id: 2, value: "b" },
    ]);
    tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell(
      space,
      "should handle reactivity when input changes",
      {
        type: "object",
        properties: {
          result: {
            type: "array",
            items: {
              type: "object",
              properties: { v: { type: "string" } },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, mapRecipe, { items: inputCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
      result: [{ v: "a" }, { v: "b" }],
    });

    // Add a new item
    inputCell.withTx(tx).send([
      { id: 1, value: "a" },
      { id: 2, value: "b" },
      { id: 3, value: "c" },
    ]);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
      result: [{ v: "a" }, { v: "b" }, { v: "c" }],
    });
  });
});
