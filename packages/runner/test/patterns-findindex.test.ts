// findIndex tests: finding the index of the first matching element in a reactive array.

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

describe("Pattern Runner - findIndex", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
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
      pattern,
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should find the index of a matching element", async () => {
    const findPattern = pattern<{ items: number[] }>(
      ({ items }) => {
        const idx = items.findIndex((x: number) => x > 3);
        return { idx };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "findindex-basic",
      {
        type: "object",
        properties: { idx: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, findPattern, {
      items: [1, 2, 3, 4, 5],
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect((value as any).idx).toBe(3); // items[3] === 4
  });

  it("should return -1 when no element matches", async () => {
    const findPattern = pattern<{ items: number[] }>(
      ({ items }) => {
        const idx = items.findIndex((x: number) => x > 100);
        return { idx };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "findindex-no-match",
      {
        type: "object",
        properties: { idx: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, findPattern, {
      items: [1, 2, 3],
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect((value as any).idx).toBe(-1);
  });

  it("should return -1 for empty array", async () => {
    const findPattern = pattern<{ items: number[] }>(
      ({ items }) => {
        const idx = items.findIndex((x: number) => x > 0);
        return { idx };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "findindex-empty",
      {
        type: "object",
        properties: { idx: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, findPattern, {
      items: [],
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect((value as any).idx).toBe(-1);
  });

  it("should reactively update when input changes", async () => {
    const findPattern = pattern<{ items: number[] }>(
      ({ items }) => {
        const idx = items.findIndex((x: number) => x > 3);
        return { idx };
      },
    );

    const inputCell = runtime.getCell<{ items: number[] }>(
      space,
      "findindex-reactive-input",
      undefined,
      tx,
    );
    inputCell.set({ items: [1, 2, 3] });

    const resultCell = runtime.getCell(
      space,
      "findindex-reactive-result",
      {
        type: "object",
        properties: { idx: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, findPattern, inputCell, resultCell);
    tx.commit();

    let value = await result.pull();
    expect((value as any).idx).toBe(-1); // No element > 3

    // Update input to include a match
    tx = runtime.edit();
    inputCell.withTx(tx).set({ items: [1, 5, 3] });
    tx.commit();

    value = await result.pull();
    expect((value as any).idx).toBe(1); // items[1] === 5
  });

  it("should find first match in objects", async () => {
    interface Item {
      name: string;
      active: boolean;
    }
    const findPattern = pattern<{ items: Item[] }>(
      ({ items }) => {
        const idx = items.findIndex((item: Item) => item.active);
        return { idx };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "findindex-objects",
      {
        type: "object",
        properties: { idx: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, findPattern, {
      items: [
        { name: "a", active: false },
        { name: "b", active: false },
        { name: "c", active: true },
        { name: "d", active: true },
      ],
    }, resultCell);
    tx.commit();

    const value = await result.pull();
    expect((value as any).idx).toBe(2); // First active item
  });
});
