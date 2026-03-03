import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Schemas", () => {
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

  it("should handle schema with cell references", async () => {
    const schema = {
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
          required: ["value"],
        },
        multiplier: { type: "number" },
      },
      required: ["settings"],
    } as const satisfies JSONSchema;

    const multiplyPattern = pattern<{
      settings: { value: number };
      multiplier: number;
    }>(({ settings, multiplier }) => {
      const result = lift(
        schema,
        { type: "number" },
        ({ settings, multiplier }) => settings.value * multiplier!,
      )({ settings, multiplier });
      return { result };
    });

    const settingsCell = runtime.getCell<{ value: number }>(
      space,
      "should handle schema with cell references 1",
      undefined,
      tx,
    );
    settingsCell.withTx(tx).set({ value: 5 });
    tx.commit();
    await settingsCell.pull();
    tx = runtime.edit();

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should handle schema with cell references",
      undefined,
      tx,
    );
    const result = runtime.run(tx, multiplyPattern, {
      settings: settingsCell,
      multiplier: 3,
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    let value = await result.pull();
    expect(value).toEqual({ result: 15 });

    // Update the cell and verify the pattern recomputes
    settingsCell.withTx(tx).send({ value: 10 });
    tx.commit();
    tx = runtime.edit();

    value = await result.pull();
    expect(value).toEqual({ result: 30 });
  });

  it("should handle nested cell references in schema", async () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  value: { type: "number" },
                },
                asCell: true,
              },
            },
          },
          required: ["items"],
        },
      },
      required: ["data"],
    } as const satisfies JSONSchema;

    const sumPattern = pattern<{ data: { items: Array<{ value: number }> } }>(
      ({ data }) => {
        const result = lift(
          schema,
          { type: "number" },
          ({ data }) =>
            data.items.reduce(
              (sum: number, item: any) => sum + item.get().value,
              0,
            ),
        )({ data });
        return { result };
      },
    );

    const item1 = runtime.getCell<{ value: number }>(
      space,
      "should handle nested cell references in schema 1",
      undefined,
      tx,
    );
    item1.set({ value: 1 });
    const item2 = runtime.getCell<{ value: number }>(
      space,
      "should handle nested cell references in schema 2",
      undefined,
      tx,
    );
    item2.set({ value: 2 });
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should handle nested cell references in schema",
      undefined,
      tx,
    );
    const result = runtime.run(tx, sumPattern, {
      data: { items: [item1, item2] },
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect(value).toEqual({ result: 3 });
  });

  it("should handle dynamic cell references with schema", async () => {
    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: {
            type: "number",
            asCell: true,
          },
        },
      },
    } as const satisfies JSONSchema;

    const dynamicPattern = pattern<
      { context: Record<PropertyKey, number> }
    >(
      ({ context }) => {
        const result = lift(
          schema,
          { type: "number" },
          ({ context }) =>
            Object.values(context ?? {}).reduce(
              (sum: number, val) => sum + val.get(),
              0,
            ),
        )({ context });
        return { result };
      },
    );

    const value1 = runtime.getCell<number>(
      space,
      "should handle dynamic cell references with schema 1",
      undefined,
      tx,
    );
    value1.set(5);
    const value2 = runtime.getCell<number>(
      space,
      "should handle dynamic cell references with schema 2",
      undefined,
      tx,
    );
    value2.set(7);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should handle dynamic cell references with schema",
      undefined,
      tx,
    );
    const result = runtime.run(tx, dynamicPattern, {
      context: {
        first: value1,
        second: value2,
      },
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect(value).toEqual({ result: 12 });
  });
});
