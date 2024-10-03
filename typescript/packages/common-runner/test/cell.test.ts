import { describe, it, expect } from "vitest";
import {
  cell,
  isCell,
  isCellReference,
  isCellProxy,
  ReactivityLog,
} from "../src/cell.js";
import { compactifyPaths } from "../src/utils.js";
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
    const proxy = c.getAsProxy();
    expect(proxy.x).toBe(1);
    expect(proxy.y).toBe(2);
  });

  it("should update cell value through proxy", () => {
    const c = cell({ x: 1, y: 2 });
    const proxy = c.getAsProxy();
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
    const unsink = c.sink((value) => values.push(value));
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
    const proxy = c.getAsProxy();
    expect(isCellProxy(proxy)).toBe(true);
    expect(isCellProxy({})).toBe(false);
  });
});

describe("createProxy", () => {
  it("should create a proxy for nested objects", () => {
    const c = cell({ a: { b: { c: 42 } } });
    const proxy = c.getAsProxy();
    expect(proxy.a.b.c).toBe(42);
  });

  it("should support regular assigments", () => {
    const c = cell({ x: 1 });
    const proxy = c.getAsProxy();
    proxy.x = 2;
    expect(c.get()).toStrictEqual({ x: 2 });
  });

  it("should handle $alias in objects", () => {
    const c = cell({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsProxy();
    expect(proxy.x).toBe(42);
  });

  it("should handle aliases when writing", () => {
    const c = cell<any>({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsProxy();
    proxy.x = 100;
    expect(c.get().y).toBe(100);
  });

  it("should handle nested cells", () => {
    const innerCell = cell(42);
    const outerCell = cell({ x: innerCell });
    const proxy = outerCell.getAsProxy();
    expect(proxy.x).toBe(42);
  });

  it("should handle cell references", () => {
    const c = cell<any>({ x: 42 });
    const ref = { cell: c, path: ["x"] };
    const proxy = c.getAsProxy();
    proxy.y = ref;
    expect(proxy.y).toBe(42);
  });

  it("should handle infinite loops in cell references", () => {
    const c = cell<any>({ x: 42 });
    const ref = { cell: c, path: ["x"] };
    const proxy = c.getAsProxy();
    proxy.x = ref;
    expect(() => proxy.x).toThrow();
  });

  it("should support modifying array methods and log reads and writes", () => {
    const c = cell<any>([]);
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsProxy([], log);
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
    const proxy = c.getAsProxy([], log);
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
    const c = cell({ a: [] as number[] });
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsProxy([], log);
    proxy.a = [3, 1, 2];
    const result = proxy.a.sort();
    expect(result).toEqual([1, 2, 3]);
    expect(proxy.a).toEqual([1, 2, 3]);
  });

  it("should support readonly array methods and log reads", () => {
    const c = cell<any>([1, 2, 3]);
    const log: ReactivityLog = { reads: [], writes: [] };
    const proxy = c.getAsProxy([], log);
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
    const proxy = c.getAsProxy([], log);
    const result = proxy.a.map((x) => x + 1);
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
    const proxy = c.getAsProxy([], log);
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

describe("asSimpleCell", () => {
  it("should create a simple cell interface", () => {
    const c = cell({ x: 1, y: 2 });
    const simpleCell = c.asSimpleCell();

    expect(simpleCell.get()).toEqual({ x: 1, y: 2 });

    simpleCell.set({ x: 3, y: 4 });
    expect(c.get()).toEqual({ x: 3, y: 4 });

    simpleCell.send({ x: 5, y: 6 });
    expect(c.get()).toEqual({ x: 5, y: 6 });
  });

  it("should create a simple cell for nested properties", () => {
    const c = cell({ nested: { value: 42 } });
    const nestedCell = c.asSimpleCell<number>(["nested", "value"]);

    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should support the key method for nested access", () => {
    const c = cell({ a: { b: { c: 42 } } });
    const simpleCell = c.asSimpleCell();

    const nestedCell = simpleCell.key("a").key("b").key("c");
    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should return a Sendable for stream aliases", async () => {
    const c = cell({ stream: { $stream: true } });
    const streamCell = c.asSimpleCell<string>(["stream"]);

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
      { cell: c, path: ["stream"] }
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
    c.asSimpleCell<number>(["a", "b"]).sink((value) => values.push(value));
    c.setAtPath(["d"], 50);
    c.setAtPath(["a", "c"], 100);
    c.setAtPath(["a", "b"], 42);
    c.setAtPath(["a", "b"], 300);
    expect(values).toEqual([42, 300]);
    expect(c.get()).toEqual({ a: { b: 300, c: 100 }, d: 50 });
  });
});
