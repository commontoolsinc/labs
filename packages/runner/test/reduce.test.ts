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

describe("reduce builtin", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  // Using 'any' for reduce since the generic types are complex with Opaque wrappers
  // but runtime behavior is correct (reducer receives unwrapped values)
  let reduce: any;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ recipe, reduce } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should sum numbers", async () => {
    const sumRecipe = recipe<{ numbers: number[] }>(
      "Sum Recipe",
      ({ numbers }) => {
        const sum = reduce(numbers, 0, (acc: number, n: number) => acc + n);
        return { sum };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should sum numbers",
      {
        type: "object",
        properties: { sum: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sumRecipe, {
      numbers: [1, 2, 3, 4, 5],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ sum: 15 });
  });

  it("should handle empty arrays with initial value", async () => {
    const sumRecipe = recipe<{ numbers: number[] }>(
      "Empty Sum Recipe",
      ({ numbers }) => {
        const sum = reduce(numbers, 100, (acc: number, n: number) => acc + n);
        return { sum };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle empty arrays with initial value",
      {
        type: "object",
        properties: { sum: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sumRecipe, { numbers: [] }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ sum: 100 });
  });

  it("should handle undefined input", async () => {
    const sumRecipe = recipe<{ numbers?: number[] }>(
      "Undefined Sum Recipe",
      ({ numbers }) => {
        const sum = reduce(numbers, 0, (acc: number, n: number) => acc + n);
        return { sum };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle undefined input",
      {
        type: "object",
        properties: { sum: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sumRecipe, { numbers: undefined }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ sum: 0 });
  });

  it("should concatenate strings", async () => {
    const concatRecipe = recipe<{ words: string[] }>(
      "Concat Recipe",
      ({ words }) => {
        const result = reduce(words, "", (acc: string, word: string) =>
          acc ? `${acc} ${word}` : word
        );
        return { result };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should concatenate strings",
      {
        type: "object",
        properties: { result: { type: "string" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, concatRecipe, {
      words: ["hello", "world", "test"],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ result: "hello world test" });
  });

  it("should build object from array", async () => {
    const buildRecipe = recipe<{ items: { key: string; value: number }[] }>(
      "Build Object Recipe",
      ({ items }) => {
        const obj = reduce(
          items,
          {} as Record<string, number>,
          (acc: Record<string, number>, item: { key: string; value: number }) => ({ ...acc, [item.key]: item.value }),
        );
        return { obj };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should build object from array",
      {
        type: "object",
        properties: {
          obj: { type: "object", additionalProperties: { type: "number" } },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, buildRecipe, {
      items: [
        { key: "a", value: 1 },
        { key: "b", value: 2 },
        { key: "c", value: 3 },
      ],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
      obj: { a: 1, b: 2, c: 3 },
    });
  });

  it("should provide index to reducer", async () => {
    const indexRecipe = recipe<{ items: string[] }>(
      "Index Recipe",
      ({ items }) => {
        const result = reduce(items, [] as string[], (acc: string[], item: string, index: number) => [
          ...acc,
          `${index}:${item}`,
        ]);
        return { result };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should provide index to reducer",
      {
        type: "object",
        properties: {
          result: { type: "array", items: { type: "string" } },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, indexRecipe, {
      items: ["a", "b", "c"],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
      result: ["0:a", "1:b", "2:c"],
    });
  });

  it("should find max value", async () => {
    const maxRecipe = recipe<{ numbers: number[] }>(
      "Max Recipe",
      ({ numbers }) => {
        const max = reduce(numbers, -Infinity, (acc: number, n: number) => Math.max(acc, n));
        return { max };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should find max value",
      {
        type: "object",
        properties: { max: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, maxRecipe, {
      numbers: [3, 1, 4, 1, 5, 9, 2, 6],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ max: 9 });
  });

  it("should count items matching condition", async () => {
    const countRecipe = recipe<{ numbers: number[] }>(
      "Count Recipe",
      ({ numbers }) => {
        const count = reduce(numbers, 0, (acc: number, n: number) => acc + (n > 3 ? 1 : 0));
        return { count };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should count items matching condition",
      {
        type: "object",
        properties: { count: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, countRecipe, {
      numbers: [1, 2, 3, 4, 5, 6],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ count: 3 });
  });

  it("should handle reactivity when input changes", async () => {
    const sumRecipe = recipe<{ numbers: number[] }>(
      "Reactive Sum Recipe",
      ({ numbers }) => {
        const sum = reduce(numbers, 0, (acc: number, n: number) => acc + n);
        return { sum };
      },
    );

    const inputCell = runtime.getCell<number[]>(
      space,
      "reactive sum input",
      undefined,
      tx,
    );
    inputCell.withTx(tx).set([1, 2, 3]);
    tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell(
      space,
      "should handle reactivity when input changes",
      {
        type: "object",
        properties: { sum: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sumRecipe, { numbers: inputCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ sum: 6 });

    // Update the input
    inputCell.withTx(tx).send([1, 2, 3, 4, 5]);
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({ sum: 15 });
  });

  it("should flatten nested arrays", async () => {
    const flattenRecipe = recipe<{ nested: number[][] }>(
      "Flatten Recipe",
      ({ nested }) => {
        const flat = reduce(nested, [] as number[], (acc: number[], arr: number[]) => [...acc, ...arr]);
        return { flat };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should flatten nested arrays",
      {
        type: "object",
        properties: {
          flat: { type: "array", items: { type: "number" } },
        },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, flattenRecipe, {
      nested: [[1, 2], [3, 4], [5]],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    expect(result.get()).toMatchObjectIgnoringSymbols({
      flat: [1, 2, 3, 4, 5],
    });
  });
});
