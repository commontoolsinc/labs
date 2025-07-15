import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { isQueryResult } from "../src/query-result-proxy.ts";
import { ID, JSONSchema } from "../src/builder/types.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { addCommonIDfromObjectID } from "../src/data-updating.ts";
import { isLegacyCellLink } from "../src/link-utils.ts";
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
      blobbyServerUrl: import.meta.url,
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

  it("should call updates callback when value changes", () => {
    const cell = runtime.getCell<number>(
      space,
      "should call updates callback when value changes",
      undefined,
      tx,
    );
    cell.set(0);
    const values: number[] = [];
    const unsink = cell.getDoc().updates((value) => values.push(value));
    cell.send(1);
    cell.send(2);
    cell.send(3);
    unsink();
    cell.send(4);
    expect(values).toEqual([1, 2, 3]);
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
    const result = cell.setRaw({ x: 10, y: 20 });
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

    const result = cell.setRaw(100);
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

    const result = cell.setRaw([4, 5, 6]);
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
});

describe("Cell utility functions", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
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
    const ref = c.key("x").getAsLegacyCellLink();
    expect(isLegacyCellLink(ref)).toBe(true);
    expect(isLegacyCellLink({})).toBe(false);
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
      blobbyServerUrl: import.meta.url,
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
    const ref = c.key("x").getAsLegacyCellLink();
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
    const ref = c.key("x").getAsLegacyCellLink();
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
    expect(areLinksSame(log.writes[0], c.key("length").getAsLegacyCellLink()))
      .toBe(true);
    expect(areLinksSame(log.writes[1], c.key(2).getAsLegacyCellLink())).toBe(
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

describe("asCell", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
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

  it("should return a Sendable for stream aliases", async () => {
    const c = runtime.getCell<{ stream: { $stream: true } }>(
      space,
      "should return a Sendable for stream aliases",
      undefined,
      tx,
    );
    c.setRaw({ stream: { $stream: true } });
    const streamCell = c.key("stream");

    expect(streamCell).toHaveProperty("send");
    expect(streamCell).not.toHaveProperty("get");
    expect(streamCell).not.toHaveProperty("set");
    expect(streamCell).not.toHaveProperty("key");

    let lastEventSeen: any = null;
    let eventCount = 0;

    runtime.scheduler.addEventHandler(
      (event: any) => {
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

  it("should call sink only when the cell changes on the subpath", async () => {
    const c = runtime.getCell<{ a: { b: number; c: number }; d: number }>(
      space,
      "should call sink only when the cell changes on the subpath",
      undefined,
      tx,
    );
    c.set({ a: { b: 42, c: 10 }, d: 5 });
    const values: number[] = [];
    c.key("a").key("b").sink((value) => {
      values.push(value);
    });
    expect(values).toEqual([42]); // Initial call
    c.getAsQueryResult().d = 50;
    await runtime.idle();
    c.getAsQueryResult().a.c = 100;
    await runtime.idle();
    c.getAsQueryResult().a.b = 42;
    await runtime.idle();
    expect(values).toEqual([42]); // Didn't get called again
    c.getAsQueryResult().a.b = 300;
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
    expect(c.get().get()).toEqual({ a: 1 });
  });
});

describe("asCell with schema", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
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
    const value = cell.get();

    expect(value.name).toBe("test");
    expect(value.age).toBe(42);
    expect(value.tags).toEqual(["a", "b"]);
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
    const cellRef = innerCell.getAsLegacyCellLink();
    const aliasRef = { $alias: innerCell.getAsLegacyCellLink() };

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

    expect(firstItemCell.get()).toEqual({ name: "item1", value: 1 });
    expect(secondItemCell.get()).toEqual({ name: "item2", value: 2 });
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
    expect(extra1Cell.get()).toEqual({ value: 1 });
    expect(extra2Cell.get()).toEqual({ value: 2 });
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
    expect(arrayCell.get()).toEqual([10, 20, 30]);

    arrayCell.push(40);
    expect(arrayCell.get()).toEqual([10, 20, 30, 40]);
  });

  it("should push values to undefined array with schema default has stable IDs", () => {
    const schema = {
      type: "array",
      items: { type: "object", properties: { value: { type: "number" } } },
      default: [{ [ID]: "test", value: 10 }, { [ID]: "test2", value: 20 }],
    } as const satisfies JSONSchema;

    const c = runtime.getCell<{ items?: any[] }>(
      space,
      "push-to-undefined-schema-stable-id",
      undefined,
      tx,
    );
    c.set({});
    const arrayCell = c.key("items").asSchema(schema);

    arrayCell.push({ [ID]: "test3", "value": 30 });
    expect(arrayCell.get()).toEqual([
      { "value": 10 },
      { "value": 20 },
      { "value": 30 },
    ]);

    arrayCell.push({ [ID]: "test", "value": 40 });
    expect(arrayCell.get()).toEqual([
      { "value": 40 }, // happens to overwrite, because IDs are the same
      { "value": 20 },
      { "value": 30 },
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

    const returnedData = testCell.get();
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

    expect(testCell.get()).toEqual(initialData);
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

    const rawItems = c.getRaw().items;
    const expectedCellLink = d.getAsNormalizedFullLink();

    expect(rawItems.map((item: any) => parseLink(item, c))).toEqual([
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
    expect(isAnyCellLink(c.getRaw().items[0])).toBe(true);
    expect(isAnyCellLink(c.getRaw().items[1])).toBe(true);
    expect(arrayCell.get()).toEqual([{ value: 42 }, { value: 43 }]);
  });
});

describe("getAsLink method", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
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
      blobbyServerUrl: import.meta.url,
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
    const c = runtime.documentMap.getDoc(
      { value: 42 },
      "getAsWriteRedirectLink-baseSpace-test",
      space,
    );
    const cell = c.asCell();

    // Get alias with same base space
    const alias = cell.getAsWriteRedirectLink({ baseSpace: space });

    // Should omit space
    expect(alias["/"][LINK_V1_TAG].space).toBeUndefined();
  });
});
