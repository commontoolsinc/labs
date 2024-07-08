import { describe, it, expect } from "vitest";
import { cell, self, isCell, ReactivityLog } from "../src/runtime/cell.js";
import { isSignal, WriteableSignal } from "@commontools/common-frp/signal";
import { idle } from "../src/runtime/scheduler.js";

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
    await idle();
    expect(c.get()).toBe(2);
  });

  it("should update a cell with a path", async () => {
    const c = cell({ a: { b: 1 } });
    const b = c.a.b;
    b.send(2);
    await idle();
    expect(c.get()).toStrictEqual({ a: { b: 2 } });
    expect(c.a.get()).toStrictEqual({ b: 2 });
    expect(c.a.b.get()).toBe(2);
    expect(b.get()).toBe(2);
  });

  it("should work with get or send in the path", async () => {
    const c = cell({ get: { send: 1 } });
    expect(c.get.send.get()).toBe(1);
    c.get.send.send(2);
    await idle();
    expect(c.get.send.get()).toBe(2);
  });

  it("should work for arrays as well", async () => {
    const c = cell([1, 2, 3]);
    expect(c[0].get()).toBe(1);
    c[1].send(4);
    await idle();
    expect(c.get()).toStrictEqual([1, 4, 3]);
  });

  it("should subscribe to updates", async () => {
    const c = cell<number>(1);
    let updated = false;
    c.updates({
      send: () => (updated = true),
    });
    c.send(2);
    await idle();
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
    await idle();
    expect(a.get()).toStrictEqual(2);
    expect(c.get()).toStrictEqual({ a: 2 });
  });

  it("set should work with nested cells", async () => {
    const a = cell<number>(1);
    const c = cell({ a });
    expect(c.a.get()).toBe(1);
    c.a.send(2);
    await idle();
    expect(a.get()).toStrictEqual(2);
    expect(c.get()).toStrictEqual({ a: 2 });
  });

  it("set should work with nested cells that are complex", async () => {
    const a = cell({ value: 1 });
    const c = cell({ a });
    expect(c.a.get()).toStrictEqual({ value: 1 });
    c.a.send({ value: 2 });
    await idle();
    expect(a.get()).toStrictEqual({ value: 2 });
    expect(c.get()).toStrictEqual({ a: { value: 2 } });
  });

  it("set should work with assigning different cells", async () => {
    const a = cell({ value: 1 });
    const b = cell({ value: 2 });
    const c = cell({ a });
    expect(c.a.get()).toStrictEqual({ value: 1 });
    c.a.send(b);
    await idle();
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
    await idle();
    expect(a.get()).toStrictEqual({ value: 1 });
    expect(b.get()).toStrictEqual({ a: { value: 2 } });
    expect(c.get()).toStrictEqual({ b: { a: { value: 2 } } });
    expect(c.b.a.get()).toStrictEqual({ value: 2 });
  });
});

describe("cellValueProxy", () => {
  it("should act as the value of a cell", () => {
    const c = cell(1);
    expect(c.get()).toBe(1);
  });

  it("should act as the value of a nested cell", () => {
    const c = cell({ a: cell(2) });
    expect(c.get()).toStrictEqual({ a: 2 });
  });

  it("should act as the value of a deep nested values", () => {
    const c = cell({ a: { b: 2 } });
    expect(c.get()).toStrictEqual({ a: { b: 2 } });
  });

  it("should act as the value of a deep nested cell", () => {
    const c = cell({ a: cell({ b: 2 }) });
    expect(c.get()).toStrictEqual({ a: { b: 2 } });
  });

  it("should support setting the value of a cell", async () => {
    const c = cell({ a: { b: 1 } });
    c.get().a.b = 2;
    await idle();
    expect(c.a.b.get()).toBe(2);
  });

  it("should support setting the value of a cell to another cell", async () => {
    const c = cell({ a: { b: 1 } });
    c.get().a = cell({ b: 2 });
    await idle();
    expect(c.get()).toStrictEqual({ a: { b: 2 } });
  });

  it("should support setting the value of a cell to another cell value", async () => {
    const c = cell({ a: { b: 1 } });
    c.get().a = cell({ b: 2 }).get();
    await idle();
    expect(c.get()).toStrictEqual({ a: { b: 2 } });
  });

  it("should support setting the value of a cell to another nested cell", async () => {
    const c = cell({ a: { b: 1 } });
    c.get().a = cell({ a: { b: 2 } }).a;
    await idle();
    expect(c.get()).toStrictEqual({ a: { b: 2 } });
  });

  it("should support setting the value of a cell to another nested cell value", async () => {
    const c = cell({ a: { b: 1 } });
    c.get().a = cell({ a: { b: 2 } }).a.get();
    await idle();
    expect(c.get()).toStrictEqual({ a: { b: 2 } });
  });

  it("should allow setting the value via self", async () => {
    const c = cell({ a: 1, b: 0 });
    c.get()[self] = { a: 0, b: 2 };
    await idle();
    expect(c.get()).toStrictEqual({ a: 0, b: 2 });
  });

  it("shouldn't break when setting at different levels", async () => {
    const b = cell({ b: 2 });
    const c = cell({ a: { b: 1 } });
    c.get().a = b;
    c.get().a.b = b.b;
    await idle();
    expect(c.get()).toStrictEqual({ a: { b: 2 } });
  });

  it("should allow setting the value as a cell, both directions", async () => {
    const a = cell({ value: 2 });
    const b = cell({ value: 3 });
    const c = cell({ nested: { value: 4 } });
    const d = cell({
      a: { value: 0 },
      b: { value: 0 },
      c: { nested: { value: 0 } },
    });
    expect(d.get()).toStrictEqual({
      a: { value: 0 },
      b: { value: 0 },
      c: { nested: { value: 0 } },
    });

    d.get().a = a; // works for both: cells and ...
    d.get().b = b.get(); // ... cell values
    d.get().c = c;
    d.get().c.nested = c.nested; // including nested
    await idle();
    expect(d.get()).toStrictEqual({
      a: { value: 2 },
      b: { value: 3 },
      c: { nested: { value: 4 } },
    });

    a.send({ value: 4 });
    b.send({ value: cell(5) });
    c.nested.send(cell({ value: 6 }));
    await idle();
    expect(d.get()).toStrictEqual({
      a: { value: 4 },
      b: { value: 5 },
      c: { nested: { value: 6 } },
    });

    // And now the other direction!
    d.get().a = { value: 7 };
    d.get().b = { value: cell(8) };
    d.get().c.nested.value = 9;
    await idle();
    expect(d.get()).toStrictEqual({
      a: { value: 7 },
      b: { value: 8 },
      c: { nested: { value: 9 } },
    });
    expect(a.get()).toStrictEqual({ value: 7 });
    expect(b.get()).toStrictEqual({ value: 8 });
    expect(c.get()).toStrictEqual({ nested: { value: 9 } });

    // And also use the proxy to set the values
    a.get().value = 10;
    b.get().value = cell(11);
    c.get().nested = cell({ value: 12 }).get();
    await idle();
    expect(d.get()).toStrictEqual({
      a: { value: 10 },
      b: { value: 11 },
      c: { nested: { value: 12 } },
    });
  });
});

describe("toValue logging", async () => {
  it("should log accessing a single cell", async () => {
    const c = cell(1);
    const log: ReactivityLog = { reads: new Set(), writes: new Set() };
    const value = c.withLog(log).get();
    c.withLog(log).send(2);
    await idle();
    expect(value).toBe(1);
    expect(log.reads.size).toBe(1);
    expect(log.writes.size).toBe(1);
    log.reads.forEach((source) => expect(source.get()).toBe(2));
    log.writes.forEach((sink) => expect(sink.get()).toBe(2));
  });

  it("should log accessing nested, structured cells", async () => {
    const c = cell({ a: cell({ b: 1 }) });
    const log: ReactivityLog = { reads: new Set(), writes: new Set() };
    const value = c.a.b.withLog(log).get();
    c.withLog(log).a.b.send(2);
    expect(value).toBe(1); // Number no longer a proxy, so value is unchanged.
    expect(log.reads.size).toBe(2); // Both cells were read to get to inner one
    expect(log.writes.size).toBe(1); // Only the inner cell changed

    // Log has the actual cell, not the proxy, so we need to compare the values
    log.reads.forEach((source) => {
      const v = source.get();
      expect(v.b === 2 || (isCell(v.a) && v.a.get().b === 2)).toBe(true);
    });
    log.writes.forEach((sink) => expect(sink.get()).toStrictEqual({ b: 2 }));
  });
});
