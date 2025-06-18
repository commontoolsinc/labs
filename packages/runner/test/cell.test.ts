import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type DocImpl, isDoc } from "../src/doc.ts";
import { isCell, isCellLink } from "../src/cell.ts";
import { isQueryResult } from "../src/query-result-proxy.ts";
import { type ReactivityLog } from "../src/scheduler.ts";
import { ID, JSONSchema } from "../src/builder/types.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";
import { Runtime } from "../src/runtime.ts";
import { addCommonIDfromObjectID } from "../src/data-updating.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Cell", () => {
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

  it("should create a cell with initial value", () => {
    const c = runtime.getCell<number>(
      space,
      "should create a cell with initial value",
    );
    c.set(10);
    expect(c.get()).toBe(10);
  });

  it("should update cell value using send", () => {
    const c = runtime.getCell<number>(
      space,
      "should update cell value using send",
    );
    c.set(10);
    c.send(20);
    expect(c.get()).toBe(20);
  });

  it("should create a proxy for the cell", () => {
    const c = runtime.getCell<{ x: number; y: number }>(
      space,
      "should create a proxy for the cell",
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
    );
    c.set({ a: { b: { c: 42 } } });
    expect(c.getAsQueryResult(["a", "b", "c"])).toBe(42);
  });

  it("should set value at path", () => {
    const c = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should set value at path",
    );
    c.set({ a: { b: { c: 42 } } });
    c.getAsQueryResult().a.b.c = 100;
    expect(c.getAsQueryResult(["a", "b", "c"])).toBe(100);
  });

  it("should call updates callback when value changes", () => {
    const cell = runtime.getCell<number>(
      space,
      "should call updates callback when value changes",
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
    );
    cell.set({ x: 1, y: 2 });
    expect(cell.getRaw()).toEqual({ x: 1, y: 2 });
  });

  it("should set raw value using setRaw", () => {
    const cell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should set raw value using setRaw",
    );
    cell.set({ x: 1, y: 2 });
    const result = cell.setRaw({ x: 10, y: 20 });
    expect(result).toBe(true); // setRaw returns boolean from doc.send()
    expect(cell.getRaw()).toEqual({ x: 10, y: 20 });
  });

  it("should work with primitive values in getRaw/setRaw", () => {
    const cell = runtime.getCell<number>(
      space,
      "should work with primitive values in getRaw/setRaw",
    );
    cell.set(42);

    expect(cell.getRaw()).toBe(42);

    const result = cell.setRaw(100);
    expect(result).toBe(true);
    expect(cell.getRaw()).toBe(100);
  });

  it("should work with arrays in getRaw/setRaw", () => {
    const cell = runtime.getCell<number[]>(
      space,
      "should work with arrays in getRaw/setRaw",
    );
    cell.set([1, 2, 3]);

    expect(cell.getRaw()).toEqual([1, 2, 3]);

    const result = cell.setRaw([4, 5, 6]);
    expect(result).toBe(true);
    expect(cell.getRaw()).toEqual([4, 5, 6]);
  });

  it("should respect path in getRaw/setRaw for nested properties", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "should respect path in getRaw/setRaw for nested properties",
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

  it("should identify a cell", () => {
    const c = runtime.getCell(
      space,
      "should identify a cell",
    );
    c.set(10);
    expect(isCell(c)).toBe(true);
    expect(isCell({})).toBe(false);
  });

  it("should identify a cell reference", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should identify a cell reference",
    );
    c.set({ x: 10 });
    const ref = c.key("x").getAsCellLink();
    expect(isCellLink(ref)).toBe(true);
    expect(isCellLink({})).toBe(false);
  });

  it("should identify a cell proxy", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should identify a cell proxy",
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

  it("should create a proxy for nested objects", () => {
    const c = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should create a proxy for nested objects",
    );
    c.set({ a: { b: { c: 42 } } });
    const proxy = c.getAsQueryResult();
    expect(proxy.a.b.c).toBe(42);
  });

  it("should support regular assigments", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should support regular assigments",
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
    );
    c.setRaw({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle aliases when writing", () => {
    const c = runtime.getCell(
      space,
      "should handle aliases when writing",
    );
    c.setRaw({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    proxy.x = 100;
    expect((c.get() as any).y).toBe(100);
  });

  it("should handle nested cells", () => {
    const innerCell = runtime.getCell<number>(
      space,
      "should handle nested cells inner",
    );
    innerCell.set(42);
    const outerCell = runtime.getCell<{ x: any }>(
      space,
      "should handle nested cells outer",
    );
    outerCell.set({ x: innerCell });
    const proxy = outerCell.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle cell references", () => {
    const c = runtime.getCell<{ x: number; y?: any }>(
      space,
      "should handle cell references",
    );
    c.set({ x: 42 });
    const ref = c.key("x").getAsCellLink();
    const proxy = c.getAsQueryResult();
    proxy.y = ref;
    expect(proxy.y).toBe(42);
  });

  it("should handle infinite loops in cell references", () => {
    const c = runtime.getCell<{ x: number; y?: any }>(
      space,
      "should handle infinite loops in cell references",
    );
    c.set({ x: 42 });
    const ref = c.key("x").getAsCellLink();
    const proxy = c.getAsQueryResult();
    proxy.x = ref;
    expect(() => proxy.x).toThrow();
  });

  it("should support modifying array methods and log reads and writes", () => {
    const log: ReactivityLog = { reads: [], writes: [] };
    const c = runtime.getCell<{ array: number[] }>(
      space,
      "should support modifying array methods and log reads and writes",
    );
    c.set({ array: [1, 2, 3] });
    const proxy = c.getAsQueryResult([], log);
    expect(log.reads.length).toBe(1);
    expect(proxy.array.length).toBe(3);
    // only read array, but not the elements
    expect(log.reads.length).toBe(3);

    proxy.array.push(4);
    expect(proxy.array.length).toBe(4);
    expect(proxy.array[3]).toBe(4);
    expect(
      log.writes.some((write) =>
        write.path[0] === "array" && write.path[1] === "3"
      ),
    ).toBe(true);
  });

  it("should handle array methods on previously undefined arrays", () => {
    const log: ReactivityLog = { reads: [], writes: [] };
    const c = runtime.getCell<{ data: any }>(
      space,
      "should handle array methods on previously undefined arrays",
    );
    c.set({ data: {} });
    const proxy = c.getAsQueryResult([], log);

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

  it("should support pop() and only read the popped element", () => {
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should support pop() and only read the popped element",
    );
    c.set({ a: [] as number[] });
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.a = [1, 2, 3];
    const result = proxy.a.pop();
    const pathsRead = log.reads.map((r) => r.path.join("."));
    expect(pathsRead).toContain("a.2");
    expect(pathsRead).not.toContain("a.0");
    expect(pathsRead).not.toContain("a.1");
    expect(result).toEqual(3);
    expect(proxy.a).toEqual([1, 2]);
  });

  it("should correctly sort() with cell references", () => {
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should correctly sort() with cell references",
    );
    c.set({ a: [] as number[] });
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.a = [3, 1, 2];
    const result = proxy.a.sort();
    expect(result).toEqual([1, 2, 3]);
    expect(proxy.a).toEqual([1, 2, 3]);
  });

  it("should support readonly array methods and log reads", () => {
    const c = runtime.getCell<number[]>(
      space,
      "should support readonly array methods and log reads",
    );
    c.set([1, 2, 3]);
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    const result = proxy.find((x: any) => x === 2);
    expect(result).toBe(2);
    expect(c.get()).toEqual([1, 2, 3]);
    expect(log.reads.map((r) => r.path)).toEqual([[], [0], [1], [2]]);
    expect(log.writes).toEqual([]);
  });

  it("should support mapping over a proxied array", () => {
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should support mapping over a proxied array",
    );
    c.set({ a: [1, 2, 3] });
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    const result = proxy.a.map((x: any) => x + 1);
    expect(result).toEqual([2, 3, 4]);
    expect(log.reads.map((r) => r.path)).toEqual([
      [],
      ["a"],
      ["a", 0],
      ["a", 1],
      ["a", 2],
    ]);
  });

  it("should allow changing array lengths by writing length", () => {
    const c = runtime.getCell<number[]>(
      space,
      "should allow changing array lengths by writing length",
    );
    c.set([1, 2, 3]);
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.length = 2;
    expect(c.get()).toEqual([1, 2]);
    expect(log.writes.length).toBe(2);
    expect(log.writes[0].cell).toBe(c.getDoc());
    expect(log.writes[0].path).toEqual(["length"]);
    expect(log.writes[1].cell).toBe(c.getDoc());
    expect(log.writes[1].path).toEqual([2]);
    proxy.length = 4;
    expect(c.get()).toEqual([1, 2, undefined, undefined]);
    expect(log.writes.length).toBe(5);
    expect(log.writes[2].cell).toBe(c.getDoc());
    expect(log.writes[2].path).toEqual(["length"]);
    expect(log.writes[3].cell).toBe(c.getDoc());
    expect(log.writes[3].path).toEqual([2]);
    expect(log.writes[4].cell).toBe(c.getDoc());
    expect(log.writes[4].path).toEqual([3]);
  });

  it("should allow changing array by splicing", () => {
    const c = runtime.getCell<number[]>(
      space,
      "should allow changing array by splicing",
    );
    c.set([1, 2, 3]);
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.splice(1, 1, 4, 5);
    expect(c.get()).toEqual([1, 4, 5, 3]);
    expect(log.writes.length).toBe(3);
    expect(log.writes[0].cell).toBe(c.getDoc());
    expect(log.writes[0].path).toEqual(["1"]);
    expect(log.writes[1].cell).toBe(c.getDoc());
    expect(log.writes[1].path).toEqual(["2"]);
    expect(log.writes[2].cell).toBe(c.getDoc());
    expect(log.writes[2].path).toEqual(["3"]);
  });
});

describe("asCell", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

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

  it("should create a simple cell interface", () => {
    const simpleCell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should create a simple cell interface",
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
    );
    c.setRaw({ stream: { $stream: true } });
    const streamCell = c.key("stream");

    expect(streamCell).toHaveProperty("send");
    expect(streamCell).not.toHaveProperty("get");
    expect(streamCell).not.toHaveProperty("set");
    expect(streamCell).not.toHaveProperty("key");

    let lastEventSeen = "";
    let eventCount = 0;

    runtime.scheduler.addEventHandler(
      (event: any) => {
        eventCount++;
        lastEventSeen = event;
      },
      { cell: c.getDoc(), path: ["stream"] },
    );

    (streamCell as any).send("event");
    await runtime.idle();

    expect(c.get()).toStrictEqual({ stream: { $stream: true } });
    expect(eventCount).toBe(1);
    expect(lastEventSeen).toBe("event");
  });

  it("should call sink only when the cell changes on the subpath", async () => {
    const c = runtime.getCell<{ a: { b: number, c: number }, d: number }>(
      space,
      "should call sink only when the cell changes on the subpath",
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
});

describe("asCell with schema", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

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

  it("should validate and transform according to schema", () => {
    const c = runtime.getCell<{
      name: string;
      age: number;
      tags: string[];
      nested: { value: number };
    }>(
      space,
      "should validate and transform according to schema",
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
    );
    innerCell.set({ value: 42 });
    const cellRef = innerCell.getAsCellLink();
    const aliasRef = { $alias: innerCell.getAsCellLink() };

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

  it("should handle nested references", () => {
    // Create a chain of references
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle nested references: inner",
    );
    innerCell.set({ value: 42 });
    
    const ref1 = innerCell.getAsCellLink();
    
    const ref2Cell = runtime.getCell<{ ref: any }>(
      space,
      "should handle nested references: ref2",
    );
    ref2Cell.set({ ref: ref1 });
    const ref2 = ref2Cell.key("ref").getAsCellLink();
    
    const ref3Cell = runtime.getCell<{ ref: any }>(
      space,
      "should handle nested references: ref3",
    );
    ref3Cell.setRaw({ ref: ref2 });
    const ref3 = ref3Cell.key("ref").getAsCellLink();

    // Create a cell that uses the nested reference
    const c = runtime.getCell<{
      context: {
        nested: any;
      };
    }>(
      space,
      "should handle nested references main",
    );
    c.set({
      context: {
        nested: ref3,
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

    const log = { reads: [], writes: [] } as ReactivityLog;
    const cell = c.asSchema(schema).withLog(log);
    const value = cell.get() as any;

    // The nested reference should be followed all the way to the inner value
    expect(isCell(value.context.nested)).toBe(true);
    expect(value.context.nested.get().value).toBe(42);

    const readDocs = new Set<DocImpl<any>>(log.reads.map((r) => r.cell));
    expect(readDocs.size).toBe(4);
    expect(readDocs.has(c.getDoc())).toBe(true);
    expect(readDocs.has(ref3Cell.getDoc())).toBe(true);
    expect(readDocs.has(ref2Cell.getDoc())).toBe(true);
    expect(readDocs.has(innerCell.getDoc())).toBe(true);

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
    const schema = {
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
              properties: { id: { type: "string" }, value: { type: "number" } },
            },
          },
        },
      },
    } as const satisfies JSONSchema;

    const testDoc = runtime.getCell<any>(
      space,
      "should transparently update ids when context changes",
    );
    testDoc.set(undefined);
    const testCell = testDoc.asSchema(schema);

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

    expect(isCellLink(testDoc.getRaw()[0])).toBe(true);
    expect(isCellLink(testDoc.getRaw()[1])).toBe(true);
    expect(testDoc.getRaw()[0].cell.get().name).toEqual("First Item");
    expect(testDoc.getRaw()[1].cell.get().name).toEqual("Second Item");

    const docFromContext1 = testDoc.getRaw()[0].cell;

    const returnedData = testCell.get();
    addCommonIDfromObjectID(returnedData);

    const frame2 = pushFrame({
      generatedIdCounter: 0,
      cause: "context 2",
      opaqueRefs: new Set(),
    });
    testCell.set(returnedData);
    popFrame(frame2);

    expect(isCellLink(testDoc.getRaw()[0])).toBe(true);
    expect(isCellLink(testDoc.getRaw()[1])).toBe(true);
    expect(testDoc.getRaw()[0].cell.get().name).toEqual("First Item");
    expect(testDoc.getRaw()[1].cell.get().name).toEqual("Second Item");

    // Let's make sure we got a different doc with the different context
    expect(testDoc.getRaw()[0].cell).not.toBe(docFromContext1);
    expect(testDoc.getRaw()[0].cell.entityId.toString()).not.toBe(
      docFromContext1.entityId.toString(),
    );

    expect(testCell.get()).toEqual(initialData);
  });

  it("should push values that are already cells reusing the reference", () => {
    const c = runtime.getCell<{ items: { value: number }[] }>(
      space,
      "should push values that are already cells reusing the reference",
    );
    c.set({ items: [] });
    const arrayCell = c.key("items");

    const d = runtime.getCell<{ value: number }>(
      space,
      "should push values that are already cells reusing the reference d",
    );
    d.set({ value: 1 });
    const dCell = d;

    arrayCell.push(d);
    arrayCell.push(dCell);
    arrayCell.push(d.getAsQueryResult());
    arrayCell.push(d.getAsCellLink());

    // helper to normalize CellLinks because different push operations
    // may result in CellLinks with different extra properties (ex: space)
    const normalizeCellLink = (link: any) => ({
      cell: link.cell,
      path: link.path,
    });

    const rawItems = c.getRaw().items;
    const expectedCellLink = normalizeCellLink(d.getAsCellLink());

    expect(rawItems.map(normalizeCellLink)).toEqual([
      expectedCellLink,
      expectedCellLink,
      expectedCellLink,
      expectedCellLink,
    ]);
  });

  it("should handle push method on non-array values", () => {
    const c = runtime.getCell<{ value: string }>(
      space,
      "should handle push method on non-array values",
    );
    c.set({ value: "not an array" });
    const cell = c.key("value");

    expect(() => cell.push(42)).toThrow();
  });

  it("should create new entities when pushing to array in frame, but reuse IDs", () => {
    const c = runtime.getCell<{ items: any[] }>(space, "push-with-id");
    c.set({ items: [] });
    const arrayCell = c.key("items");
    const frame = pushFrame();
    arrayCell.push({ value: 42 });
    expect(frame.generatedIdCounter).toEqual(1);
    arrayCell.push({ [ID]: "test", value: 43 });
    expect(frame.generatedIdCounter).toEqual(1); // No increment = no ID generated from it
    popFrame(frame);
    expect(isCellLink(c.getRaw().items[0])).toBe(true);
    expect(isCellLink(c.getRaw().items[1])).toBe(true);
    expect(arrayCell.get()).toEqual([{ value: 42 }, { value: 43 }]);
  });
});

describe("JSON.stringify bug", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

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

  it("should not modify the value of the cell", () => {
    const c = runtime.getCell(
      space,
      "json-test",
    );
    c.setRaw({ result: { data: 1 } });
    const d = runtime.getCell(
      space,
      "json-test2",
    );
    d.setRaw({ internal: { "__#2": { cell: c.getDoc(), path: ["result"] } } });
    const e = runtime.getCell(
      space,
      "json-test3",
    );
    e.setRaw({
      internal: {
        a: { $alias: { cell: d.getDoc(), path: ["internal", "__#2", "data"] } },
      },
    });
    const proxy = e.getAsQueryResult();
    const json = JSON.stringify(proxy);
    expect(json).toEqual('{"internal":{"a":1}}');
    expect(JSON.stringify(c.get())).toEqual('{"result":{"data":1}}');

    expect(JSON.stringify(d.getRaw())).toEqual(
      `{"internal":{"__#2":{"cell":${
        JSON.stringify(c.entityId)
      },"path":["result"]}}}`,
    );
    expect(JSON.stringify(e.getRaw())).toEqual(
      `{"internal":{"a":{"$alias":{"cell":${
        JSON.stringify(
          d.entityId,
        )
      },"path":["internal","__#2","data"]}}}}`,
    );
  });
});
