import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getDoc, isDoc, isDocLink } from "../src/doc.ts";
import { isCell } from "../src/cell.ts";
import { isQueryResult } from "../src/query-result-proxy.ts";
import { type ReactivityLog } from "../src/scheduler.ts";
import { JSONSchema } from "@commontools/builder";
import { addEventHandler, idle } from "../src/scheduler.ts";
import { compactifyPaths } from "../src/utils.ts";
import { getSpace } from "../src/space.ts";

describe("Cell", () => {
  it("should create a cell with initial value", () => {
    const c = getDoc(10);
    expect(c.get()).toBe(10);
  });

  it("should update cell value using send", () => {
    const c = getDoc(10);
    c.send(20);
    expect(c.get()).toBe(20);
  });

  it("should create a proxy for the cell", () => {
    const c = getDoc({ x: 1, y: 2 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(1);
    expect(proxy.y).toBe(2);
  });

  it("should update cell value through proxy", () => {
    const c = getDoc({ x: 1, y: 2 });
    const proxy = c.getAsQueryResult();
    proxy.x = 10;
    expect(c.get()).toEqual({ x: 10, y: 2 });
  });

  it("should get value at path", () => {
    const c = getDoc({ a: { b: { c: 42 } } });
    expect(c.getAtPath(["a", "b", "c"])).toBe(42);
  });

  it("should set value at path", () => {
    const c = getDoc({ a: { b: { c: 42 } } });
    c.setAtPath(["a", "b", "c"], 100);
    expect(c.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should call updates callback when value changes", () => {
    const c = getDoc(0);
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
  it("should identify a cell", () => {
    const c = getDoc(10);
    expect(isDoc(c)).toBe(true);
    expect(isDoc({})).toBe(false);
  });

  it("should identify a cell reference", () => {
    const c = getDoc(10);
    const ref = { cell: c, path: ["x"] };
    expect(isDocLink(ref)).toBe(true);
    expect(isDocLink({})).toBe(false);
  });

  it("should identify a cell proxy", () => {
    const c = getDoc({ x: 1 });
    const proxy = c.getAsQueryResult();
    expect(isQueryResult(proxy)).toBe(true);
    expect(isQueryResult({})).toBe(false);
  });
});

describe("createProxy", () => {
  it("should create a proxy for nested objects", () => {
    const c = getDoc({ a: { b: { c: 42 } } });
    const proxy = c.getAsQueryResult();
    expect(proxy.a.b.c).toBe(42);
  });

  it("should support regular assigments", () => {
    const c = getDoc({ x: 1 });
    const proxy = c.getAsQueryResult();
    proxy.x = 2;
    expect(c.get()).toStrictEqual({ x: 2 });
  });

  it("should handle $alias in objects", () => {
    const c = getDoc({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle aliases when writing", () => {
    const c = getDoc<any>({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    proxy.x = 100;
    expect(c.get().y).toBe(100);
  });

  it("should handle nested cells", () => {
    const innerCell = getDoc(42);
    const outerCell = getDoc({ x: innerCell });
    const proxy = outerCell.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle cell references", () => {
    const c = getDoc<any>({ x: 42 });
    const ref = { cell: c, path: ["x"] };
    const proxy = c.getAsQueryResult();
    proxy.y = ref;
    expect(proxy.y).toBe(42);
  });

  it("should handle infinite loops in cell references", () => {
    const c = getDoc<any>({ x: 42 });
    const ref = { cell: c, path: ["x"] };
    const proxy = c.getAsQueryResult();
    proxy.x = ref;
    expect(() => proxy.x).toThrow();
  });

  it("should support modifying array methods and log reads and writes", () => {
    const c = getDoc<any>(
      [],
      "should support modifying array methods and log reads and writes",
      getSpace("test"),
    );
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy[0] = 1;
    proxy.push(2);
    expect(c.get()).toHaveLength(2);
    expect(isDocLink(c.get()[0])).toBeTruthy();
    expect(c.get()[0].cell.get()).toBe(1);
    expect(isDocLink(c.get()[1])).toBeTruthy();
    expect(c.get()[1].cell.get()).toBe(2);
    expect(log.reads.map((r) => r.path)).toEqual([[]]);
    expect(log.writes.filter((w) => w.cell === c).map((w) => w.path)).toEqual([[
      "0",
    ], ["1"]]);
    expect(
      log.writes.filter((w) => w.cell === c.get()[0].cell).map((w) => w.path),
    ).toEqual([[]]);
    expect(
      log.writes.filter((w) => w.cell === c.get()[1].cell).map((w) => w.path),
    ).toEqual([[]]);
  });

  it("should support pop() and only read the popped element", () => {
    const c = getDoc(
      { a: [] as number[] },
      "should support pop() and only read the popped element",
      getSpace("test"),
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
    const c = getDoc(
      { a: [] as number[] },
      "should correctly sort() with cell references",
      getSpace("test"),
    );
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.a = [3, 1, 2];
    const result = proxy.a.sort();
    expect(result).toEqual([1, 2, 3]);
    expect(proxy.a).toEqual([1, 2, 3]);
  });

  it("should support readonly array methods and log reads", () => {
    const c = getDoc<any>(
      [1, 2, 3],
      "should support readonly array methods and log reads",
      getSpace("test"),
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
    const c = getDoc(
      { a: [1, 2, 3] },
      "should support mapping over a proxied array",
      getSpace("test"),
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

  it("should allow changig array lengts by writing length", () => {
    const c = getDoc(
      [1, 2, 3],
      "should allow changig array lengts by writing length",
      getSpace("test"),
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
});

describe("asCell", () => {
  it("should create a simple cell interface", () => {
    const c = getDoc(
      { x: 1, y: 2 },
      "should create a simple cell interface",
      getSpace("test"),
    );
    const simpleCell = c.asCell();

    expect(simpleCell.get()).toEqual({ x: 1, y: 2 });

    simpleCell.set({ x: 3, y: 4 });
    expect(c.get()).toEqual({ x: 3, y: 4 });

    simpleCell.send({ x: 5, y: 6 });
    expect(c.get()).toEqual({ x: 5, y: 6 });
  });

  it("should create a simple cell for nested properties", () => {
    const c = getDoc(
      { nested: { value: 42 } },
      "should create a simple cell for nested properties",
      getSpace("test"),
    );
    const nestedCell = c.asCell(["nested", "value"]);

    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should support the key method for nested access", () => {
    const c = getDoc(
      { a: { b: { c: 42 } } },
      "should support the key method for nested access",
      getSpace("test"),
    );
    const simpleCell = c.asCell();

    const nestedCell = simpleCell.key("a").key("b").key("c");
    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should return a Sendable for stream aliases", async () => {
    const c = getDoc(
      { stream: { $stream: true } },
      "should return a Sendable for stream aliases",
      getSpace("test"),
    );
    const streamCell = c.asCell(["stream"]);

    expect(streamCell).toHaveProperty("send");
    expect(streamCell).not.toHaveProperty("get");
    expect(streamCell).not.toHaveProperty("set");
    expect(streamCell).not.toHaveProperty("key");

    let lastEventSeen = "";
    let eventCount = 0;

    addEventHandler(
      (event) => {
        eventCount++;
        lastEventSeen = event;
      },
      { cell: c, path: ["stream"] },
    );

    streamCell.send("event");
    await idle();

    expect(c.get()).toStrictEqual({ stream: { $stream: true } });
    expect(eventCount).toBe(1);
    expect(lastEventSeen).toBe("event");
  });

  it("should call sink only when the cell changes on the subpath", async () => {
    const c = getDoc(
      { a: { b: 42, c: 10 }, d: 5 },
      "should call sink only when the cell changes on the subpath",
      getSpace("test"),
    );
    const values: number[] = [];
    c.asCell(["a", "b"]).sink((value) => {
      values.push(value);
    });
    expect(values).toEqual([42]); // Initial call
    c.setAtPath(["d"], 50);
    await idle();
    c.setAtPath(["a", "c"], 100);
    await idle();
    c.setAtPath(["a", "b"], 42);
    await idle();
    expect(values).toEqual([42]); // Didn't get called again
    c.setAtPath(["a", "b"], 300);
    await idle();
    expect(c.get()).toEqual({ a: { b: 300, c: 100 }, d: 50 });
    expect(values).toEqual([42, 300]); // Got called again
  });
});

describe("asCell with schema", () => {
  it("should validate and transform according to schema", () => {
    const c = getDoc(
      {
        name: "test",
        age: 42,
        tags: ["a", "b"],
        nested: {
          value: 123,
        },
      },
      "should validate and transform according to schema",
      getSpace("test"),
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
        },
      },
    } satisfies JSONSchema;

    const cell = c.asCell([], undefined, schema);
    const value = cell.get();

    expect(value.name).toBe("test");
    expect(value.age).toBe(42);
    expect(value.tags).toEqual(["a", "b"]);
    expect(value.nested.value).toBe(123);
  });

  it("should return a Cell for reference properties", () => {
    const c = getDoc(
      {
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
      },
      "should return a Cell for reference properties",
      getSpace("test"),
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
    } satisfies JSONSchema;

    const value = c.asCell([], undefined, schema).get();

    expect(value.id).toBe(1);
    expect(isCell(value.metadata)).toBe(true);

    // The metadata cell should behave like a normal cell
    const metadataValue = value.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });

  it("should handle recursive schemas with $ref", () => {
    const c = getDoc(
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
      getSpace("test"),
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
    } satisfies JSONSchema;

    const value = c.asCell([], undefined, schema).get();

    expect(value.name).toBe("root");
    expect(value.children[0].name).toBe("child1");
    expect(value.children[1].name).toBe("child2");
    expect(value.children[1].children[0].name).toBe("grandchild");
  });

  it("should propagate schema through key() navigation", () => {
    const c = getDoc(
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
      getSpace("test"),
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
            },
            metadata: {
              type: "object",
              asCell: true,
            },
          },
        },
      },
    } satisfies JSONSchema;

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
    const c = getDoc(
      {
        data: {
          value: 42,
          nested: {
            str: "hello",
          },
        },
      },
      "should fall back to query result proxy when no schema is present",
      getSpace("test"),
    );

    const value = c.asCell().get();

    // Should behave like a query result proxy
    expect(value.data.value).toBe(42);
    expect(value.data.nested.str).toBe("hello");
  });

  it("should allow changing schema with asSchema", () => {
    const c = getDoc(
      {
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
      },
      "should allow changing schema with asSchema",
      getSpace("test"),
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
    } satisfies JSONSchema;

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
    } satisfies JSONSchema;

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
    const c = getDoc(
      {
        id: 1,
        context: {
          user: { name: "John" },
          settings: { theme: "dark" },
          data: { value: 42 },
        },
      },
      "should handle objects with additional properties as references",
      getSpace("test"),
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
    } satisfies JSONSchema;

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
    const c = getDoc(
      {
        context: {
          number: 42,
          string: "hello",
          object: { value: 123 },
          array: [1, 2, 3],
        },
      },
      "should handle additional properties with just reference: true",
      getSpace("test"),
    );

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
    } satisfies JSONSchema;

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
    const innerCell = getDoc({ value: 42 });

    // Create a cell that uses that reference
    const c = getDoc(
      {
        context: {
          inner: innerCell,
        },
      },
      "should handle references in underlying cell",
      getSpace("test"),
    );

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
    } satisfies JSONSchema;

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
    const innerCell = getDoc(
      { value: 42 },
      "should handle all types of references in underlying cell: inner",
      getSpace("test"),
    );
    const cellRef = { cell: innerCell, path: [] };
    const aliasRef = { $alias: { cell: innerCell, path: [] } };

    // Create a cell that uses all reference types
    const c = getDoc(
      {
        context: {
          cell: innerCell,
          reference: cellRef,
          alias: aliasRef,
        },
      },
      "should handle all types of references in underlying cell",
      getSpace("test"),
    );

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
    } satisfies JSONSchema;

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
    const innerCell = getDoc(
      { value: 42 },
      "should handle nested references: inner",
      getSpace("test"),
    );
    const ref1 = { cell: innerCell, path: [] };
    const ref2 = {
      cell: getDoc(
        { ref: ref1 },
        "should handle nested references: ref2",
        getSpace("test"),
      ),
      path: ["ref"],
    };
    const ref3 = {
      cell: getDoc(
        { ref: ref2 },
        "should handle nested references: ref3",
        getSpace("test"),
      ),
      path: ["ref"],
    };

    // Create a cell that uses the nested reference
    const c = getDoc(
      {
        context: {
          nested: ref3,
        },
      },
      "should handle nested references",
      getSpace("test"),
    );

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
    } satisfies JSONSchema;

    const log = { reads: [], writes: [] } as ReactivityLog;
    const cell = c.asCell([], log, schema);
    const value = cell.get();

    // The nested reference should be followed all the way to the inner value
    expect(isCell(value.context.nested)).toBe(true);
    expect(value.context.nested.get().value).toBe(42);

    // All references in the chain should be read
    const reads = compactifyPaths(log.reads);

    expect(reads.length).toBe(4);
    expect(reads[0].cell).toBe(c);
    expect(reads[1].cell).toBe(ref3.cell);
    expect(reads[2].cell).toBe(ref2.cell);
    expect(reads[3].cell).toBe(ref1.cell);

    // Changes to the original cell should propagate through the chain
    innerCell.send({ value: 100 });
    expect(value.context.nested.get().value).toBe(100);
  });

  it("should handle array schemas in key() navigation", () => {
    const c = getDoc(
      {
        items: [
          { name: "item1", value: 1 },
          { name: "item2", value: 2 },
        ],
      },
      "should handle array schemas in key() navigation",
      getSpace("test"),
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
          },
        },
      },
    } satisfies JSONSchema;

    const cell = c.asCell([], undefined, schema);
    const itemsCell = cell.key("items");
    const firstItemCell = itemsCell.key(0);
    const secondItemCell = itemsCell.key(1);

    expect(firstItemCell.get()).toEqual({ name: "item1", value: 1 });
    expect(secondItemCell.get()).toEqual({ name: "item2", value: 2 });
  });

  it("should handle additionalProperties in key() navigation", () => {
    const c = getDoc(
      {
        defined: "known property",
        extra1: { value: 1 },
        extra2: { value: 2 },
      },
      "should handle additionalProperties in key() navigation",
      getSpace("test"),
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
    } satisfies JSONSchema;

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
    const c = getDoc(
      {
        defined: "known property",
        extra: { anything: "goes" },
      },
      "should handle additionalProperties: true in key() navigation",
      getSpace("test"),
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
    } satisfies JSONSchema;

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
    const c = getDoc(
      { name: "test", age: 42, tags: ["a", "b"] },
      "should partially update object values using update method",
      getSpace("test"),
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
    const c = getDoc({ items: [1, 2, 3] }, "push-test", getSpace("test"));
    const arrayCell = c.asCell(["items"]);

    arrayCell.push(4);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4]);

    arrayCell.push(5);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4, 5]);

    expect(isDocLink(c.get().items[4])).toBeTruthy();
  });

  it("should push values that are already cells reusing the reference", () => {
    const c = getDoc<{ items: { value: number }[] }>({ items: [] });
    const arrayCell = c.asCell().key("items");

    const d = getDoc<{ value: number }>({ value: 1 });

    arrayCell.push(d);
    arrayCell.push(d.asCell());
    arrayCell.push(d.getAsQueryResult());
    arrayCell.push({ cell: d, path: [] });

    expect(c.get().items).toEqual([
      { cell: d, path: [] },
      { cell: d, path: [] },
      { cell: d, path: [] },
      { cell: d, path: [] },
    ]);
  });

  it("should handle push method on non-array values", () => {
    const c = getDoc({ value: "not an array" });
    const cell = c.asCell(["value"]);

    expect(() => cell.push(42)).toThrow();
  });
});

describe("JSON.stringify bug", () => {
  it("should not modify the value of the cell", () => {
    const c = getDoc({ result: { data: 1 } }, "json-test", getSpace("test"));
    const d = getDoc(
      { internal: { "__#2": { cell: c, path: ["result"] } } },
      "json-test2",
      getSpace("test"),
    );
    const e = getDoc(
      {
        internal: {
          a: { $alias: { cell: d, path: ["internal", "__#2", "data"] } },
        },
      },
      "json-test3",
      getSpace("test"),
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
