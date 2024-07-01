import { describe, it, expect } from "vitest";
import { cell } from "../src/cell.js";
import { isSignal, WriteableSignal } from "@commontools/common-frp/signal";

// Utility function to flush microtasks
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("cell", () => {
  it("should create a cell", () => {
    const c = cell(1);
    expect(c.get()).toBe(1);
  });

  it("should create a cell with a path", () => {
    const c = cell({ a: { b: 1 } });
    expect(c.a.b.get()).toBe(1);
  });

  it("should update a cell", async () => {
    const c = cell<number>(1);
    c.send(2);
    await flushMicrotasks();
    expect(c.get()).toBe(2);
  });

  it("should update a cell with a path", async () => {
    const c = cell({ a: { b: 1 } });
    const b = c.a.b;
    b.send(2);
    await flushMicrotasks();
    expect(c.get()).toStrictEqual({ a: { b: 2 } });
    expect(c.a.get()).toStrictEqual({ b: 2 });
    expect(c.a.b.get()).toBe(2);
    expect(b.get()).toBe(2);
  });

  it("should work with get or send in the path", async () => {
    const c = cell({ get: { send: 1 } });
    expect(c.get.send.get()).toBe(1);
    c.get.send.send(2);
    await flushMicrotasks();
    expect(c.get.send.get()).toBe(2);
  });

  it("should work for arrays as well", async () => {
    const c = cell([1, 2, 3]);
    expect(c[0].get()).toBe(1);
    c[1].send(4);
    await flushMicrotasks();
    expect(c.get()).toStrictEqual([1, 4, 3]);
  });

  it("should subscribe to updates", async () => {
    const c = cell<number>(1);
    let updated = false;
    c.updates({
      send: () => (updated = true),
    });
    c.send(2);
    await flushMicrotasks();
    expect(updated).toEqual(true);
  });

  it("is still a signal", () => {
    const c: WriteableSignal<number> = cell<number>(1);
    expect(isSignal(c)).toBe(true);
  });
});

describe("nested cells", async () => {
  it("get should work with nested cells", async () => {
    const a = cell<number>(1);
    const c = cell({ a });
    expect(c.a.get()).toBe(1);
    a.send(2);
    await flushMicrotasks();
    expect(a.get()).toStrictEqual(2);
    expect(c.get()).toStrictEqual({ a: 2 });
  });

  it("set should work with nested cells", async () => {
    const a = cell<number>(1);
    const c = cell({ a });
    expect(c.a.get()).toBe(1);
    c.a.send(2);
    await flushMicrotasks();
    expect(a.get()).toStrictEqual(2);
    expect(c.get()).toStrictEqual({ a: 2 });
  });

  it("set should work with nested cells that are complex", async () => {
    const a = cell({ value: 1 });
    const c = cell({ a });
    expect(c.a.get()).toStrictEqual({ value: 1 });
    c.a.send({ value: 2 });
    await flushMicrotasks();
    expect(a.get()).toStrictEqual({ value: 2 });
    expect(c.get()).toStrictEqual({ a: { value: 2 } });
  });

  it("set should work with assigning different cells", async () => {
    const a = cell({ value: 1 });
    const b = cell({ value: 2 });
    const c = cell({ a });
    expect(c.a.get()).toStrictEqual({ value: 1 });
    c.a.send(b);
    await flushMicrotasks();
    expect(a.get()).toStrictEqual({ value: 1 });
    expect(b.get()).toStrictEqual({ value: 2 });
    expect(c.get()).toStrictEqual({ a: { value: 2 } });
    expect(c.a.get()).toStrictEqual({ value: 2 });
  });

  it("set should work with assigning different cells that are complex", async () => {
    const a = cell({ value: 1 });
    const b = cell({ a });
    const c = cell({ b });
    expect(c.b.get()).toStrictEqual({ a: { value: 1 } });
    c.b.send({ a: cell({ value: 2 }) });
    await flushMicrotasks();
    expect(a.get()).toStrictEqual({ value: 1 });
    expect(b.get()).toStrictEqual({ a: { value: 2 } });
    expect(c.get()).toStrictEqual({ b: { a: { value: 2 } } });
    expect(c.b.a.get()).toStrictEqual({ value: 2 });
  });
});
