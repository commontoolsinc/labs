import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { isQueryResult } from "../src/query-result-proxy.ts";
import { toCell, toOpaqueRef } from "../src/back-to-cell.ts";
import { ID, JSONSchema } from "../src/builder/types.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { addCommonIDfromObjectID } from "../src/data-updating.ts";
import { areLinksSame, isAnyCellLink, parseLink } from "../src/link-utils.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const signer2 = await Identity.fromPassphrase("test operator 2");
const space2 = signer2.did();

describe("Cell", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  it("should create a cell with initial value", () => {
    const c = runtime.getCell<number>(
      space,
      "should create a cell with initial value",
      undefined,
      tx,
    );
    c.set(10);
    expect(c.get()).toBe(10);
  });

  it("should update cell value using send", () => {
    const c = runtime.getCell<number>(
      space,
      "should update cell value using send",
      undefined,
      tx,
    );
    c.set(10);
    c.send(20);
    expect(c.get()).toBe(20);
  });

  it("should create a proxy for the cell", () => {
    const c = runtime.getCell<{ x: number; y: number }>(
      space,
      "should create a proxy for the cell",
      undefined,
      tx,
    );
    c.set({ x: 1, y: 2 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(1);
    expect(proxy.y).toBe(2);
  });

  it("should update cell value through proxy", () => {
    const c = runtime.getCell<{ x: number; y: number }>(
      space,
      "should update cell value through proxy",
      undefined,
      tx,
    );
    c.set({ x: 1, y: 2 });
    const proxy = c.getAsQueryResult();
    proxy.x = 10;
    expect(c.get()).toEqual({ x: 10, y: 2 });
  });

  it("should get value at path", () => {
    const c = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should get value at path",
      undefined,
      tx,
    );
    c.set({ a: { b: { c: 42 } } });
    expect(c.key("a").key("b").key("c").get()).toBe(42);
  });

  it("should set value at path", () => {
    const c = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should set value at path",
      undefined,
      tx,
    );
    c.set({ a: { b: { c: 42 } } });
    c.getAsQueryResult().a.b.c = 100;
    expect(c.key("a").key("b").key("c").get()).toBe(100);
  });

  it("should get raw value using getRaw", () => {
    const cell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should get raw value using getRaw",
      undefined,
      tx,
    );
    cell.set({ x: 1, y: 2 });
    expect(cell.getRaw()).toEqual({ x: 1, y: 2 });
  });

  it("should set raw value using setRaw", () => {
    const cell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should set raw value using setRaw",
      undefined,
      tx,
    );
    cell.set({ x: 1, y: 2 });
    cell.setRaw({ x: 10, y: 20 });
    expect(cell.getRaw()).toEqual({ x: 10, y: 20 });
  });

  it("should work with primitive values in getRaw/setRaw", () => {
    const cell = runtime.getCell<number>(
      space,
      "should work with primitive values in getRaw/setRaw",
      undefined,
      tx,
    );
    cell.set(42);

    expect(cell.getRaw()).toBe(42);

    cell.setRaw(100);
    expect(cell.getRaw()).toBe(100);
  });

  it("should work with arrays in getRaw/setRaw", () => {
    const cell = runtime.getCell<number[]>(
      space,
      "should work with arrays in getRaw/setRaw",
      undefined,
      tx,
    );
    cell.set([1, 2, 3]);

    expect(cell.getRaw()).toEqual([1, 2, 3]);

    cell.setRaw([4, 5, 6]);
    expect(cell.getRaw()).toEqual([4, 5, 6]);
  });

  it("should respect path in getRaw/setRaw for nested properties", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "should respect path in getRaw/setRaw for nested properties",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    // getRaw should return only the nested value
    expect(nestedCell.getRaw()).toBe(42);

    // same for setRaw, should update only the nested value
    nestedCell.setRaw(100);
    expect(nestedCell.getRaw()).toBe(100);

    // Verify the document structure is preserved
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should set and get the source cell", () => {
    // Create two cells
    const sourceCell = runtime.getCell<{ foo: number }>(
      space,
      "source cell for setSourceCell/getSourceCell test",
      undefined,
      tx,
    );
    sourceCell.set({ foo: 123 });

    const targetCell = runtime.getCell<{ bar: string }>(
      space,
      "target cell for setSourceCell/getSourceCell test",
      undefined,
      tx,
    );
    targetCell.set({ bar: "baz" });

    // Initially, getSourceCell should return undefined
    expect(targetCell.getSourceCell()).toBeUndefined();

    // Set the source cell
    targetCell.setSourceCell(sourceCell);

    // Now getSourceCell should return a Cell with the same value as sourceCell
    const retrievedSource = targetCell.getSourceCell();
    expect(isCell(retrievedSource)).toBe(true);
    expect(retrievedSource?.get()).toEqual({ foo: 123 });

    // Changing the source cell's value should be reflected
    sourceCell.set({ foo: 456 });
    expect(retrievedSource?.get()).toEqual({ foo: 456 });
  });

  it("should translate circular references into links", () => {
    const c = runtime.getCell(
      space,
      "should translate circular references into links",
      {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          z: { $ref: "#" },
        },
        required: ["x", "y", "z"],
      } as const satisfies JSONSchema,
      tx,
    );
    const data: any = { x: 1, y: 2 };
    data.z = data;
    c.set(data);

    const proxy = c.getAsQueryResult();
    expect(proxy.z).toBe(proxy);

    const value = c.get();
    expect(value.z.z.z).toBe(value.z.z);

    const raw = c.getRaw();
    expect(raw?.z).toMatchObject({ "/": { [LINK_V1_TAG]: { path: [] } } });
  });

  it("should translate circular references into links across cells", () => {
    const c = runtime.getCell(
      space,
      "should translate circular references into links",
      {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: {
              type: "object",
              properties: { parent: { $ref: "#" } },
              asCell: true,
              required: ["parent"],
            },
          },
        },
        required: ["list"],
      } as const satisfies JSONSchema,
      tx,
    );
    const inner: any = { [ID]: 1 }; // ID will turn this into a separate cell
    const outer: any = { list: [inner] };
    inner.parent = outer;
    c.set(outer);

    const proxy = c.getAsQueryResult();
    expect(proxy.list[0].parent).toBe(proxy);

    const { id } = c.getAsNormalizedFullLink();
    const innerCell = c.get().list[0];
    const raw = innerCell.getRaw();
    expect(raw).toMatchObject({
      parent: { "/": { [LINK_V1_TAG]: { id } } },
    });
  });
});

describe("Cell utility functions", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  it("should identify a cell", () => {
    const c = runtime.getCell(
      space,
      "should identify a cell",
      undefined,
      tx,
    );
    c.set(10);
    expect(isCell(c)).toBe(true);
    expect(isCell({})).toBe(false);
  });

  it("should identify a cell reference", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should identify a cell reference",
      undefined,
      tx,
    );
    c.set({ x: 10 });
    const ref = c.key("x").getAsLink();
    expect(isAnyCellLink(ref)).toBe(true);
    expect(isAnyCellLink({})).toBe(false);
  });

  it("should identify a cell proxy", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should identify a cell proxy",
      undefined,
      tx,
    );
    c.set({ x: 1 });
    const proxy = c.getAsQueryResult();
    expect(isQueryResult(proxy)).toBe(true);
    expect(isQueryResult({})).toBe(false);
  });
});

describe("createProxy", () => {
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

  it("should create a proxy for nested objects", () => {
    const c = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should create a proxy for nested objects",
      undefined,
      tx,
    );
    c.set({ a: { b: { c: 42 } } });
    const proxy = c.getAsQueryResult();
    expect(proxy.a.b.c).toBe(42);
  });

  it("should support regular assigments", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should support regular assigments",
      undefined,
      tx,
    );
    c.set({ x: 1 });
    const proxy = c.getAsQueryResult();
    proxy.x = 2;
    expect(c.get()).toStrictEqual({ x: 2 });
  });

  it("should handle $alias in objects", () => {
    const c = runtime.getCell(
      space,
      "should handle $alias in objects",
      undefined,
      tx,
    );
    c.setRaw({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle aliases when writing", () => {
    const c = runtime.getCell<{ x: number; y: number }>(
      space,
      "should handle aliases when writing",
      undefined,
      tx,
    );
    c.setRaw({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    proxy.x = 100;
    expect(c.get().y).toBe(100);
  });

  it("should handle nested cells", () => {
    const innerCell = runtime.getCell<number>(
      space,
      "should handle nested cells inner",
      undefined,
      tx,
    );
    innerCell.set(42);
    const outerCell = runtime.getCell<{ x: any }>(
      space,
      "should handle nested cells outer",
      undefined,
      tx,
    );
    outerCell.set({ x: innerCell });
    const proxy = outerCell.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle cell references", () => {
    const c = runtime.getCell<{ x: number; y?: any }>(
      space,
      "should handle cell references",
      undefined,
      tx,
    );
    c.set({ x: 42 });
    const ref = c.key("x").getAsLink();
    const proxy = c.getAsQueryResult();
    proxy.y = ref;
    expect(proxy.y).toBe(42);
  });

  it("should handle infinite loops in cell references", () => {
    const c = runtime.getCell<{ x: number; y?: any }>(
      space,
      "should handle infinite loops in cell references",
      undefined,
      tx,
    );
    c.set({ x: 42 });
    const ref = c.key("x").getAsLink();
    const proxy = c.getAsQueryResult();
    proxy.x = ref;
    expect(proxy.x).toBe(42);
  });

  it.skip("should support modifying array methods and log reads and writes", () => {
    const c = runtime.getCell<{ array: number[] }>(
      space,
      "should support modifying array methods and log reads and writes",
    );
    c.set({ array: [1, 2, 3] });
    const proxy = c.getAsQueryResult();
    const log = txToReactivityLog(tx);
    expect(log.reads.length).toBe(1);
    expect(proxy.array.length).toBe(3);
    // only read array, but not the elements
    expect(log.reads.length).toBe(2);

    proxy.array.push(4);
    expect(proxy.array.length).toBe(4);
    expect(proxy.array[3]).toBe(4);
    expect(
      log.writes.some((write) =>
        write.path[0] === "array" && write.path[1] === "3"
      ),
    ).toBe(true);
  });

  it.skip("should handle array methods on previously undefined arrays", () => {
    const c = runtime.getCell<{ data: any }>(
      space,
      "should handle array methods on previously undefined arrays",
    );
    c.set({ data: {} });
    const proxy = c.getAsQueryResult();

    // Array doesn't exist yet
    expect(proxy.data.array).toBeUndefined();

    // Create an array using push
    proxy.data.array = [];
    proxy.data.array.push(1);
    expect(proxy.data.array.length).toBe(1);
    expect(proxy.data.array[0]).toBe(1);

    // Add more items
    proxy.data.array.push(2, 3);
    expect(proxy.data.array.length).toBe(3);
    expect(proxy.data.array[2]).toBe(3);

    // Check that writes were logged
    const log = txToReactivityLog(tx);
    expect(
      log.writes.some((write) =>
        write.path[0] === "data" && write.path[1] === "array"
      ),
    ).toBe(true);
  });

  it("should handle array results from array methods", () => {
    const c = runtime.getCell<{ array: number[] }>(
      space,
      "should handle array results from array methods",
      undefined,
      tx,
    );
    c.set({ array: [1, 2, 3, 4, 5] });
    const proxy = c.getAsQueryResult();

    // Methods that return arrays should return query result proxies
    const mapped = proxy.array.map((n: number) => n * 2);
    expect(isQueryResult(mapped)).toBe(false);
    expect(mapped.length).toBe(5);
    expect(mapped[0]).toBe(2);
    expect(mapped[4]).toBe(10);

    const filtered = proxy.array.filter((n: number) => n % 2 === 0);
    expect(isQueryResult(filtered)).toBe(false);
    expect(filtered.length).toBe(2);
    expect(filtered[0]).toBe(2);
    expect(filtered[1]).toBe(4);

    const sliced = proxy.array.slice(1, 4);
    expect(isQueryResult(sliced)).toBe(false);
    expect(sliced.length).toBe(3);
    expect(sliced[0]).toBe(2);
    expect(sliced[2]).toBe(4);
  });

  it("should maintain reactivity with nested array operations", () => {
    const c = runtime.getCell<{ nested: { arrays: number[][] } }>(
      space,
      "should maintain reactivity with nested array operations",
      undefined,
      tx,
    );
    c.set({ nested: { arrays: [[1, 2], [3, 4]] } });
    const proxy = c.getAsQueryResult();

    // Access a nested array through multiple levels
    const firstInnerArray = proxy.nested.arrays[0];
    expect(firstInnerArray).toEqual([1, 2]);
    expect(isQueryResult(firstInnerArray)).toBe(true);

    // Modify the deeply nested array
    firstInnerArray.push(3);
    expect(firstInnerArray).toEqual([1, 2, 3]);

    // Verify the change is reflected in the original data
    expect(proxy.nested.arrays[0]).toEqual([1, 2, 3]);
    expect(c.get().nested.arrays[0]).toEqual([1, 2, 3]);

    // Create a flattened array using array methods
    const flattened = proxy.nested.arrays.flat();
    expect(flattened).toEqual([1, 2, 3, 3, 4]);
    expect(isQueryResult(flattened)).toBe(false);

    // Modify the flattened result
    flattened[0] = 10;
    expect(flattened[0]).toBe(10);

    // Original arrays should not be affected by modifying the flattened result
    expect(proxy.nested.arrays[0][0]).toBe(1);
  });

  it("should support spreading array query results with for...of", () => {
    const c = runtime.getCell<{ items: { name: string }[] }>(
      space,
      "should support spreading array query results",
      undefined,
      tx,
    );
    c.set({ items: [{ name: "a" }, { name: "b" }, { name: "c" }] });
    const proxy = c.getAsQueryResult();

    // Use for...of loop to iterate over the array
    const collected: any[] = [];
    for (const item of proxy.items) {
      collected.push(item);
    }

    expect(collected.length).toBe(3);

    // Each element should be a query result proxy (for objects)
    expect(isQueryResult(collected[0])).toBe(true);
    expect(isQueryResult(collected[1])).toBe(true);
    expect(isQueryResult(collected[2])).toBe(true);

    // We can access properties through the proxies
    expect(collected[0].name).toBe("a");
    expect(collected[1].name).toBe("b");
    expect(collected[2].name).toBe("c");
  });

  it("should support spreading array query results with spread operator", () => {
    const c = runtime.getCell<{ items: { id: number }[] }>(
      space,
      "should support spreading array with spread operator",
      undefined,
      tx,
    );
    c.set({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const proxy = c.getAsQueryResult();

    // Spread the array into a new array
    const spread = [...proxy.items];

    expect(spread.length).toBe(3);

    // Each element should be a query result proxy (for objects)
    expect(isQueryResult(spread[0])).toBe(true);
    expect(isQueryResult(spread[1])).toBe(true);
    expect(isQueryResult(spread[2])).toBe(true);

    // Verify we can access properties
    expect(spread[0].id).toBe(1);
    expect(spread[1].id).toBe(2);
    expect(spread[2].id).toBe(3);
  });

  it("should support spreading nested array query results", () => {
    const c = runtime.getCell<{ nested: { data: { value: number }[][] } }>(
      space,
      "should support spreading nested arrays",
      undefined,
      tx,
    );
    c.set({
      nested: {
        data: [[{ value: 1 }, { value: 2 }], [{ value: 3 }, { value: 4 }]],
      },
    });
    const proxy = c.getAsQueryResult();

    // Spread the outer array
    const outerSpread = [...proxy.nested.data];
    expect(outerSpread.length).toBe(2);

    // Each inner array should be a query result proxy
    expect(isQueryResult(outerSpread[0])).toBe(true);
    expect(isQueryResult(outerSpread[1])).toBe(true);

    // Spread an inner array
    const innerSpread = [...outerSpread[0]];
    expect(innerSpread.length).toBe(2);

    // Elements of the inner array should also be query result proxies (for objects)
    expect(isQueryResult(innerSpread[0])).toBe(true);
    expect(isQueryResult(innerSpread[1])).toBe(true);

    // Verify we can access properties
    expect(innerSpread[0].value).toBe(1);
    expect(innerSpread[1].value).toBe(2);
  });

  it("should support spreading arrays with cell references", () => {
    // Create individual cells to reference
    const cell1 = runtime.getCell<{ name: string; value: number }>(
      space,
      "ref-cell-1",
      undefined,
      tx,
    );
    cell1.set({ name: "first", value: 100 });

    const cell2 = runtime.getCell<{ name: string; value: number }>(
      space,
      "ref-cell-2",
      undefined,
      tx,
    );
    cell2.set({ name: "second", value: 200 });

    const cell3 = runtime.getCell<{ name: string; value: number }>(
      space,
      "ref-cell-3",
      undefined,
      tx,
    );
    cell3.set({ name: "third", value: 300 });

    // Create an array cell containing references to other cells
    const arrayCell = runtime.getCell<any[]>(
      space,
      "array-with-refs",
      undefined,
      tx,
    );
    arrayCell.set([cell1, cell2, cell3]);

    const proxy = arrayCell.getAsQueryResult();

    // Spread the array
    const spread = [...proxy];

    expect(spread.length).toBe(3);

    // Each element should be a query result proxy
    expect(isQueryResult(spread[0])).toBe(true);
    expect(isQueryResult(spread[1])).toBe(true);
    expect(isQueryResult(spread[2])).toBe(true);

    // Verify we can access the referenced cells' data
    expect(spread[0].name).toBe("first");
    expect(spread[0].value).toBe(100);
    expect(spread[1].name).toBe("second");
    expect(spread[1].value).toBe(200);
    expect(spread[2].name).toBe("third");
    expect(spread[2].value).toBe(300);

    // Use for...of to iterate
    const names: string[] = [];
    for (const item of proxy) {
      names.push(item.name);
    }
    expect(names).toEqual(["first", "second", "third"]);
  });

  it.skip("should support pop() and only read the popped element", () => {
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should support pop() and only read the popped element",
    );
    c.set({ a: [] as number[] });
    const proxy = c.getAsQueryResult();
    proxy.a = [1, 2, 3];
    const result = proxy.a.pop();
    const log = txToReactivityLog(tx);
    const pathsRead = log.reads.map((r) => r.path.join("."));
    expect(pathsRead).toContain("a.2");
    // TODO(seefeld): diffAndUpdate could be more optimal here, right now it'll
    // mark as read the whole array since it isn't aware of the pop operation.
    // expect(pathsRead).not.toContain("a.0");
    // expect(pathsRead).not.toContain("a.1");
    expect(result).toEqual(3);
    expect(proxy.a).toEqual([1, 2]);
  });

  it.skip("should correctly sort() with cell references", () => {
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should correctly sort() with cell references",
    );
    c.set({ a: [] as number[] });
    const proxy = c.getAsQueryResult();
    proxy.a = [3, 1, 2];
    const result = proxy.a.sort();
    expect(result).toEqual([1, 2, 3]);
    expect(proxy.a).toEqual([1, 2, 3]);
  });

  it.skip("should support readonly array methods and log reads", () => {
    const c = runtime.getCell<number[]>(
      space,
      "should support readonly array methods and log reads",
    );
    c.set([1, 2, 3]);
    const proxy = c.getAsQueryResult();
    const result = proxy.find((x: any) => x === 2);
    expect(result).toBe(2);
    expect(c.get()).toEqual([1, 2, 3]);
    const log = txToReactivityLog(tx);
    expect(log.reads.map((r) => r.path)).toEqual([[], ["0"], ["1"], ["2"]]);
    expect(log.writes).toEqual([]);
  });

  it.skip("should support mapping over a proxied array", () => {
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should support mapping over a proxied array",
    );
    c.set({ a: [1, 2, 3] });
    const proxy = c.getAsQueryResult();
    const result = proxy.a.map((x: any) => x + 1);
    expect(result).toEqual([2, 3, 4]);
    const log = txToReactivityLog(tx);
    expect(log.reads.map((r) => r.path)).toEqual([
      [],
      ["a"],
      ["a", "0"],
      ["a", "1"],
      ["a", "2"],
    ]);
  });

  it.skip("should allow changing array lengths by writing length", () => {
    const c = runtime.getCell<number[]>(
      space,
      "should allow changing array lengths by writing length",
    );
    c.set([1, 2, 3]);
    const proxy = c.getAsQueryResult();
    proxy.length = 2;
    expect(c.get()).toEqual([1, 2]);
    const log = txToReactivityLog(tx);
    expect(areLinksSame(log.writes[0], c.key("length").getAsLink()))
      .toBe(true);
    expect(areLinksSame(log.writes[1], c.key(2).getAsLink())).toBe(
      true,
    );
    proxy.length = 4;
    const cLink = c.getAsNormalizedFullLink();
    expect(c.get()).toEqual([1, 2, undefined, undefined]);
    expect(log.writes.length).toBe(5);
    expect(log.writes[2].id).toBe(cLink.id);
    expect(log.writes[2].path).toEqual(["length"]);
    expect(log.writes[3].id).toBe(cLink.id);
    expect(log.writes[3].path).toEqual([2]);
    expect(log.writes[4].id).toBe(cLink.id);
    expect(log.writes[4].path).toEqual([3]);
  });

  it.skip("should allow changing array by splicing", () => {
    const c = runtime.getCell<number[]>(
      space,
      "should allow changing array by splicing",
    );
    c.set([1, 2, 3]);
    const proxy = c.getAsQueryResult();
    proxy.splice(1, 1, 4, 5);
    expect(c.get()).toEqual([1, 4, 5, 3]);
    const log = txToReactivityLog(tx);
    const cLink = c.getAsNormalizedFullLink();
    expect(log.writes.length).toBe(3);
    expect(log.writes[0].id).toBe(cLink.id);
    expect(log.writes[0].path).toEqual(["1"]);
    expect(log.writes[1].id).toBe(cLink.id);
    expect(log.writes[1].path).toEqual(["2"]);
    expect(log.writes[2].id).toBe(cLink.id);
    expect(log.writes[2].path).toEqual(["3"]);
  });
});

describe("Proxy", () => {
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

  it("should return a Sendable for stream aliases", async () => {
    const c = runtime.getCell<{ stream: { $stream: true } }>(
      space,
      "should return a Sendable for stream aliases",
      undefined,
      tx,
    );
    c.setRaw({ stream: { $stream: true } });
    tx.commit();

    tx = runtime.edit();

    const streamCell = c.key("stream");

    expect(streamCell).toHaveProperty("send");
    expect(streamCell).not.toHaveProperty("get");
    expect(streamCell).not.toHaveProperty("set");
    expect(streamCell).not.toHaveProperty("key");

    let lastEventSeen: any = null;
    let eventCount = 0;

    runtime.scheduler.addEventHandler(
      (_tx: IExtendedStorageTransaction, event: any) => {
        eventCount++;
        lastEventSeen = event;
      },
      streamCell.getAsNormalizedFullLink(),
    );

    streamCell.send({ $stream: true });
    await runtime.idle();

    expect(c.get()).toStrictEqual({ stream: { $stream: true } });
    expect(eventCount).toBe(1);
    expect(lastEventSeen).toEqual({ $stream: true });
  });

  it("should convert cells and proxies to links when sending events", async () => {
    const c = runtime.getCell<any>(
      space,
      "should convert cells and proxies to links when sending events",
    );
    c.withTx(tx).setRaw({ stream: { $stream: true } });
    tx.commit();
    tx = runtime.edit();

    const streamCell = c.key("stream");

    let lastEventSeen: any = null;
    let eventCount = 0;

    runtime.scheduler.addEventHandler(
      (_tx: IExtendedStorageTransaction, event: any) => {
        eventCount++;
        lastEventSeen = event;
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const c2 = runtime.getCell(
      space,
      "should convert cells and proxies to links when sending events: payload",
      {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      } as const satisfies JSONSchema,
      tx,
    );
    c2.withTx(tx).set({ x: 1, y: 2 });
    tx.commit();
    tx = runtime.edit();

    // Create event, with cell, query result and circular reference.
    const event: any = { a: c2, b: c2.getAsQueryResult() };
    event.c = event;

    streamCell.send(event);

    await runtime.idle();

    expect(eventCount).toBe(1);
    const { id } = c2.getAsNormalizedFullLink();
    expect(lastEventSeen).toEqual(
      {
        a: { "/": { [LINK_V1_TAG]: { id, path: [], space } } },
        b: { "/": { [LINK_V1_TAG]: { id, path: [], space } } },
        c: { "/": { [LINK_V1_TAG]: { path: [] } } },
      },
    );
  });
});

describe("asCell", () => {
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

  it("should create a simple cell interface", () => {
    const simpleCell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should create a simple cell interface",
      undefined,
      tx,
    );
    simpleCell.set({ x: 1, y: 2 });

    expect(simpleCell.get()).toEqual({ x: 1, y: 2 });

    simpleCell.set({ x: 3, y: 4 });
    expect(simpleCell.get()).toEqual({ x: 3, y: 4 });

    simpleCell.send({ x: 5, y: 6 });
    expect(simpleCell.get()).toEqual({ x: 5, y: 6 });
  });

  it("should create a simple cell for nested properties", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "should create a simple cell for nested properties",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should support the key method for nested access", () => {
    const simpleCell = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should support the key method for nested access",
      undefined,
      tx,
    );
    simpleCell.set({ a: { b: { c: 42 } } });

    const nestedCell = simpleCell.key("a").key("b").key("c");
    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(simpleCell.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should call sink only when the cell changes on the subpath", async () => {
    const c = runtime.getCell<{ a: { b: number; c: number }; d: number }>(
      space,
      "should call sink only when the cell changes on the subpath",
      undefined,
      tx,
    );
    c.set({ a: { b: 42, c: 10 }, d: 5 });
    tx.commit();
    tx = runtime.edit();
    const values: number[] = [];
    c.key("a").key("b").sink((value) => {
      values.push(value);
    });
    expect(values).toEqual([42]); // Initial call
    c.withTx(tx).getAsQueryResult().d = 50;
    tx.commit();
    tx = runtime.edit();
    c.withTx(tx).getAsQueryResult().a.c = 100;
    tx.commit();
    tx = runtime.edit();
    c.withTx(tx).getAsQueryResult().a.b = 42;
    tx.commit();
    tx = runtime.edit();
    expect(values).toEqual([42]); // Didn't get called again
    c.withTx(tx).getAsQueryResult().a.b = 300;
    tx.commit();
    await runtime.idle();
    expect(c.get()).toEqual({ a: { b: 300, c: 100 }, d: 50 });
    expect(values).toEqual([42, 300]); // Got called again
  });

  it("behaves correctly when setting a cell to itself", () => {
    const c = runtime.getCell<{ a: number }>(
      space,
      "behaves correctly when setting a cell to itself",
      undefined,
      tx,
    );
    c.set({ a: 1 });
    c.set(c);
    expect(c.get()).toEqual({ a: 1 });
  });

  it("behaves correctly when setting a cell to itself, any schema", () => {
    const c = runtime.getCell<{ a: number }>(
      space,
      "behaves correctly when setting a cell to itself, any schema",
      undefined,
      tx,
    );
    c.set({ a: 1 });
    c.set(c.get());
    expect(c.get()).toEqual({ a: 1 });
  });

  it("behaves correctly when setting a cell to itself, asCell schema", () => {
    const c = runtime.getCell(
      space,
      "behaves correctly when setting a cell to itself, asCell schema",
      {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"],
        asCell: true,
      } as const satisfies JSONSchema,
      tx,
    );
    c.set({ a: 1 });
    c.set(c.get());
    expect(c.get().get()).toEqualIgnoringSymbols({ a: 1 });
  });
});

describe("asCell with schema", () => {
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

  it("should validate and transform according to schema", () => {
    const c = runtime.getCell<{
      name: string;
      age: number;
      tags: string[];
      nested: { value: number };
    }>(
      space,
      "should validate and transform according to schema",
      undefined,
      tx,
    );
    c.set({
      name: "test",
      age: 42,
      tags: ["a", "b"],
      nested: {
        value: 123,
      },
    });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        nested: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
          required: ["value"],
        },
      },
      required: ["name", "age", "tags", "nested"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get() as any;

    expect(value.name).toBe("test");
    expect(value.age).toBe(42);
    expect(value.tags).toEqualIgnoringSymbols(["a", "b"]);
    expect(value.nested.value).toBe(123);
  });

  it("should return a Cell for reference properties", () => {
    const c = runtime.getCell<{
      id: number;
      metadata: {
        createdAt: string;
        type: string;
      };
    }>(
      space,
      "should return a Cell for reference properties",
      undefined,
      tx,
    );
    c.set({
      id: 1,
      metadata: {
        createdAt: "2025-01-06",
        type: "user",
      },
    });

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          asCell: true,
        },
      },
      required: ["id", "metadata"],
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get();

    expect(value.id).toBe(1);
    expect(isCell(value.metadata)).toBe(true);

    // The metadata cell should behave like a normal cell
    const metadataValue = value.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });

  it("should handle recursive schemas with $ref", () => {
    const c = runtime.getCell<{
      name: string;
      children: Array<{
        name: string;
        children: any[];
      }>;
    }>(
      space,
      "should handle recursive schemas with $ref",
      undefined,
      tx,
    );
    c.set({
      name: "root",
      children: [
        {
          name: "child1",
          children: [],
        },
        {
          name: "child2",
          children: [
            {
              name: "grandchild",
              children: [],
            },
          ],
        },
      ],
    });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        children: {
          type: "array",
          items: { $ref: "#" },
        },
      },
      required: ["name", "children"],
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get();

    expect(value.name).toBe("root");
    expect(value.children[0].name).toBe("child1");
    expect(value.children[1].name).toBe("child2");
    expect(value.children[1].children[0].name).toBe("grandchild");
  });

  it("should propagate schema through key() navigation", () => {
    const c = runtime.getCell<{
      user: {
        profile: {
          name: string;
          settings: {
            theme: string;
            notifications: boolean;
          };
        };
        metadata: {
          id: string;
          type: string;
        };
      };
    }>(
      space,
      "should propagate schema through key() navigation",
      undefined,
      tx,
    );
    c.set({
      user: {
        profile: {
          name: "John",
          settings: {
            theme: "dark",
            notifications: true,
          },
        },
        metadata: {
          id: "123",
          type: "admin",
        },
      },
    });

    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: {
                name: { type: "string" },
                settings: {
                  type: "object",
                  asCell: true,
                },
              },
              required: ["name", "settings"],
            },
            metadata: {
              type: "object",
              asCell: true,
            },
          },
          required: ["profile", "metadata"],
        },
      },
      required: ["user"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const userCell = cell.key("user");
    const profileCell = userCell.key("profile");

    const value = profileCell.get();
    expect(value.name).toBe("John");
    expect(isCell(value.settings)).toBe(true);

    // Test that references are preserved through the entire chain
    const userValue = userCell.get();
    expect(isCell(userValue.metadata)).toBe(true);
  });

  it("should fall back to query result proxy when no schema is present", () => {
    const c = runtime.getCell<{
      data: {
        value: number;
        nested: {
          str: string;
        };
      };
    }>(
      space,
      "should fall back to query result proxy when no schema is present",
      undefined,
      tx,
    );
    c.set({
      data: {
        value: 42,
        nested: {
          str: "hello",
        },
      },
    });

    const value = c.get();

    // Should behave like a query result proxy
    expect(value.data.value).toBe(42);
    expect(value.data.nested.str).toBe("hello");
  });

  it("should allow changing schema with asSchema", () => {
    const c = runtime.getCell<{
      id: number;
      metadata: {
        createdAt: string;
        type: string;
      };
    }>(
      space,
      "should allow changing schema with asSchema",
      undefined,
      tx,
    );
    c.set({
      id: 1,
      metadata: {
        createdAt: "2025-01-06",
        type: "user",
      },
    });

    // Start with a schema that doesn't mark metadata as a reference
    const initialSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          properties: {
            createdAt: { type: "string" },
            type: { type: "string" },
          },
        },
      },
      required: ["id", "metadata"],
    } as const satisfies JSONSchema;

    // Create a schema that marks metadata as a reference
    const referenceSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          properties: {
            createdAt: { type: "string" },
            type: { type: "string" },
          },
          asCell: true,
        },
      },
      required: ["id", "metadata"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(initialSchema);
    const value = cell.get();

    // With initial schema, metadata is not a Cell
    expect(value.id).toBe(1);
    expect(isCell(value.metadata)).toBe(false);
    expect(value.metadata.createdAt).toBe("2025-01-06");

    // Switch to reference schema
    const referenceCell = cell.asSchema(referenceSchema);
    const refValue = referenceCell.get();

    // Now metadata should be a Cell
    expect(refValue.id).toBe(1);
    expect(isCell(refValue.metadata)).toBe(true);

    // But we can still get the raw value
    const metadataValue = refValue.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });

  it("should handle objects with additional properties as references", () => {
    const c = runtime.getCell<{
      id: number;
      context: {
        user: { name: string };
        settings: { theme: string };
        data: { value: number };
      };
    }>(
      space,
      "should handle objects with additional properties as references",
      undefined,
      tx,
    );
    c.set({
      id: 1,
      context: {
        user: { name: "John" },
        settings: { theme: "dark" },
        data: { value: 42 },
      },
    });

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        context: {
          type: "object",
          additionalProperties: {
            type: "object",
            asCell: true,
          },
        },
      },
      required: ["id", "context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // Regular property works normally
    expect(value.id).toBe(1);

    // Each property in context should be a Cell
    expect(isCell(value.context.user)).toBe(true);
    expect(isCell(value.context.settings)).toBe(true);
    expect(isCell(value.context.data)).toBe(true);

    // But we can still get their values
    expect(value.context.user.get().name).toBe("John");
    expect(value.context.settings.get().theme).toBe("dark");
    expect(value.context.data.get().value).toBe(42);
  });

  it("should handle additional properties with just reference: true", () => {
    const c = runtime.getCell<{
      context: {
        number: number;
        string: string;
        object: { value: number };
        array: number[];
      };
    }>(
      space,
      "should handle additional properties with just reference: true",
      undefined,
      tx,
    );
    c.set({
      context: {
        number: 42,
        string: "hello",
        object: { value: 123 },
        array: [1, 2, 3],
      },
    });

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
      required: ["context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // All properties in context should be Cells regardless of their type
    expect(isCell(value.context.number)).toBe(true);
    expect(isCell(value.context.string)).toBe(true);
    expect(isCell(value.context.object)).toBe(true);
    expect(isCell(value.context.array)).toBe(true);

    // Values should be preserved
    expect(value.context.number.get()).toBe(42);
    expect(value.context.string.get()).toBe("hello");
    expect(value.context.object.get()).toEqual({ value: 123 });
    expect(value.context.array.get()).toEqual([1, 2, 3]);
  });

  it("should handle references in underlying cell", () => {
    // Create a cell with a reference
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle references in underlying cell",
      undefined,
      tx,
    );
    innerCell.set({ value: 42 });

    // Create a cell that uses that reference
    const c = runtime.getCell<{
      context: {
        inner: any;
      };
    }>(
      space,
      "should handle references in underlying cell outer",
      undefined,
      tx,
    );
    c.set({
      context: {
        inner: innerCell,
      },
    });

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
      required: ["context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // The inner reference should be preserved but wrapped in a new Cell
    expect(isCell(value.context.inner)).toBe(true);
    expect(value.context.inner.get().value).toBe(42);

    // Changes to the original cell should propagate
    innerCell.send({ value: 100 });
    expect(value.context.inner.get().value).toBe(100);
  });

  it("should handle all types of references in underlying cell", () => {
    // Create cells with different types of references
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle all types of references in underlying cell: inner",
      undefined,
      tx,
    );
    innerCell.set({ value: 42 });
    const cellRef = innerCell.getAsLink();
    const aliasRef = innerCell.getAsWriteRedirectLink();

    // Create a cell that uses all reference types
    const c = runtime.getCell<{
      context: {
        cell: any;
        reference: any;
        alias: any;
      };
    }>(
      space,
      "should handle all types of references in underlying cell main",
      undefined,
      tx,
    );
    c.set({
      context: {
        cell: innerCell,
        reference: cellRef,
        alias: aliasRef,
      },
    });

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
      required: ["context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // All references should be preserved but wrapped in Cells
    expect(isCell(value.context.cell)).toBe(true);
    expect(isCell(value.context.reference)).toBe(true);
    expect(isCell(value.context.alias)).toBe(true);

    // All should point to the same value
    expect(value.context.cell.get().value).toBe(42);
    expect(value.context.reference.get().value).toBe(42);
    expect(value.context.alias.get().value).toBe(42);

    // Changes to the original cell should propagate to all references
    innerCell.send({ value: 100 });
    expect(value.context.cell.get().value).toBe(100);
    expect(value.context.reference.get().value).toBe(100);
    expect(value.context.alias.get().value).toBe(100);
  });

  it.skip("should handle nested references", () => {
    // Create a chain of references
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle nested references: inner",
      undefined,
      tx,
    );
    innerCell.set({ value: 42 });

    const ref1 = innerCell.getAsLink();

    const ref2Cell = runtime.getCell<{ ref: any }>(
      space,
      "should handle nested references: ref2",
      undefined,
      tx,
    );
    ref2Cell.set({ ref: ref1 });
    const ref2 = ref2Cell.key("ref").getAsLink();

    const ref3Cell = runtime.getCell<{ ref: any }>(
      space,
      "should handle nested references: ref3",
      undefined,
      tx,
    );
    ref3Cell.setRaw({ ref: ref2 });
    const ref3 = ref3Cell.key("ref").getAsLink();

    // Create a cell that uses the nested reference
    const cell = runtime.getCell<{
      context: {
        nested: any;
      };
    }>(
      space,
      "should handle nested references main",
      {
        type: "object",
        properties: {
          context: {
            type: "object",
            additionalProperties: { asCell: true },
          },
        },
        required: ["context"],
      } as const satisfies JSONSchema,
      tx,
    );
    cell.set({
      context: {
        nested: ref3,
      },
    });

    const value = cell.get() as any;

    // The nested reference should be followed all the way to the inner value
    expect(isCell(value.context.nested)).toBe(true);
    expect(value.context.nested.get().value).toBe(42);

    // Check that 4 unique documents were read (by entity ID)
    const log = txToReactivityLog(tx);
    const readEntityIds = new Set(log.reads.map((r) => r.id));
    expect(readEntityIds.size).toBe(4);

    // Verify each cell was read using equals()
    const readCells = log.reads.map((r) => runtime.getCellFromLink(r));
    expect(readCells.some((c2) => c2.equals(cell))).toBe(true);
    expect(readCells.some((c2) => c2.equals(ref3Cell))).toBe(true);
    expect(readCells.some((c2) => c2.equals(ref2Cell))).toBe(true);
    expect(readCells.some((c2) => c2.equals(innerCell))).toBe(true);

    // Changes to the original cell should propagate through the chain
    innerCell.send({ value: 100 });
    expect(value.context.nested.get().value).toBe(100);
  });

  it("should handle array schemas in key() navigation", () => {
    const c = runtime.getCell<{
      items: Array<{ name: string; value: number }>;
    }>(
      space,
      "should handle array schemas in key() navigation",
      undefined,
      tx,
    );
    c.set({
      items: [
        { name: "item1", value: 1 },
        { name: "item2", value: 2 },
      ],
    });

    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "number" },
            },
            required: ["name", "value"],
          },
        },
      },
      required: ["items"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const itemsCell = cell.key("items");
    const firstItemCell = itemsCell.key(0);
    const secondItemCell = itemsCell.key(1);

    expect(firstItemCell.get()).toEqualIgnoringSymbols({
      name: "item1",
      value: 1,
    });
    expect(secondItemCell.get()).toEqualIgnoringSymbols({
      name: "item2",
      value: 2,
    });
  });

  it("should handle additionalProperties in key() navigation", () => {
    const c = runtime.getCell<{
      defined: string;
      [key: string]: any;
    }>(
      space,
      "should handle additionalProperties in key() navigation",
      undefined,
      tx,
    );
    c.set({
      defined: "known property",
      extra1: { value: 1 },
      extra2: { value: 2 },
    });

    const schema = {
      type: "object",
      properties: {
        defined: { type: "string" },
      },
      additionalProperties: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      },
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);

    // Test defined property
    const definedCell = cell.key("defined");
    expect(definedCell.get()).toBe("known property");

    // Test additional properties
    const extra1Cell = cell.key("extra1");
    const extra2Cell = cell.key("extra2");
    expect(extra1Cell.get()).toEqualIgnoringSymbols({ value: 1 });
    expect(extra2Cell.get()).toEqualIgnoringSymbols({ value: 2 });
  });

  it("should handle additionalProperties: true in key() navigation", () => {
    const c = runtime.getCell<{
      defined: string;
      [key: string]: any;
    }>(
      space,
      "should handle additionalProperties: true in key() navigation",
      undefined,
      tx,
    );
    c.set({
      defined: "known property",
      extra: { anything: "goes" },
    });

    const schema = {
      type: "object",
      properties: {
        defined: { type: "string" },
      },
      additionalProperties: {
        type: "object",
        properties: { anything: { asCell: true } },
      },
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);

    // Test defined property
    const definedCell = cell.key("defined");
    expect(definedCell.get()).toBe("known property");

    // Test additional property with a schema that generates a reference
    const extraCell = cell.key("extra");
    const extraValue = extraCell.get();
    expect(isCell(extraValue.anything)).toBe(true);
  });

  it("should partially update object values using update method", () => {
    const c = runtime.getCell<{
      name: string;
      age: number;
      tags: string[];
    }>(
      space,
      "should partially update object values using update method",
      undefined,
      tx,
    );
    c.set({ name: "test", age: 42, tags: ["a", "b"] });

    c.update({ age: 43, tags: ["a", "b", "c"] });
    expect(c.get()).toEqual({
      name: "test",
      age: 43,
      tags: ["a", "b", "c"],
    });

    // Should preserve unmodified fields
    c.update({ name: "updated" });
    expect(c.get()).toEqual({
      name: "updated",
      age: 43,
      tags: ["a", "b", "c"],
    });
  });

  it("should handle update when there is no previous value", () => {
    const c = runtime.getCell<
      { name: string; age: number } | undefined
    >(
      space,
      "should handle update when there is no previous value",
      undefined,
      tx,
    );
    c.set(undefined);

    c.update({ name: "test", age: 42 });
    expect(c.get()).toEqual({
      name: "test",
      age: 42,
    });

    // Should still work for subsequent updates
    c.update({ age: 43 });
    expect(c.get()).toEqual({
      name: "test",
      age: 43,
    });
  });

  it("should push values to array using push method", () => {
    const c = runtime.getCell<{ items: number[] }>(
      space,
      "push-test",
      undefined,
      tx,
    );
    c.set({ items: [1, 2, 3] });
    const arrayCell = c.key("items");
    expect(arrayCell.get()).toEqual([1, 2, 3]);
    arrayCell.push(4);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4]);

    arrayCell.push(5);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4, 5]);
  });

  it("should throw when pushing values to `null`", () => {
    const c = runtime.getCell<{ items: null }>(
      space,
      "push-to-null",
      undefined,
      tx,
    );
    c.set({ items: null });
    const arrayCell = c.key("items");
    expect(arrayCell.get()).toBeNull();

    expect(() => arrayCell.push(1)).toThrow();
  });

  it("should push values to undefined array with schema default", () => {
    const schema = {
      type: "array",
      default: [10, 20],
    } as const satisfies JSONSchema;

    const c = runtime.getCell<{ items?: number[] }>(
      space,
      "push-to-undefined-schema",
      undefined,
      tx,
    );
    c.set({});
    const arrayCell = c.key("items").asSchema(schema);

    arrayCell.push(30);
    expect(arrayCell.get()).toEqualIgnoringSymbols([10, 20, 30]);

    arrayCell.push(40);
    expect(arrayCell.get()).toEqualIgnoringSymbols([10, 20, 30, 40]);
  });

  it("should push values to undefined array with reused IDs", () => {
    const c = runtime.getCell<{ items?: any[] }>(
      space,
      "push-to-undefined-schema-stable-id",
      undefined,
      tx,
    );
    c.set({});
    const arrayCell = c.key("items");

    arrayCell.push({ [ID]: "test3", "value": 30 });
    expect(arrayCell.get()).toEqualIgnoringSymbols([
      { "value": 30 },
    ]);

    arrayCell.push({ [ID]: "test3", "value": 40 });
    expect(arrayCell.get()).toEqualIgnoringSymbols([
      { "value": 40 }, // happens to overwrite, because IDs are the same
      { "value": 40 },
    ]);
  });

  it("should transparently update ids when context changes", () => {
    const testCell = runtime.getCell<any>(
      space,
      "should transparently update ids when context changes",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            nested: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  value: { type: "number" },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    testCell.set(undefined);

    const initialData = [
      {
        id: "item1",
        name: "First Item",
        nested: [{ id: "nested1", value: 1 }, { id: "nested2", value: 2 }],
      },
      {
        id: "item1",
        name: "Second Item",
        nested: [{ id: "nested1", value: 3 }, { id: "nested2", value: 4 }],
      },
    ];
    const initialDataCopy = JSON.parse(JSON.stringify(initialData));
    addCommonIDfromObjectID(initialDataCopy);

    const frame1 = pushFrame({
      generatedIdCounter: 0,
      cause: "context 1",
      opaqueRefs: new Set(),
    });
    testCell.set(initialDataCopy);
    popFrame(frame1);

    expect(isAnyCellLink(testCell.getRaw()[0])).toBe(true);
    expect(isAnyCellLink(testCell.getRaw()[1])).toBe(true);
    expect(testCell.get()[0].name).toEqual("First Item");
    expect(testCell.get()[1].name).toEqual("Second Item");
    expect(testCell.key("0").key("nested").key("0").key("id").get()).toEqual(
      "nested1",
    );
    expect(testCell.get()[0].nested[0].id).toEqual("nested1");
    expect(testCell.get()[0].nested[1].id).toEqual("nested2");
    expect(testCell.get()[1].nested[0].id).toEqual("nested1");
    expect(testCell.get()[1].nested[1].id).toEqual("nested2");

    const linkFromContext1 = parseLink(testCell.getRaw()[0], testCell)!;

    const returnedData = JSON.parse(JSON.stringify(testCell.get()));
    addCommonIDfromObjectID(returnedData);

    const frame2 = pushFrame({
      generatedIdCounter: 0,
      cause: "context 2",
      opaqueRefs: new Set(),
    });
    testCell.set(returnedData);
    popFrame(frame2);

    expect(isAnyCellLink(testCell.getRaw()[0])).toBe(true);
    expect(isAnyCellLink(testCell.getRaw()[1])).toBe(true);
    expect(testCell.get()[0].name).toEqual("First Item");
    expect(testCell.get()[1].name).toEqual("Second Item");

    // Let's make sure we got a different ids with the different context
    expect(
      areNormalizedLinksSame(
        parseLink(testCell.getRaw()[0], testCell)!,
        linkFromContext1,
      ),
    ).toBe(false);

    expect(testCell.get()).toEqualIgnoringSymbols(initialData);
  });

  it("should push values that are already cells reusing the reference", () => {
    const c = runtime.getCell<{ items: { value: number }[] }>(
      space,
      "should push values that are already cells reusing the reference",
      undefined,
      tx,
    );
    c.set({ items: [] });
    const arrayCell = c.key("items");

    const d = runtime.getCell<{ value: number }>(
      space,
      "should push values that are already cells reusing the reference d",
      undefined,
      tx,
    );
    d.set({ value: 1 });
    const dCell = d;

    arrayCell.push(d);
    arrayCell.push(dCell);
    arrayCell.push(d.getAsQueryResult());

    const rawItems = c.getRaw()?.items;
    const expectedCellLink = d.getAsNormalizedFullLink();

    expect(rawItems?.map((item) => parseLink(item, c))).toEqual([
      expectedCellLink,
      expectedCellLink,
      expectedCellLink,
    ]);
  });

  it("should handle push method on non-array values", () => {
    const c = runtime.getCell<{ value: string }>(
      space,
      "should handle push method on non-array values",
      undefined,
      tx,
    );
    c.set({ value: "not an array" });
    const cell = c.key("value");

    expect(() => cell.push(42)).toThrow();
  });

  it("should create new entities when pushing to array in frame, but reuse IDs", () => {
    const c = runtime.getCell<{ items: any[] }>(
      space,
      "push-with-id",
      undefined,
      tx,
    );
    c.set({ items: [] });
    const arrayCell = c.key("items");
    const frame = pushFrame();
    arrayCell.push({ value: 42 });
    expect(frame.generatedIdCounter).toEqual(1);
    arrayCell.push({ [ID]: "test", value: 43 });
    expect(frame.generatedIdCounter).toEqual(1); // No increment = no ID generated from it
    popFrame(frame);
    expect(isAnyCellLink(c.getRaw()?.items[0])).toBe(true);
    expect(isAnyCellLink(c.getRaw()?.items[1])).toBe(true);
    expect(arrayCell.get()).toEqualIgnoringSymbols([
      { value: 42 },
      { value: 43 },
    ]);
  });
});

describe("getAsLink method", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  it("should return new sigil format", () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-test",
      undefined,
      tx,
    );
    cell.set({ value: 42 });

    // Get the new sigil format
    const link = cell.getAsLink();

    // Verify structure
    expect(link["/"]).toBeDefined();
    expect(link["/"][LINK_V1_TAG]).toBeDefined();
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].path).toBeDefined();

    // Verify id has of: prefix
    expect(link["/"][LINK_V1_TAG].id).toMatch(/^of:/);

    // Verify path is empty array
    expect(link["/"][LINK_V1_TAG].path).toEqual([]);

    // Verify space is included if present
    expect(link["/"][LINK_V1_TAG].space).toBe(space);
  });

  it("should return correct path for nested cells", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "getAsLink-nested-test",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    const link = nestedCell.getAsLink();

    expect(link["/"][LINK_V1_TAG].path).toEqual(["nested", "value"]);
  });

  it("should return different formats for getAsLink vs toJSON", () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-json-test",
      undefined,
      tx,
    );
    cell.set({ value: 42 });

    const link = cell.getAsLink();
    const json = cell.toJSON();

    // getAsLink returns new sigil format
    expect(link).toHaveProperty("/");
    expect(link["/"][LINK_V1_TAG]).toBeDefined();

    // toJSON returns old format for backward compatibility
    expect(json).toHaveProperty("cell");
    expect(json).toHaveProperty("path");
    expect((json as any).cell).toHaveProperty("/");
  });

  it("should create relative links with base parameter - same document", () => {
    const c = runtime.getCell<{ value: number; other: string }>(
      space,
      "getAsLink-base-test",
      undefined,
      tx,
    );
    c.set({ value: 42, other: "test" });
    const cell = c.key("value");

    // Link relative to base cell (same document)
    const link = cell.getAsLink({ base: c });

    // Should omit id and space since they're the same
    expect(link["/"][LINK_V1_TAG].id).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].space).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should create relative links with base parameter - different document", () => {
    const c1 = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-base-test-1",
      undefined,
      tx,
    );
    c1.set({ value: 42 });
    const c2 = runtime.getCell<{ other: string }>(
      space,
      "getAsLink-base-test-2",
      undefined,
      tx,
    );
    c2.set({ other: "test" });
    const cell = c1.key("value");

    // Link relative to base cell (different document, same space)
    const link = cell.getAsLink({ base: c2 });

    // Should include id but not space since space is the same
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].id).toMatch(/^of:/);
    expect(link["/"][LINK_V1_TAG].space).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should create relative links with base parameter - different space", () => {
    const c1 = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-base-test-1",
      undefined,
      tx,
    );
    c1.set({ value: 42 });
    const tx2 = runtime.edit(); // We're writing into a different space!
    const c2 = runtime.getCell<{ other: string }>(
      space2,
      "getAsLink-base-test-2",
      undefined,
      tx2,
    );
    c2.set({ other: "test" });
    tx2.commit();
    const cell = c1.key("value");

    // Link relative to base cell (different space)
    const link = cell.getAsLink({ base: c2 });

    // Should include both id and space since they're different
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].id).toMatch(/^of:/);
    expect(link["/"][LINK_V1_TAG].space).toBe(space);
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should include schema when includeSchema is true", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const schema = { type: "number", minimum: 0 } as const;
    const cell = c.key("value").asSchema(schema);

    // Link with schema included
    const link = cell.getAsLink({ includeSchema: true });

    expect(link["/"][LINK_V1_TAG].schema).toEqual(schema);
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should not include schema when includeSchema is false", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-no-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const schema = { type: "number", minimum: 0 } as const;
    const cell = c.key("value").asSchema(schema);

    // Link without schema
    const link = cell.getAsLink({ includeSchema: false });

    expect(link["/"][LINK_V1_TAG].schema).toBeUndefined();
  });

  it("should not include schema when includeSchema is undefined", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-default-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const cell = c.key("value");

    // Link with default options (no schema)
    const link = cell.getAsLink();

    expect(link["/"][LINK_V1_TAG].schema).toBeUndefined();
  });

  it("should handle both base and includeSchema options together", () => {
    const schema = { type: "number", minimum: 0 } as const satisfies JSONSchema;
    const c1 = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-combined-test-1",
      schema,
      tx,
    );
    c1.set({ value: 42 });
    const c2 = runtime.getCell<{ other: string }>(
      space,
      "getAsLink-combined-test-2",
      undefined,
      tx,
    );
    const cell = c1.key("value").asSchema(schema);

    // Link with both base and schema options
    const link = cell.getAsLink({ base: c2, includeSchema: true });

    // Should include id (different docs) but not space (same space)
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].space).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
    expect(link["/"][LINK_V1_TAG].schema).toEqual(schema);
  });

  it("should handle cell without schema when includeSchema is true", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-no-cell-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const cell = c.key("value"); // No schema provided

    // Link with includeSchema but cell has no schema
    const link = cell.getAsLink({ includeSchema: true });

    expect(link["/"][LINK_V1_TAG].schema).toBeUndefined();
  });
});

describe("getAsWriteRedirectLink method", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  it("should return new sigil alias format", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsWriteRedirectLink-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const cell = c;

    // Get the new sigil alias format
    const alias = cell.getAsWriteRedirectLink();

    // Verify structure
    expect(alias["/"]).toBeDefined();
    expect(alias["/"][LINK_V1_TAG]).toBeDefined();
    expect(alias["/"][LINK_V1_TAG].id).toBeDefined();
    expect(alias["/"][LINK_V1_TAG].path).toBeDefined();
    expect(alias["/"][LINK_V1_TAG].overwrite).toBe("redirect");

    // Verify id has of: prefix
    expect(alias["/"][LINK_V1_TAG].id).toMatch(/^of:/);

    // Verify path is empty array
    expect(alias["/"][LINK_V1_TAG].path).toEqual([]);

    // Verify space is included if present
    expect(alias["/"][LINK_V1_TAG].space).toBe(space);
  });

  it("should return correct path for nested cells", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "getAsWriteRedirectLink-nested-test",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    const alias = nestedCell.getAsWriteRedirectLink();

    expect(alias["/"][LINK_V1_TAG].path).toEqual(["nested", "value"]);
  });

  it("should omit space when baseSpace matches", () => {
    const cell = runtime.getCell(
      space,
      "getAsWriteRedirectLink-baseSpace-test",
      undefined,
      tx,
    );

    // Get alias with same base space
    const alias = cell.getAsWriteRedirectLink({ baseSpace: space });

    // Should omit space
    expect(alias["/"][LINK_V1_TAG].space).toBeUndefined();
  });
});

describe("getImmutableCell", () => {
  describe("asCell", () => {
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

    it("should create a cell with the correct schema", () => {
      const schema = {
        type: "object",
        properties: { value: { type: "number" } },
      } as const satisfies JSONSchema;
      const cell = runtime.getImmutableCell(space, { value: 42 }, schema, tx);
      expect(cell.get()).toEqualIgnoringSymbols({ value: 42 });
    });
  });
});

describe("toCell and toOpaqueRef hooks", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  describe("Basic hook functionality", () => {
    it("should add toCell and toOpaqueRef symbols to objects returned from Cell.get()", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-basic-object",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);
      expect(typeof (result as any)[toCell]).toBe("function");
      expect(typeof (result as any)[toOpaqueRef]).toBe("function");
    });

    it("should add hooks to arrays returned from Cell.get()", () => {
      const schema = {
        type: "array",
        items: { type: "number" },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<number[]>(
        space,
        "hook-basic-array",
        schema,
        tx,
      );
      c.set([1, 2, 3]);

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);
    });

    it("should not add hooks to primitive values", () => {
      const numberCell = runtime.getCell<number>(
        space,
        "hook-basic-number",
        undefined,
        tx,
      );
      numberCell.set(42);
      const numberResult = numberCell.get();
      expect(toCell in Object(numberResult)).toBe(false);
      expect(toOpaqueRef in Object(numberResult)).toBe(false);

      const stringCell = runtime.getCell<string>(
        space,
        "hook-basic-string",
        undefined,
        tx,
      );
      stringCell.set("hello");
      const stringResult = stringCell.get();
      expect(toCell in Object(stringResult)).toBe(false);
      expect(toOpaqueRef in Object(stringResult)).toBe(false);

      const boolCell = runtime.getCell<boolean>(
        space,
        "hook-basic-bool",
        undefined,
        tx,
      );
      boolCell.set(true);
      const boolResult = boolCell.get();
      expect(toCell in Object(boolResult)).toBe(false);
      expect(toOpaqueRef in Object(boolResult)).toBe(false);
    });

    it("should not add hooks to existing cells", () => {
      const innerCell = runtime.getCell<{ inner: number }>(
        space,
        "hook-basic-inner-cell",
        undefined,
        tx,
      );
      innerCell.set({ inner: 42 });

      const schema = {
        type: "object",
        properties: {
          cell: {},
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ cell: any }>(
        space,
        "hook-basic-outer-cell",
        schema,
        tx,
      );
      c.set({ cell: innerCell });

      const result = c.get();
      // The outer object gets hooks
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);

      // When a cell is stored in another cell, it's dereferenced to its value
      // The value itself doesn't have hooks (no schema on inner cell)
      expect(isCell(result.cell)).toBe(false);
      expect(result.cell).toEqual({ inner: 42 });
      expect(toCell in result.cell).toBe(false);
      expect(toOpaqueRef in result.cell).toBe(false);
    });

    it("should not add hooks to query result proxies", () => {
      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-basic-query-result",
        undefined,
        tx,
      );
      c.set({ value: 42 });

      const proxy = c.getAsQueryResult();
      expect(isQueryResult(proxy)).toBe(true);
      // Query results don't have the hooks because they're proxies, not plain objects
      expect(toCell in proxy).toBe(false);
      expect(toOpaqueRef in proxy).toBe(false);
    });
  });

  describe("toCell behavior", () => {
    it("should return a cell pointing to the original data", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-getcelllink-basic",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();
      const linkedCell = (result as any)[toCell]();

      expect(isCell(linkedCell)).toBe(true);
      // The linked cell returns the same result with hooks
      const linkedResult = linkedCell.get();
      // Compare just the value property, not the whole object with symbols
      expect(linkedResult.value).toBe(42);
      expect(linkedCell.equals(c)).toBe(true);
    });

    it("should return cells for nested paths", () => {
      const schema = {
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: {
                type: "object",
                properties: {
                  c: { type: "number" },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ a: { b: { c: number } } }>(
        space,
        "hook-getcelllink-nested",
        schema,
        tx,
      );
      c.set({ a: { b: { c: 42 } } });

      const nestedValue = c.key("a").key("b").get();
      const linkedCell = (nestedValue as any)[toCell]();

      expect(isCell(linkedCell)).toBe(true);
      const linkedResult = linkedCell.get();
      expect(linkedResult.c).toBe(42);
      expect(linkedCell.equals(c.key("a").key("b"))).toBe(true);
    });

    it("should allow mutations through the returned cell", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-getcelllink-mutation",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();
      const linkedCell = (result as any)[toCell]();

      linkedCell.set({ value: 100 });
      const updatedResult = c.get();
      expect(updatedResult.value).toBe(100);
    });

    it("should work with array elements", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ items: { name: string }[] }>(
        space,
        "hook-getcelllink-array",
        schema,
        tx,
      );
      c.set({ items: [{ name: "first" }, { name: "second" }] });

      const itemValue = c.key("items").key(0).get();
      const linkedCell = (itemValue as any)[toCell]();

      expect(isCell(linkedCell)).toBe(true);
      const linkedResult = linkedCell.get();
      expect(linkedResult.name).toBe("first");

      linkedCell.set({ name: "updated" });
      const updatedItems = c.get().items;
      expect(updatedItems[0].name).toBe("updated");
    });
  });

  describe("toOpaqueRef behavior", () => {
    it("should return an OpaqueRef within a recipe context", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-toopaqueref-basic",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();

      // Need to be in a frame context for toOpaqueRef to work
      const frame = pushFrame();
      const opaqueRef = (result as any)[toOpaqueRef]();
      popFrame(frame);

      expect(opaqueRef).toBeDefined();
      expect(typeof opaqueRef).toBe("object");
      // OpaqueRef should have these methods
      expect(typeof opaqueRef.get).toBe("function");
      expect(typeof opaqueRef.set).toBe("function");
      expect(typeof opaqueRef.key).toBe("function");
    });

    it("should create OpaqueRefs that point to the correct location", () => {
      const schema = {
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: { type: "number" },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ a: { b: number } }>(
        space,
        "hook-toopaqueref-nested",
        schema,
        tx,
      );
      c.set({ a: { b: 42 } });

      const nestedValue = c.key("a").get();

      const frame = pushFrame();
      const opaqueRef = (nestedValue as any)[toOpaqueRef]();
      popFrame(frame);

      // The OpaqueRef should represent the nested path
      expect(opaqueRef).toBeDefined();
    });
  });

  describe("Recipe integration", () => {
    it("should pass query results for recipes without argumentSchema", () => {
      const inputCell = runtime.getCell<{ value: number }>(
        space,
        "hook-recipe-no-schema",
        undefined,
        tx,
      );
      inputCell.set({ value: 42 });

      // Simulate what runner.ts does when no argumentSchema
      const argument = inputCell.getAsQueryResult([], tx);

      // Should be a proxy, not have hooks
      expect(isQueryResult(argument)).toBe(true);
      expect(toCell in argument).toBe(false);
      expect(toOpaqueRef in argument).toBe(false);
      expect(argument.value).toBe(42);
    });

    it("should pass objects with hooks for recipes with argumentSchema", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const inputCell = runtime.getCell<{ value: number }>(
        space,
        "hook-recipe-with-schema",
        schema,
        tx,
      );
      inputCell.set({ value: 42 });

      // Simulate what runner.ts does with argumentSchema
      const argument = inputCell.asSchema(schema).get();

      // Should have hooks
      expect(toCell in argument).toBe(true);
      expect(toOpaqueRef in argument).toBe(true);
      expect(argument.value).toBe(42);
    });

    it("should allow recipe code to convert back to cells", () => {
      const schema = {
        type: "object",
        properties: {
          data: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const inputCell = runtime.getCell<{ data: string }>(
        space,
        "hook-recipe-convert",
        schema,
        tx,
      );
      inputCell.set({ data: "test" });

      const argument = inputCell.asSchema(schema).get();

      // Recipe code can use toCell to get back to the cell
      const cellFromHook = (argument as any)[toCell]();
      expect(isCell(cellFromHook)).toBe(true);
      const cellResult = cellFromHook.get();
      expect(cellResult.data).toBe("test");

      // Can mutate through the cell
      cellFromHook.set({ data: "updated" });
      const updatedResult = inputCell.get();
      expect(updatedResult.data).toBe("updated");
    });

    it("should allow converting to OpaqueRef in recipe context", () => {
      const schema = {
        type: "object",
        properties: {
          num: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const inputCell = runtime.getCell<{ num: number }>(
        space,
        "hook-recipe-opaque",
        schema,
        tx,
      );
      inputCell.set({ num: 100 });

      const argument = inputCell.asSchema(schema).get();

      // In recipe context, can convert to OpaqueRef
      const frame = pushFrame();
      const opaqueRef = (argument as any)[toOpaqueRef]();
      popFrame(frame);

      expect(opaqueRef).toBeDefined();
      expect(typeof opaqueRef.key).toBe("function");
    });
  });

  describe("Schema interactions", () => {
    it("should add hooks to schema-validated results", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ name: string; age: number }>(
        space,
        "hook-schema-basic",
        schema,
        tx,
      );
      c.set({ name: "John", age: 30 });

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);
    });

    it("should add hooks to default values from schema", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number", default: 100 },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value?: number }>(
        space,
        "hook-schema-default",
        schema,
        tx,
      );
      c.set({});

      const result = c.get();
      expect(result.value).toBe(100);
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);
    });

    it("should not double-wrap asCell properties", () => {
      const schema = {
        type: "object",
        properties: {
          regular: { type: "string" },
          cellProp: {
            type: "object",
            properties: { value: { type: "number" } },
            asCell: true,
          },
        },
        required: ["regular", "cellProp"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell<
        { regular: string; cellProp: { value: number } }
      >(
        space,
        "hook-schema-ascell",
        schema,
        tx,
      );
      c.set({ regular: "test", cellProp: { value: 42 } });

      const result = c.asSchema(schema).get();
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);

      // cellProp should be a cell, not have hooks
      expect(isCell(result.cellProp)).toBe(true);
      // Cells themselves have toOpaqueRef (part of Cell interface) but not toCell
      expect(toCell in result.cellProp).toBe(false);
      expect(toOpaqueRef in result.cellProp).toBe(true);
    });

    it("should add hooks to additionalProperties results", () => {
      const schema = {
        type: "object",
        properties: {
          known: { type: "string" },
        },
        additionalProperties: { type: "number" },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ known: string; [key: string]: any }>(
        space,
        "hook-schema-additional",
        schema,
        tx,
      );
      c.set({ known: "test", extra1: 10, extra2: 20 });

      const result = c.asSchema(schema).get();
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);
      expect(result.extra1).toBe(10);
      expect(result.extra2).toBe(20);
    });

    it("should add hooks to array items", () => {
      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "number" } },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }[]>(
        space,
        "hook-schema-array",
        schema,
        tx,
      );
      c.set([{ value: 1 }, { value: 2 }]);

      const result = c.asSchema(schema).get();
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);

      // Each item should also have hooks
      expect(toCell in result[0]).toBe(true);
      expect(toOpaqueRef in result[0]).toBe(true);
      expect(toCell in result[1]).toBe(true);
      expect(toOpaqueRef in result[1]).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("should handle null and undefined values", () => {
      const schema = {
        type: "object",
        properties: {
          nullable: { type: ["string", "null"] },
          optional: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ nullable: string | null; optional?: string }>(
        space,
        "hook-edge-null",
        schema,
        tx,
      );
      c.set({ nullable: null });

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);
      expect(result.nullable).toBe(null);
      expect(result.optional).toBeUndefined();
    });

    it("should handle empty objects and arrays", () => {
      const schema = {
        type: "object",
        properties: {
          emptyObj: { type: "object" },
          emptyArr: { type: "array" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<
        { emptyObj: Record<string, never>; emptyArr: any[] }
      >(
        space,
        "hook-edge-empty",
        schema,
        tx,
      );
      c.set({ emptyObj: {}, emptyArr: [] });

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);

      // Empty objects and arrays should also have hooks
      expect(toCell in result.emptyObj).toBe(true);
      expect(toOpaqueRef in result.emptyObj).toBe(true);
      expect(toCell in result.emptyArr).toBe(true);
      expect(toOpaqueRef in result.emptyArr).toBe(true);
    });

    it("should handle deeply nested structures", () => {
      const schema = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: {
                    type: "object",
                    properties: {
                      value: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "hook-edge-deep",
        schema,
        tx,
      );
      c.set({
        level1: {
          level2: {
            level3: {
              value: 42,
            },
          },
        },
      });

      const result = c.get();

      // Each level should have hooks
      expect(toCell in result).toBe(true);
      expect(toCell in result.level1).toBe(true);
      expect(toCell in result.level1.level2).toBe(true);
      expect(toCell in result.level1.level2.level3).toBe(true);

      // Can navigate to deep cells
      const deepCell = (result.level1.level2.level3 as any)[toCell]();
      expect(isCell(deepCell)).toBe(true);
      expect(deepCell.get().value).toBe(42);
    });

    it("should handle circular references gracefully", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          self: { $ref: "#" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "hook-edge-circular",
        schema,
        tx,
      );

      const data: any = { name: "circular" };
      data.self = data;
      c.set(data);

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(toOpaqueRef in result).toBe(true);
      expect(result.name).toBe("circular");
      // With circular references, the self reference points back to the same data
      expect(result.self.name).toBe("circular");
      expect(result.self.self.name).toBe("circular"); // Can navigate infinitely
    });
  });
});

describe("Cell success callbacks", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  it("should call onCommit callback after Cell.set() commits successfully", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-set-test",
      undefined,
      tx,
    );

    let callbackCalled = false;
    let callbackTx: IExtendedStorageTransaction | undefined;

    cell.set(42, (committedTx) => {
      callbackCalled = true;
      callbackTx = committedTx;
    });

    expect(callbackCalled).toBe(false);
    await tx.commit();
    expect(callbackCalled).toBe(true);
    expect(callbackTx).toBe(tx);
    expect(cell.get()).toBe(42);
  });

  it("should call onCommit callback after Cell.send() commits successfully", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-send-test",
      undefined,
      tx,
    );
    cell.set(10);

    let callbackCalled = false;
    let callbackTx: IExtendedStorageTransaction | undefined;

    cell.send(20, (committedTx) => {
      callbackCalled = true;
      callbackTx = committedTx;
    });

    expect(callbackCalled).toBe(false);
    await tx.commit();
    expect(callbackCalled).toBe(true);
    expect(callbackTx).toBe(tx);
    expect(cell.get()).toBe(20);
  });

  it("should handle multiple callbacks on same transaction", async () => {
    const cell1 = runtime.getCell<number>(
      space,
      "callback-multiple-1",
      undefined,
      tx,
    );
    const cell2 = runtime.getCell<number>(
      space,
      "callback-multiple-2",
      undefined,
      tx,
    );

    let callback1Called = false;
    let callback2Called = false;
    const callOrder: number[] = [];

    cell1.set(1, () => {
      callback1Called = true;
      callOrder.push(1);
    });

    cell2.set(2, () => {
      callback2Called = true;
      callOrder.push(2);
    });

    expect(callback1Called).toBe(false);
    expect(callback2Called).toBe(false);

    await tx.commit();

    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
    expect(callOrder).toEqual([1, 2]);
  });

  it("should not call callback if transaction fails", () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-fail-test",
      undefined,
      tx,
    );

    let callbackCalled = false;

    cell.set(42, () => {
      callbackCalled = true;
    });

    // Abort the transaction instead of committing
    tx.abort("test abort");

    expect(callbackCalled).toBe(false);
  });

  it("should handle errors in callback gracefully", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-error-test",
      undefined,
      tx,
    );

    let callback1Called = false;
    let callback2Called = false;

    cell.set(1, () => {
      callback1Called = true;
      throw new Error("Callback error");
    });

    cell.set(2, () => {
      callback2Called = true;
    });

    await tx.commit();

    // First callback threw but second should still be called
    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
  });

  it("should allow cell operations without callback", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-optional-test",
      undefined,
      tx,
    );

    // Should work fine without callback (backward compatible)
    cell.set(42);
    await tx.commit();
    expect(cell.get()).toBe(42);
  });

  it("should call onCommit callback even when transaction commit fails", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-commit-fail-test",
      undefined,
      tx,
    );

    let callbackCalled = false;
    let receivedTx: IExtendedStorageTransaction | undefined;

    cell.set(42, (committedTx) => {
      callbackCalled = true;
      receivedTx = committedTx;
    });

    // Cause the transaction to fail by aborting it, then commit
    tx.abort("intentional abort for test");
    await tx.commit();

    // Even though aborted, callback should still be called after commit
    expect(callbackCalled).toBe(true);
    expect(receivedTx).toBe(tx);

    // Verify the transaction actually failed
    const status = tx.status();
    expect(status.status).toBe("error");
  });

  describe("set operations with arrays", () => {
    it("should add IDs to objects when setting an array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string; value: number }[]>(
        space,
        "array-set-test",
        { type: "array" },
        tx,
      );

      const objects = [
        { name: "first", value: 1 },
        { name: "second", value: 2 },
      ];

      cell.set(objects);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "number" } },
          asCell: true,
        },
      }).get();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      expect(link0.id).not.toBe(link1.id);
      expect(link0.path).toEqual([]);
      expect(link1.path).toEqual([]);
      expect(result[0].get().name).toBe("first");
      expect(result[1].get().name).toBe("second");
    });

    it("should preserve existing IDs when setting an array", () => {
      const initialDataCell = runtime.getCell<{ name: string; value: number }>(
        space,
        "array-set-preserve-id-test-initial",
        {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "number" } },
        },
        tx,
      );
      initialDataCell.set({ name: "first", value: 1 });

      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string; value: number }[]>(
        space,
        "array-set-preserve-id-test",
        { type: "array" },
        tx,
      );

      const objects = [
        initialDataCell,
        { name: "second", value: 2 },
      ];

      cell.set(objects);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "number" } },
          asCell: true,
        },
      }).get();
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      expect(link0.id).toBe(initialDataCell.getAsNormalizedFullLink().id);
      expect(link0.id).not.toBe(link1.id);
    });
  });

  describe("push operations with default values", () => {
    it("should use default values from schema when pushing to empty array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string; count: number }[]>(
        space,
        "push-with-defaults-test",
        {
          type: "array",
          default: [{ name: "default", count: 0 }],
        },
        tx,
      );

      cell.push({ name: "new", count: 5 });
      popFrame(frame);

      const result = cell.get();
      expect(result.length).toBe(2);
      expect(result[0].name).toBe("default");
      expect(result[0].count).toBe(0);
      expect(result[1].name).toBe("new");
      expect(result[1].count).toBe(5);
    });

    it("should add IDs to default values from schema", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string }[]>(
        space,
        "push-defaults-with-id-test",
        {
          type: "array",
          default: [{ name: "default1" }, { name: "default2" }],
        },
        tx,
      );

      cell.push({ name: "new" });
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" } },
          asCell: true,
        },
      }).get();
      expect(result.length).toBe(3);
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      expect(isCell(result[2])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      const link2 = result[2].getAsNormalizedFullLink();
      expect(link0.id).not.toBe(link1.id);
      expect(link1.id).not.toBe(link2.id);
      expect(link0.id).not.toBe(link2.id);
    });

    it("should push objects with IDs even without schema defaults", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ value: number }[]>(
        space,
        "push-no-defaults-test",
        { type: "array" },
        tx,
      );

      cell.push({ value: 1 }, { value: 2 });
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "number" } },
          asCell: true,
        },
      }).get();
      expect(result.length).toBe(2);
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      expect(link0.id).not.toBe(link1.id);
    });
  });
});
