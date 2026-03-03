// Basic pattern mechanics: defining patterns, passing inputs, returning outputs,
// nesting patterns, default values, and map/iteration over collections.

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

describe("Pattern Runner - Core", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];

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
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should run a simple pattern", async () => {
    const simplePattern = pattern<{ value: number }>(
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return { result: doubled };
      },
    );

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should run a simple pattern",
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

  it("should handle nested patterns", async () => {
    const innerPattern = pattern<{ x: number }>(({ x }) => {
      const squared = lift((n: number) => {
        return n * n;
      })(x);
      return { squared };
    });

    const outerPattern = pattern<{ value: number }>(
      ({ value }) => {
        const { squared } = innerPattern({ x: value });
        const result = lift((n: number) => {
          return n + 1;
        })(squared);
        return { result };
      },
    );

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should handle nested patterns",
      undefined,
      tx,
    );
    const result = runtime.run(tx, outerPattern, {
      value: 4,
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect(value).toEqual({ result: 17 });
  });

  it("should handle patterns with default values", async () => {
    const patternWithDefaults = pattern(
      ({ a, b }) => {
        const { sum } = lift(({ x, y }) => ({ sum: x + y }))({ x: a, y: b });
        return { sum };
      },
      {
        type: "object",
        properties: {
          a: { type: "number", default: 5 },
          b: { type: "number", default: 10 },
        },
      },
      { type: "object", properties: { sum: { type: "number" } } },
    );

    const resultCell1 = runtime.getCell<{ sum: number }>(
      space,
      "should handle patterns with defaults",
      undefined,
      tx,
    );
    const result1 = runtime.run(
      tx,
      patternWithDefaults,
      {},
      resultCell1,
    );
    tx.commit();
    tx = runtime.edit();

    const value1 = await result1.pull();
    expect(value1).toMatchObject({ sum: 15 });

    const resultCell2 = runtime.getCell<{ sum: number }>(
      space,
      "should handle patterns with defaults (2)",
      undefined,
      tx,
    );
    const result2 = runtime.run(tx, patternWithDefaults, {
      a: 20,
    }, resultCell2);
    tx.commit();

    const value2 = await result2.pull();
    expect(value2).toMatchObject({ sum: 30 });
  });

  it("should handle patterns with map nodes", async () => {
    const multiply = lift<{ x: number; index: number; array: { x: number }[] }>(
      ({ x, index, array }) => x * (index + 1) * array.length,
    );

    const multipliedArray = pattern<{ values: { x: number }[] }>(
      ({ values }) => {
        const multiplied = values.map(({ x }, index, array) => {
          return { multiplied: multiply({ x, index, array }) };
        });
        return { multiplied };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle patterns with map nodes",
      {
        type: "object",
        properties: {
          multiplied: {
            type: "array",
            items: {
              type: "object",
              properties: { multiplied: { type: "number" } },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    const result = runtime.run(tx, multipliedArray, {
      values: [{ x: 1 }, { x: 2 }, { x: 3 }],
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect(value).toMatchObjectIgnoringSymbols({
      multiplied: [{ multiplied: 3 }, { multiplied: 12 }, { multiplied: 27 }],
    });
  });

  it("should handle map nodes with undefined input", async () => {
    const double = lift((x: number) => x * 2);

    const doubleArray = pattern<{ values?: number[] }>(
      ({ values }) => {
        const doubled = values?.map((x) => double(x)) ?? [];
        return { doubled };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle map nodes with undefined input",
      {
        type: "object",
        properties: { doubled: { type: "array", items: { type: "number" } } },
      } as const satisfies JSONSchema,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: undefined,
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect(value).toMatchObjectIgnoringSymbols({ doubled: [] });
  });
});
