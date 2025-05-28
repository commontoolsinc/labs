import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type DocImpl, isDoc } from "../src/doc.ts";
import { isCell, isCellLink } from "../src/cell.ts";
import { isQueryResult } from "../src/query-result-proxy.ts";
import { type ReactivityLog } from "../src/scheduler.ts";
import { ID, JSONSchema, popFrame, pushFrame } from "@commontools/builder";
import { Runtime } from "../src/runtime.ts";
import { addCommonIDfromObjectID } from "../src/utils.ts";

describe("Cell", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://"
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
  });
  it("should create a cell with initial value", () => {
    const c = runtime.documentMap.getDoc(
      10,
      "should create a cell with initial value",
      "test",
    );
    expect(c.get()).toBe(10);
  });

  it("should update cell value using send", () => {
    const c = runtime.documentMap.getDoc(
      10,
      "should update cell value using send",
      "test",
    );
    c.send(20);
    expect(c.get()).toBe(20);
  });

  it("should create a proxy for the cell", () => {
    const c = runtime.documentMap.getDoc(
      { x: 1, y: 2 },
      "should create a proxy for the cell",
      "test",
    );
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(1);
    expect(proxy.y).toBe(2);
  });

  it("should update cell value through proxy", () => {
    const c = runtime.documentMap.getDoc(
      { x: 1, y: 2 },
      "should update cell value through proxy",
      "test",
    );
    const proxy = c.getAsQueryResult();
    proxy.x = 10;
    expect(c.get()).toEqual({ x: 10, y: 2 });
  });

  it("should get value at path", () => {
    const c = runtime.documentMap.getDoc(
      { a: { b: { c: 42 } } },
      "should get value at path",
      "test",
    );
    expect(c.getAtPath(["a", "b", "c"])).toBe(42);
  });

  it("should set value at path", () => {
    const c = runtime.documentMap.getDoc(
      { a: { b: { c: 42 } } },
      "should set value at path",
      "test",
    );
    c.setAtPath(["a", "b", "c"], 100);
    expect(c.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should call updates callback when value changes", () => {
    const c = runtime.documentMap.getDoc(
      0,
      "should call updates callback when value changes",
      "test",
    );
    const values: number[] = [];
    const unsink = c.updates((value) => values.push(value));
    c.send(1);
    c.send(2);
    c.send(3);
    unsink();
    c.send(4);
    expect(values).toEqual([1, 2, 3]);
  });
});

describe("Cell utility functions", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://"
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  it("should identify a cell", () => {
    const c = runtime.documentMap.getDoc(10, "should identify a cell", "test");
    expect(isDoc(c)).toBe(true);
    expect(isDoc({})).toBe(false);
  });

  it("should identify a cell reference", () => {
    const c = runtime.documentMap.getDoc(10, "should identify a cell reference", "test");
    const ref = { cell: c, path: ["x"] };
    expect(isCellLink(ref)).toBe(true);
    expect(isCellLink({})).toBe(false);
  });

  it("should identify a cell proxy", () => {
    const c = runtime.documentMap.getDoc(
      { x: 1 },
      "should identify a cell proxy",
      "test",
    );
    const proxy = c.getAsQueryResult();
    expect(isQueryResult(proxy)).toBe(true);
    expect(isQueryResult({})).toBe(false);
  });
});

describe("createProxy", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://"
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  it("should create a proxy for nested objects", () => {
    const c = runtime.documentMap.getDoc(
      { a: { b: { c: 42 } } },
      "should create a proxy for nested objects",
      "test",
    );
    const proxy = c.getAsQueryResult();
    expect(proxy.a.b.c).toBe(42);
  });

  it("should support regular assigments", () => {
    const c = runtime.documentMap.getDoc(
      { x: 1 },
      "should support regular assigments",
      "test",
    );
    const proxy = c.getAsQueryResult();
    proxy.x = 2;
    expect(c.get()).toStrictEqual({ x: 2 });
  });

  it("should handle $alias in objects", () => {
    const c = runtime.documentMap.getDoc(
      { x: { $alias: { path: ["y"] } }, y: 42 },
      "should handle $alias in objects",
      "test",
    );
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle aliases when writing", () => {
    const c = runtime.documentMap.getDoc(
      { x: { $alias: { path: ["y"] } }, y: 42 },
      "should handle aliases when writing",
      "test",
    );
    const proxy = c.getAsQueryResult();
    proxy.x = 100;
    expect(c.get().y).toBe(100);
  });

  it("should handle nested cells", () => {
    const innerCell = runtime.documentMap.getDoc(
      42,
      "should handle nested cells",
      "test",
    );
    const outerCell = runtime.documentMap.getDoc(
      { x: innerCell },
      "should handle nested cells",
      "test",
    );
    const proxy = outerCell.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle cell references", () => {
    const c = runtime.documentMap.getDoc(
      { x: 42 },
      "should handle cell references",
      "test",
    );
    const ref = { cell: c, path: ["x"] };
    const proxy = c.getAsQueryResult();
    proxy.y = ref;
    expect(proxy.y).toBe(42);
  });

  it("should handle infinite loops in cell references", () => {
    const c = runtime.documentMap.getDoc(
      { x: 42 },
      "should handle infinite loops in cell references",
      "test",
    );
    const ref = { cell: c, path: ["x"] };
    const proxy = c.getAsQueryResult();
    proxy.x = ref;
    expect(() => proxy.x).toThrow();
  });

  it("should support modifying array methods and log reads and writes", () => {
    const log: ReactivityLog = { reads: [], writes: [] };
    const c = runtime.documentMap.getDoc(
      { array: [1, 2, 3] },
      "should support modifying array methods and log reads and writes",
      "test",
    );
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
    const c = runtime.documentMap.getDoc(
      { data: {} },
      "should handle array methods on previously undefined arrays",
      "test",
    );
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
    const c = runtime.documentMap.getDoc(
      { array: [1, 2, 3, 4, 5] },
      "should handle array results from array methods",
      "test",
    );
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
    const c = runtime.documentMap.getDoc(
      { nested: { arrays: [[1, 2], [3, 4]] } },
      "should maintain reactivity with nested array operations",
      "test",
    );
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
    const c = runtime.documentMap.getDoc(
      { a: [] as number[] },
      "should support pop() and only read the popped element",
      "test",
    );
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
    const c = runtime.documentMap.getDoc(
      { a: [] as number[] },
      "should correctly sort() with cell references",
      "test",
    );
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.a = [3, 1, 2];
    const result = proxy.a.sort();
    expect(result).toEqual([1, 2, 3]);
    expect(proxy.a).toEqual([1, 2, 3]);
  });

  it("should support readonly array methods and log reads", () => {
    const c = runtime.documentMap.getDoc<any>(
      [1, 2, 3],
      "should support readonly array methods and log reads",
      "test",
    );
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    const result = proxy.find((x: any) => x === 2);
    expect(result).toBe(2);
    expect(c.get()).toEqual([1, 2, 3]);
    expect(log.reads.map((r) => r.path)).toEqual([[], [0], [1], [2]]);
    expect(log.writes).toEqual([]);
  });

  it("should support mapping over a proxied array", () => {
    const c = runtime.documentMap.getDoc(
      { a: [1, 2, 3] },
      "should support mapping over a proxied array",
      "test",
    );
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
    const c = runtime.documentMap.getDoc(
      [1, 2, 3],
      "should allow changing array lengths by writing length",
      "test",
    );
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.length = 2;
    expect(c.get()).toEqual([1, 2]);
    expect(log.writes).toEqual([
      { cell: c, path: ["length"] },
      { cell: c, path: [2] },
    ]);
    proxy.length = 4;
    expect(c.get()).toEqual([1, 2, undefined, undefined]);
    expect(log.writes).toEqual([
      { cell: c, path: ["length"] },
      { cell: c, path: [2] },
      { cell: c, path: ["length"] },
      { cell: c, path: [2] },
      { cell: c, path: [3] },
    ]);
  });

  it("should allow changing array by splicing", () => {
    const c = runtime.documentMap.getDoc(
      [1, 2, 3],
      "should allow changing array by splicing",
      "test",
    );
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.splice(1, 1, 4, 5);
    expect(c.get()).toEqual([1, 4, 5, 3]);
    expect(log.writes).toEqual([
      { cell: c, path: ["1"] },
      { cell: c, path: ["2"] },
      { cell: c, path: ["3"] },
    ]);
  });
});

describe("asCell", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://"
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  it("should create a simple cell interface", () => {
    const c = runtime.documentMap.getDoc(
      { x: 1, y: 2 },
      "should create a simple cell interface",
      "test",
    );
    const simpleCell = c.asCell();

    expect(simpleCell.get()).toEqual({ x: 1, y: 2 });

    simpleCell.set({ x: 3, y: 4 });
    expect(c.get()).toEqual({ x: 3, y: 4 });

    simpleCell.send({ x: 5, y: 6 });
    expect(c.get()).toEqual({ x: 5, y: 6 });
  });

  it("should create a simple cell for nested properties", () => {
    const c = runtime.documentMap.getDoc(
      { nested: { value: 42 } },
      "should create a simple cell for nested properties",
      "test",
    );
    const nestedCell = c.asCell(["nested", "value"]);

    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should support the key method for nested access", () => {
    const c = runtime.documentMap.getDoc(
      { a: { b: { c: 42 } } },
      "should support the key method for nested access",
      "test",
    );
    const simpleCell = c.asCell();

    const nestedCell = simpleCell.key("a").key("b").key("c");
    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should return a Sendable for stream aliases", async () => {
    const c = runtime.documentMap.getDoc(
      { stream: { $stream: true } },
      "should return a Sendable for stream aliases",
      "test",
    );
    const streamCell = c.asCell(["stream"]);

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
      { cell: c, path: ["stream"] },
    );

    streamCell.send("event");
    await runtime.scheduler.idle();

    expect(c.get()).toStrictEqual({ stream: { $stream: true } });
    expect(eventCount).toBe(1);
    expect(lastEventSeen).toBe("event");
  });

  it("should call sink only when the cell changes on the subpath", async () => {
    const c = runtime.documentMap.getDoc(
      { a: { b: 42, c: 10 }, d: 5 },
      "should call sink only when the cell changes on the subpath",
      "test",
    );
    const values: number[] = [];
    c.asCell(["a", "b"]).sink((value) => {
      values.push(value);
    });
    expect(values).toEqual([42]); // Initial call
    c.setAtPath(["d"], 50);
    await runtime.scheduler.idle();
    c.setAtPath(["a", "c"], 100);
    await runtime.scheduler.idle();
    c.setAtPath(["a", "b"], 42);
    await runtime.scheduler.idle();
    expect(values).toEqual([42]); // Didn't get called again
    c.setAtPath(["a", "b"], 300);
    await runtime.scheduler.idle();
    expect(c.get()).toEqual({ a: { b: 300, c: 100 }, d: 50 });
    expect(values).toEqual([42, 300]); // Got called again
  });
});

describe("asCell with schema", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://"
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  it("should validate and transform according to schema", () => {
    const c = runtime.documentMap.getDoc(
      {
        name: "test",
        age: 42,
        tags: ["a", "b"],
        nested: {
          value: 123,
        },
      },
      "should validate and transform according to schema",
      "test",
    );

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

    const cell = c.asCell([], undefined, schema);
    const value = cell.get();

    expect(value.name).toBe("test");
    expect(value.age).toBe(42);
    expect(value.tags).toEqual(["a", "b"]);
    expect(value.nested.value).toBe(123);
  });

  it("should return a Cell for reference properties", () => {
    const c = runtime.documentMap.getDoc(
      {
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
      },
      "should return a Cell for reference properties",
      "test",
    );

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

    const value = c.asCell([], undefined, schema).get();

    expect(value.id).toBe(1);
    expect(isCell(value.metadata)).toBe(true);

    // The metadata cell should behave like a normal cell
    const metadataValue = value.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });

  it("should handle recursive schemas with $ref", () => {
    const c = runtime.documentMap.getDoc(
      {
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
      },
      "should handle recursive schemas with $ref",
      "test",
    );

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

    const value = c.asCell([], undefined, schema).get();

    expect(value.name).toBe("root");
    expect(value.children[0].name).toBe("child1");
    expect(value.children[1].name).toBe("child2");
    expect(value.children[1].children[0].name).toBe("grandchild");
  });

  it("should propagate schema through key() navigation", () => {
    const c = runtime.documentMap.getDoc(
      {
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
      },
      "should propagate schema through key() navigation",
      "test",
    );

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

    const cell = c.asCell([], undefined, schema);
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
    const c = runtime.documentMap.getDoc(
      {
        data: {
          value: 42,
          nested: {
            str: "hello",
          },
        },
      },
      "should fall back to query result proxy when no schema is present",
      "test",
    );

    const value = c.asCell().get();

    // Should behave like a query result proxy
    expect(value.data.value).toBe(42);
    expect(value.data.nested.str).toBe("hello");
  });

  it("should allow changing schema with asSchema", () => {
    const c = runtime.documentMap.getDoc(
      {
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
      },
      "should allow changing schema with asSchema",
      "test",
    );

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

    const cell = c.asCell([], undefined, initialSchema);
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
    const c = runtime.documentMap.getDoc(
      {
        id: 1,
        context: {
          user: { name: "John" },
          settings: { theme: "dark" },
          data: { value: 42 },
        },
      },
      "should handle objects with additional properties as references",
      "test",
    );

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

    const cell = c.asCell([], undefined, schema);
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
    const c = runtime.documentMap.getDoc(
      {
        context: {
          number: 42,
          string: "hello",
          object: { value: 123 },
          array: [1, 2, 3],
        },
      },
      "should handle additional properties with just reference: true",
      "test",
    );

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

    const cell = c.asCell([], undefined, schema);
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
    const innerCell = runtime.documentMap.getDoc(
      { value: 42 },
      "should handle references in underlying cell",
      "test",
    );

    // Create a cell that uses that reference
    const c = runtime.documentMap.getDoc(
      {
        context: {
          inner: innerCell,
        },
      },
      "should handle references in underlying cell",
      "test",
    );

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

    const cell = c.asCell([], undefined, schema);
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
    const innerCell = runtime.documentMap.getDoc(
      { value: 42 },
      "should handle all types of references in underlying cell: inner",
      "test",
    );
    const cellRef = { cell: innerCell, path: [] };
    const aliasRef = { $alias: { cell: innerCell, path: [] } };

    // Create a cell that uses all reference types
    const c = runtime.documentMap.getDoc(
      {
        context: {
          cell: innerCell,
          reference: cellRef,
          alias: aliasRef,
        },
      },
      "should handle all types of references in underlying cell",
      "test",
    );

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

    const cell = c.asCell([], undefined, schema);
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
    const innerCell = runtime.documentMap.getDoc(
      { value: 42 },
      "should handle nested references: inner",
      "test",
    );
    const ref1 = { cell: innerCell, path: [] };
    const ref2 = {
      cell: runtime.documentMap.getDoc(
        { ref: ref1 },
        "should handle nested references: ref2",
        "test",
      ),
      path: ["ref"],
    };
    const ref3 = {
      cell: runtime.documentMap.getDoc(
        { ref: ref2 },
        "should handle nested references: ref3",
        "test",
      ),
      path: ["ref"],
    };

    // Create a cell that uses the nested reference
    const c = runtime.documentMap.getDoc(
      {
        context: {
          nested: ref3,
        },
      },
      "should handle nested references",
      "test",
    );

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
    const cell = c.asCell([], log, schema);
    const value = cell.get();

    // The nested reference should be followed all the way to the inner value
    expect(isCell(value.context.nested)).toBe(true);
    expect(value.context.nested.get().value).toBe(42);

    const readDocs = new Set<DocImpl<any>>(log.reads.map((r) => r.cell));
    expect(readDocs.size).toBe(4);
    expect(readDocs.has(c)).toBe(true);
    expect(readDocs.has(ref3.cell)).toBe(true);
    expect(readDocs.has(ref2.cell)).toBe(true);
    expect(readDocs.has(ref1.cell)).toBe(true);

    // Changes to the original cell should propagate through the chain
    innerCell.send({ value: 100 });
    expect(value.context.nested.get().value).toBe(100);
  });

  it("should handle array schemas in key() navigation", () => {
    const c = runtime.documentMap.getDoc(
      {
        items: [
          { name: "item1", value: 1 },
          { name: "item2", value: 2 },
        ],
      },
      "should handle array schemas in key() navigation",
      "test",
    );

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

    const cell = c.asCell([], undefined, schema);
    const itemsCell = cell.key("items");
    const firstItemCell = itemsCell.key(0);
    const secondItemCell = itemsCell.key(1);

    expect(firstItemCell.get()).toEqual({ name: "item1", value: 1 });
    expect(secondItemCell.get()).toEqual({ name: "item2", value: 2 });
  });

  it("should handle additionalProperties in key() navigation", () => {
    const c = runtime.documentMap.getDoc(
      {
        defined: "known property",
        extra1: { value: 1 },
        extra2: { value: 2 },
      },
      "should handle additionalProperties in key() navigation",
      "test",
    );

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

    const cell = c.asCell([], undefined, schema);

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
    const c = runtime.documentMap.getDoc(
      {
        defined: "known property",
        extra: { anything: "goes" },
      },
      "should handle additionalProperties: true in key() navigation",
      "test",
    );

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

    const cell = c.asCell([], undefined, schema);

    // Test defined property
    const definedCell = cell.key("defined");
    expect(definedCell.get()).toBe("known property");

    // Test additional property with a schema that generates a reference
    const extraCell = cell.key("extra");
    const extraValue = extraCell.get();
    expect(isCell(extraValue.anything)).toBe(true);
  });

  it("should partially update object values using update method", () => {
    const c = runtime.documentMap.getDoc(
      { name: "test", age: 42, tags: ["a", "b"] },
      "should partially update object values using update method",
      "test",
    );
    const cell = c.asCell();

    cell.update({ age: 43, tags: ["a", "b", "c"] });
    expect(cell.get()).toEqual({
      name: "test",
      age: 43,
      tags: ["a", "b", "c"],
    });

    // Should preserve unmodified fields
    cell.update({ name: "updated" });
    expect(cell.get()).toEqual({
      name: "updated",
      age: 43,
      tags: ["a", "b", "c"],
    });
  });

  it("should push values to array using push method", () => {
    const c = runtime.documentMap.getDoc({ items: [1, 2, 3] }, "push-test", "test");
    const arrayCell = c.asCell(["items"]);
    expect(arrayCell.get()).toEqual([1, 2, 3]);
    arrayCell.push(4);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4]);

    arrayCell.push(5);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4, 5]);
  });

  it("should throw when pushing values to `null`", () => {
    const c = runtime.documentMap.getDoc({ items: null }, "push-to-null", "test");
    const arrayCell = c.asCell(["items"]);
    expect(arrayCell.get()).toBeNull();

    expect(() => arrayCell.push(1)).toThrow();
  });

  it("should push values to undefined array with schema default", () => {
    const schema = {
      type: "array",
      default: [10, 20],
    } as const satisfies JSONSchema;

    const c = runtime.documentMap.getDoc({}, "push-to-undefined-schema", "test");
    const arrayCell = c.asCell(["items"], undefined, schema);

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

    const c = runtime.documentMap.getDoc({}, "push-to-undefined-schema-stable-id", "test");
    const arrayCell = c.asCell(["items"], undefined, schema);

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

    const testDoc = runtime.documentMap.getDoc<any>(
      undefined,
      "should transparently update ids when context changes",
      "test",
    );
    const testCell = testDoc.asCell([], undefined, schema);

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

    expect(isCellLink(testDoc.get()[0])).toBe(true);
    expect(isCellLink(testDoc.get()[1])).toBe(true);
    expect(testDoc.get()[0].cell.get().name).toEqual("First Item");
    expect(testDoc.get()[1].cell.get().name).toEqual("Second Item");

    const docFromContext1 = testDoc.get()[0].cell;

    const returnedData = testCell.get();
    addCommonIDfromObjectID(returnedData);

    const frame2 = pushFrame({
      generatedIdCounter: 0,
      cause: "context 2",
      opaqueRefs: new Set(),
    });
    testCell.set(returnedData);
    popFrame(frame2);

    expect(isCellLink(testDoc.get()[0])).toBe(true);
    expect(isCellLink(testDoc.get()[1])).toBe(true);
    expect(testDoc.get()[0].cell.get().name).toEqual("First Item");
    expect(testDoc.get()[1].cell.get().name).toEqual("Second Item");

    // Let's make sure we got a different doc with the different context
    expect(testDoc.get()[0].cell).not.toBe(docFromContext1);
    expect(testDoc.get()[0].cell.entityId.toString()).not.toBe(
      docFromContext1.entityId.toString(),
    );

    expect(testCell.get()).toEqual(initialData);
  });

  it("should push values that are already cells reusing the reference", () => {
    const c = runtime.documentMap.getDoc<{ items: { value: number }[] }>(
      { items: [] },
      "should push values that are already cells reusing the reference",
      "test",
    );
    const arrayCell = c.asCell().key("items");

    const d = runtime.documentMap.getDoc<{ value: number }>(
      { value: 1 },
      "should push values that are already cells reusing the reference",
      "test",
    );
    const dCell = d.asCell();

    arrayCell.push(d);
    arrayCell.push(dCell);
    arrayCell.push(d.getAsQueryResult());
    arrayCell.push({ cell: d, path: [] });

    expect(c.get().items).toEqual([
      { cell: d, path: [] },
      dCell.getAsCellLink(),
      { cell: d, path: [] },
      { cell: d, path: [] },
    ]);
  });

  it("should handle push method on non-array values", () => {
    const c = runtime.documentMap.getDoc(
      { value: "not an array" },
      "should handle push method on non-array values",
      "test",
    );
    const cell = c.asCell(["value"]);

    expect(() => cell.push(42)).toThrow();
  });

  it("should create new entities when pushing to array in frame, but reuse IDs", () => {
    const c = runtime.documentMap.getDoc({ items: [] }, "push-with-id", "test");
    const arrayCell = c.asCell(["items"]);
    const frame = pushFrame();
    arrayCell.push({ value: 42 });
    expect(frame.generatedIdCounter).toEqual(1);
    arrayCell.push({ [ID]: "test", value: 43 });
    expect(frame.generatedIdCounter).toEqual(1); // No increment = no ID generated from it
    popFrame(frame);
    expect(isCellLink(c.get().items[0])).toBe(true);
    expect(isCellLink(c.get().items[1])).toBe(true);
    expect(arrayCell.get()).toEqual([{ value: 42 }, { value: 43 }]);
  });
});

describe("JSON.stringify bug", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://"
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  it("should not modify the value of the cell", () => {
    const c = runtime.documentMap.getDoc({ result: { data: 1 } }, "json-test", "test");
    const d = runtime.documentMap.getDoc(
      { internal: { "__#2": { cell: c, path: ["result"] } } },
      "json-test2",
      "test",
    );
    const e = runtime.documentMap.getDoc(
      {
        internal: {
          a: { $alias: { cell: d, path: ["internal", "__#2", "data"] } },
        },
      },
      "json-test3",
      "test",
    );
    const proxy = e.getAsQueryResult();
    const json = JSON.stringify(proxy);
    expect(json).toEqual('{"internal":{"a":1}}');
    expect(JSON.stringify(c.get())).toEqual('{"result":{"data":1}}');
    expect(JSON.stringify(d.get())).toEqual(
      `{"internal":{"__#2":{"cell":${
        JSON.stringify(c.entityId)
      },"path":["result"]}}}`,
    );
    expect(JSON.stringify(e.get())).toEqual(
      `{"internal":{"a":{"$alias":{"cell":${
        JSON.stringify(
          d.entityId,
        )
      },"path":["internal","__#2","data"]}}}}`,
    );
  });
});
