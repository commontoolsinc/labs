import { describe, it, expect } from "vitest";
import {
  cell,
  isCell,
  isCellReference,
  isCellProxy,
  createProxy,
} from "../../src/runner/cell.js";

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
    const proxy = createProxy(c, []);
    expect(proxy.a.b.c).toBe(42);
  });

  it("should handle $ref in objects", () => {
    const c = cell({ x: { $ref: ["y"] }, y: 42 });
    const proxy = createProxy(c, []);
    expect(proxy.x).toBe(42);
  });

  it("should handle nested cells", () => {
    const innerCell = cell(42);
    const outerCell = cell({ x: innerCell });
    const proxy = createProxy(outerCell, []);
    expect(proxy.x).toBe(42);
  });

  it("should handle cell references", () => {
    const c = cell<any>({ x: 42 });
    const ref = { cell: c, path: ["x"] };
    const proxy = createProxy(c, []);
    proxy.y = ref;
    expect(proxy.y).toBe(42);
  });
});
