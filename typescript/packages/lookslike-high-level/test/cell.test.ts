import { describe, it, expect } from "vitest";
import { cell, self, isCell, ReactivityLog } from "../src/runtime/cell.js";
import { isSignal, WriteableSignal } from "@commontools/common-frp/signal";
import { idle } from "../src/runtime/scheduler.js";

describe("cell", () => {
  it("should create a cell", () => {
    const c = cell(1);
    expect(c.getAsValue()).toBe(1);
  });

  it("should create a cell with a path", () => {
    const c = cell({ a: { b: 1 } });
    expect(c.a.b.getAsValue()).toBe(1);
  });

  it("should update a cell", async () => {
    const c = cell(1);
    c.send(2);
    await idle();
    expect(c.getAsValue()).toBe(2);
  });

  it("should update a cell with a path", async () => {
    const c = cell({ a: { b: 1 } });
    const b = c.a.b;
    b.send(2);
    await idle();
    expect(c.getAsValue()).toStrictEqual({ a: { b: 2 } });
    expect(c.a.getAsValue()).toStrictEqual({ b: 2 });
    expect(c.a.b.getAsValue()).toBe(2);
    expect(b.getAsValue()).toBe(2);
  });

  it("should work with get or send in the path", async () => {
    const c = cell({ get: { send: 1 } });
    expect(c.get.send.getAsValue()).toBe(1);
    c.get.send.send(2);
    await idle();
    expect(c.get.send.getAsValue()).toBe(2);
  });

  it("should work for arrays as well", async () => {
    const c = cell([1, 2, 3]);
    expect(c[0].getAsValue()).toBe(1);
    c[1].send(4);
    await idle();
    expect(c.getAsValue()).toStrictEqual([1, 4, 3]);
  });

  it("should subscribe to updates", async () => {
    const c = cell(1);
    let updated = false;
    c.updates({
      send: () => (updated = true),
    });
    c.send(2);
    await idle();
    expect(updated).toEqual(true);
  });

  it("is still a signal", () => {
    const c: WriteableSignal<number> = cell(1);
    expect(isSignal(c)).toBe(true);
  });

  it("is still a signal when an array", () => {
    const c: WriteableSignal<number[]> = cell([1, 2]);
    expect(isSignal(c)).toBe(true);
  });
});

describe("nested cells", async () => {
  it("get should work with nested cells", async () => {
    const a = cell(1);
    const c = cell({ a });
    expect(c.a.getAsValue()).toBe(1);
    a.send(2);
    await idle();
    expect(a.getAsValue()).toStrictEqual(2);
    expect(c.getAsValue()).toStrictEqual({ a: 2 });
  });

  it("set should work with nested cells", async () => {
    const a = cell(1);
    const c = cell({ a });
    expect(c.a.getAsValue()).toBe(1);
    c.a.send(2);
    await idle();
    expect(a.getAsValue()).toStrictEqual(2);
    expect(c.getAsValue()).toStrictEqual({ a: 2 });
  });

  it("set should work with nested cells that are complex", async () => {
    const a = cell({ value: 1 });
    const c = cell({ a });
    expect(c.a.getAsValue()).toStrictEqual({ value: 1 });
    c.a.send({ value: 2 });
    await idle();
    expect(a.getAsValue()).toStrictEqual({ value: 2 });
    expect(c.getAsValue()).toStrictEqual({ a: { value: 2 } });
  });

  it("set should work with assigning different cells", async () => {
    const a = cell({ value: 1 });
    const b = cell({ value: 2 });
    const c = cell({ a });
    expect(c.a.getAsValue()).toStrictEqual({ value: 1 });
    c.a.send(b);
    await idle();
    expect(a.getAsValue()).toStrictEqual({ value: 1 });
    expect(b.getAsValue()).toStrictEqual({ value: 2 });
    expect(c.getAsValue()).toStrictEqual({ a: { value: 2 } });
    expect(c.a.getAsValue()).toStrictEqual({ value: 2 });
  });

  it("set should work with assigning different cells that are complex", async () => {
    const a = cell({ value: 1 });
    const b = cell({ a });
    const c = cell({ b });
    expect(c.b.getAsValue()).toStrictEqual({ a: { value: 1 } });
    c.b.send({ a: cell({ value: 2 }) });
    await idle();
    expect(a.getAsValue()).toStrictEqual({ value: 1 });
    expect(b.getAsValue()).toStrictEqual({ a: { value: 2 } });
    expect(c.getAsValue()).toStrictEqual({ b: { a: { value: 2 } } });
    expect(c.b.a.getAsValue()).toStrictEqual({ value: 2 });
  });
});

describe("cellValueProxy", () => {
  it("should act as the value of a cell", () => {
    const c = cell(1);
    expect(c.getAsValue()).toBe(1);
  });

  it("should act as the value of a nested cell", () => {
    const c = cell({ a: cell(2) });
    expect(c.getAsValue()).toStrictEqual({ a: 2 });
  });

  it("should act as the value of a deep nested values", () => {
    const c = cell({ a: { b: 2 } });
    expect(c.getAsValue()).toStrictEqual({ a: { b: 2 } });
  });

  it("should act as the value of a deep nested cell", () => {
    const c = cell({ a: cell({ b: 2 }) });
    expect(c.getAsValue()).toStrictEqual({ a: { b: 2 } });
  });

  it("should support setting the value of a cell", async () => {
    const c = cell({ a: { b: 1 } });
    c.getAsValue().a.b = 2;
    await idle();
    expect(c.a.b.getAsValue()).toBe(2);
  });

  it("should support setting the value of a cell to another cell", async () => {
    const c = cell({ a: { b: 1 } });
    c.getAsValue().a = cell({ b: 2 });
    await idle();
    expect(c.getAsValue()).toStrictEqual({ a: { b: 2 } });
  });

  it("should support setting the value of a cell to another cell value", async () => {
    const c = cell({ a: { b: 1 } });
    c.getAsValue().a = cell({ b: 2 }).getAsValue();
    await idle();
    expect(c.getAsValue()).toStrictEqual({ a: { b: 2 } });
  });

  it("should support setting the value of a cell to another nested cell", async () => {
    const c = cell({ a: { b: 1 } });
    c.getAsValue().a = cell({ a: { b: 2 } }).a;
    await idle();
    expect(c.getAsValue()).toStrictEqual({ a: { b: 2 } });
  });

  it("should support setting the value of a cell to another nested cell value", async () => {
    const c = cell({ a: { b: 1 } });
    c.getAsValue().a = cell({ a: { b: 2 } }).a.getAsValue();
    await idle();
    expect(c.getAsValue()).toStrictEqual({ a: { b: 2 } });
  });

  it("should allow setting the value via self", async () => {
    const c = cell({ a: 1, b: 0 });
    c.getAsValue()[self] = { a: 0, b: 2 };
    await idle();
    expect(c.getAsValue()).toStrictEqual({ a: 0, b: 2 });
  });

  it("shouldn't break when setting at different levels", async () => {
    const b = cell({ b: 2 });
    const c = cell({ a: { b: 1 } });
    c.getAsValue().a = b;
    c.getAsValue().a.b = b.b;
    await idle();
    expect(c.getAsValue()).toStrictEqual({ a: { b: 2 } });
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
    expect(d.getAsValue()).toStrictEqual({
      a: { value: 0 },
      b: { value: 0 },
      c: { nested: { value: 0 } },
    });

    d.getAsValue().a = a; // works for both: cells and ...
    d.getAsValue().b = b.getAsValue(); // ... cell values
    d.getAsValue().c = c;
    d.getAsValue().c.nested = c.nested; // including nested
    await idle();
    expect(d.getAsValue()).toStrictEqual({
      a: { value: 2 },
      b: { value: 3 },
      c: { nested: { value: 4 } },
    });

    a.send({ value: 4 });
    b.send({ value: cell(5) });
    c.nested.send(cell({ value: 6 }));
    await idle();
    expect(d.getAsValue()).toStrictEqual({
      a: { value: 4 },
      b: { value: 5 },
      c: { nested: { value: 6 } },
    });

    // And now the other direction!
    d.getAsValue().a = { value: 7 };
    d.getAsValue().b = { value: cell(8) };
    d.getAsValue().c.nested.value = 9;
    await idle();
    expect(d.getAsValue()).toStrictEqual({
      a: { value: 7 },
      b: { value: 8 },
      c: { nested: { value: 9 } },
    });
    expect(a.getAsValue()).toStrictEqual({ value: 7 });
    expect(b.getAsValue()).toStrictEqual({ value: 8 });
    expect(c.getAsValue()).toStrictEqual({ nested: { value: 9 } });

    // And also use the proxy to set the values
    a.getAsValue().value = 10;
    b.getAsValue().value = cell(11);
    c.getAsValue().nested = cell({ value: 12 }).getAsValue();
    await idle();
    expect(d.getAsValue()).toStrictEqual({
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
    const value = c.withLog(log).getAsValue();
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
    const value = c.a.b.withLog(log).getAsValue();
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

describe("raw cell", () => {
  it("should not modify nested values in raw cells", async () => {
    const c = cell<any>(undefined).raw();
    c.send({ a: { b: 1 } });
    const v = c.get();
    expect(v).toStrictEqual({ a: { b: 1 } });
    expect(isCell(v.a)).toBe(false);
    expect(isCell(v.a.b)).toBe(false);
  });

  it("should not support getAsValue on raw cells", async () => {
    const c = cell(1);
    const rawC = c.raw();
    expect(typeof rawC.get === "function").toBe(true);
    expect(typeof c.getAsValue === "function").toBe(true);
    expect(typeof rawC.getAsValue === "function").toBe(false);
  });

  it("should return cells on .get() (i.e. return the raw cell)", async () => {
    const c = cell({ a: { b: 1 } });
    const v = c.get();
    expect(isCell(v)).toBe(false);
    expect(isCell(v.a)).toBe(true);
    expect(isCell(v.a.b)).toBe(false);
    expect(isCell<{ b: number }>(v.a) && v.a.get().b).toBe(1);
  });
});
