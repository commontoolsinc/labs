import { describe, it, expect } from "vitest";
import {
  cell,
  isCell,
  isCellReference,
  isQueryResult,
  isRendererCell,
  ReactivityLog,
} from "../src/cell.js";
import { JsonSchema } from "../src/schema.js";
import { addEventHandler, idle } from "../src/scheduler.js";

describe("Cell", () => {
  it("should create a cell with initial value", () => {
    const c = cell(10);
    expect(c.get()).toBe(10);
  });

  it("should update cell value using send", () => {
    const c = cell(10);
    c.send(20);
    expect(c.get()).toBe(20);
  });

  it("should create a proxy for the cell", () => {
    const c = cell({ x: 1, y: 2 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(1);
    expect(proxy.y).toBe(2);
  });

  it("should update cell value through proxy", () => {
    const c = cell({ x: 1, y: 2 });
    const proxy = c.getAsQueryResult();
    proxy.x = 10;
    expect(c.get()).toEqual({ x: 10, y: 2 });
  });

  it("should get value at path", () => {
    const c = cell({ a: { b: { c: 42 } } });
    expect(c.getAtPath(["a", "b", "c"])).toBe(42);
  });

  it("should set value at path", () => {
    const c = cell({ a: { b: { c: 42 } } });
    c.setAtPath(["a", "b", "c"], 100);
    expect(c.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should sink changes", () => {
    const c = cell(0);
    const values: number[] = [];
    const unsink = c.sink(value => values.push(value));
    c.send(1);
    c.send(2);
    c.send(3);
    unsink();
    c.send(4);
    expect(values).toEqual([0, 1, 2, 3]);
  });
});

describe("Cell utility functions", () => {
  it("should identify a cell", () => {
    const c = cell(10);
    expect(isCell(c)).toBe(true);
    expect(isCell({})).toBe(false);
  });

  it("should identify a cell reference", () => {
    const c = cell(10);
    const ref = { cell: c, path: ["x"] };
    expect(isCellReference(ref)).toBe(true);
    expect(isCellReference({})).toBe(false);
  });

  it("should identify a cell proxy", () => {
    const c = cell({ x: 1 });
    const proxy = c.getAsQueryResult();
    expect(isQueryResult(proxy)).toBe(true);
    expect(isQueryResult({})).toBe(false);
  });
});

describe("createProxy", () => {
  it("should create a proxy for nested objects", () => {
    const c = cell({ a: { b: { c: 42 } } });
    const proxy = c.getAsQueryResult();
    expect(proxy.a.b.c).toBe(42);
  });

  it("should support regular assigments", () => {
    const c = cell({ x: 1 });
    const proxy = c.getAsQueryResult();
    proxy.x = 2;
    expect(c.get()).toStrictEqual({ x: 2 });
  });

  it("should handle $alias in objects", () => {
    const c = cell({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle aliases when writing", () => {
    const c = cell<any>({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    proxy.x = 100;
    expect(c.get().y).toBe(100);
  });

  it("should handle nested cells", () => {
    const innerCell = cell(42);
    const outerCell = cell({ x: innerCell });
    const proxy = outerCell.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle cell references", () => {
    const c = cell<any>({ x: 42 });
    const ref = { cell: c, path: ["x"] };
    const proxy = c.getAsQueryResult();
    proxy.y = ref;
    expect(proxy.y).toBe(42);
  });

  it("should handle infinite loops in cell references", () => {
    const c = cell<any>({ x: 42 });
    const ref = { cell: c, path: ["x"] };
    const proxy = c.getAsQueryResult();
    proxy.x = ref;
    expect(() => proxy.x).toThrow();
  });

  it("should support modifying array methods and log reads and writes", () => {
    const c = cell<any>([]);
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy[0] = 1;
    proxy.push(2);
    expect(c.get()).toHaveLength(2);
    expect(isCellReference(c.get()[0])).toBeTruthy();
    expect(c.get()[0].cell.get()).toBe(1);
    expect(isCellReference(c.get()[1])).toBeTruthy();
    expect(c.get()[1].cell.get()).toBe(2);
    expect(log.reads).toEqual([{ cell: c, path: [] }]);
    expect(log.writes).toEqual([
      { cell: c.get()[0].cell, path: [] },
      { cell: c, path: ["0"] },
      { cell: c.get()[1].cell, path: [] },
      { cell: c, path: ["1"] },
    ]);
  });

  it("should support pop() and only read the popped element", () => {
    const c = cell({ a: [] as number[] });
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.a = [1, 2, 3];
    const result = proxy.a.pop();
    const pathsRead = log.reads.map(r => r.path.join("."));
    expect(pathsRead).toContain("a.2");
    expect(pathsRead).not.toContain("a.0");
    expect(pathsRead).not.toContain("a.1");
    expect(result).toEqual(3);
    expect(proxy.a).toEqual([1, 2]);
  });

  it("should correctly sort() with cell references", () => {
    const c = cell({ a: [] as number[] }, "sort-test");
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    proxy.a = [3, 1, 2];
    const result = proxy.a.sort();
    expect(result).toEqual([1, 2, 3]);
    expect(proxy.a).toEqual([1, 2, 3]);
  });

  it("should support readonly array methods and log reads", () => {
    const c = cell<any>([1, 2, 3]);
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    const result = proxy.find((x: any) => x === 2);
    expect(result).toBe(2);
    expect(c.get()).toEqual([1, 2, 3]);
    expect(log.reads).toEqual([
      { cell: c, path: [] },
      { cell: c, path: [0] },
      { cell: c, path: [1] },
      { cell: c, path: [2] },
    ]);
    expect(log.writes).toEqual([]);
  });

  it("should support mapping over a proxied array", () => {
    const c = cell({ a: [1, 2, 3] });
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsQueryResult([], log);
    const result = proxy.a.map(x => x + 1);
    expect(result).toEqual([2, 3, 4]);
    expect(log.reads).toEqual([
      { cell: c, path: [] },
      { cell: c, path: ["a"] },
      { cell: c, path: ["a", 0] },
      { cell: c, path: ["a", 1] },
      { cell: c, path: ["a", 2] },
    ]);
  });

  it("should allow changig array lengts by writing length", () => {
    const c = cell([1, 2, 3]);
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

describe("asRendererCell", () => {
  it("should create a simple cell interface", () => {
    const c = cell({ x: 1, y: 2 });
    const simpleCell = c.asRendererCell();

    expect(simpleCell.get()).toEqual({ x: 1, y: 2 });

    simpleCell.set({ x: 3, y: 4 });
    expect(c.get()).toEqual({ x: 3, y: 4 });

    simpleCell.send({ x: 5, y: 6 });
    expect(c.get()).toEqual({ x: 5, y: 6 });
  });

  it("should create a simple cell for nested properties", () => {
    const c = cell({ nested: { value: 42 } });
    const nestedCell = c.asRendererCell(["nested", "value"]);

    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should support the key method for nested access", () => {
    const c = cell({ a: { b: { c: 42 } } });
    const simpleCell = c.asRendererCell();

    const nestedCell = simpleCell.key("a").key("b").key("c");
    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should return a Sendable for stream aliases", async () => {
    const c = cell({ stream: { $stream: true } });
    const streamCell = c.asRendererCell(["stream"]);

    expect(streamCell).toHaveProperty("send");
    expect(streamCell).not.toHaveProperty("get");
    expect(streamCell).not.toHaveProperty("set");
    expect(streamCell).not.toHaveProperty("key");

    let lastEventSeen = "";
    let eventCount = 0;

    addEventHandler(
      event => {
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

  it("should call sink only when the cell changes on the subpath", () => {
    const c = cell({ a: { b: 42, c: 10 }, d: 5 });
    const values: number[] = [];
    c.asRendererCell(["a", "b"]).sink(value => values.push(value));
    c.setAtPath(["d"], 50);
    c.setAtPath(["a", "c"], 100);
    c.setAtPath(["a", "b"], 42);
    c.setAtPath(["a", "b"], 300);
    expect(values).toEqual([42, 300]);
    expect(c.get()).toEqual({ a: { b: 300, c: 100 }, d: 50 });
  });
});

describe("asRendererCell with schema", () => {
  it("should validate and transform according to schema", () => {
    const c = cell({
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
        },
      },
    } satisfies JsonSchema;

    const rendererCell = c.asRendererCell([], undefined, schema);
    const value = rendererCell.get();

    expect(value.name).toBe("test");
    expect(value.age).toBe(42);
    expect(value.tags).toEqual(["a", "b"]);
    expect(value.nested.value).toBe(123);
  });

  it("should return RendererCell for reference properties", () => {
    const c = cell({
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
          reference: true,
        },
      },
    } satisfies JsonSchema;

    const rendererCell = c.asRendererCell([], undefined, schema);
    const value = rendererCell.get();

    expect(value.id).toBe(1);
    expect(isRendererCell(value.metadata)).toBe(true);

    // The metadata cell should behave like a normal cell
    const metadataValue = value.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });

  it("should handle recursive schemas with $ref", () => {
    const c = cell({
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
    } satisfies JsonSchema;

    const rendererCell = c.asRendererCell([], undefined, schema);
    const value = rendererCell.get();

    expect(value.name).toBe("root");
    expect(value.children[0].name).toBe("child1");
    expect(value.children[1].name).toBe("child2");
    expect(value.children[1].children[0].name).toBe("grandchild");
  });

  it("should propagate schema through key() navigation", () => {
    const c = cell({
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
                  reference: true,
                },
              },
            },
            metadata: {
              type: "object",
              reference: true,
            },
          },
        },
      },
    } satisfies JsonSchema;

    const rendererCell = c.asRendererCell([], undefined, schema);
    const userCell = rendererCell.key("user");
    const profileCell = userCell.key("profile");

    const value = profileCell.get();
    expect(value.name).toBe("John");
    expect(isRendererCell(value.settings)).toBe(true);

    // Test that references are preserved through the entire chain
    const userValue = userCell.get();
    expect(isRendererCell(userValue.metadata)).toBe(true);
  });

  it("should fall back to query result proxy when no schema is present", () => {
    const c = cell({
      data: {
        value: 42,
        nested: {
          str: "hello",
        },
      },
    });

    const rendererCell = c.asRendererCell();
    const value = rendererCell.get();

    // Should behave like a query result proxy
    expect(value.data.value).toBe(42);
    expect(value.data.nested.str).toBe("hello");
  });

  it("should allow changing schema with asSchema", () => {
    const c = cell({
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
    } satisfies JsonSchema;

    // Create a schema that marks metadata as a reference
    const referenceSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          reference: true,
        },
      },
    } satisfies JsonSchema;

    const rendererCell = c.asRendererCell([], undefined, initialSchema);
    const value = rendererCell.get();

    // With initial schema, metadata is not a RendererCell
    expect(value.id).toBe(1);
    expect(isRendererCell(value.metadata)).toBe(false);
    expect(value.metadata.createdAt).toBe("2025-01-06");

    // Switch to reference schema
    const referenceCell = rendererCell.asSchema(referenceSchema);
    const refValue = referenceCell.get();

    // Now metadata should be a RendererCell
    expect(refValue.id).toBe(1);
    expect(isRendererCell(refValue.metadata)).toBe(true);

    // But we can still get the raw value
    const metadataValue = refValue.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });
});

describe("JSON.stringify bug", () => {
  it("should not modify the value of the cell", () => {
    const c = cell({ result: { data: 1 } }, "json-test");
    const d = cell(
      { internal: { "__#2": { cell: c, path: ["result"] } } },
      "json-test2",
    );
    const e = cell(
      {
        internal: {
          a: { $alias: { cell: d, path: ["internal", "__#2", "data"] } },
        },
      },
      "json-test3",
    );
    const proxy = e.getAsQueryResult();
    const y = proxy.internal;
    const x = proxy.internal.a;
    const json = JSON.stringify(proxy);
    expect(json).toEqual('{"internal":{"a":1}}');
    expect(JSON.stringify(c.get())).toEqual('{"result":{"data":1}}');
    expect(JSON.stringify(d.get())).toEqual(
      `{"internal":{"__#2":{"cell":${JSON.stringify(c.entityId)},"path":["result"]}}}`,
    );
    expect(JSON.stringify(e.get())).toEqual(
      `{"internal":{"a":{"$alias":{"cell":${JSON.stringify(d.entityId)},"path":["internal","__#2","data"]}}}}`,
    );
  });
});
