import { describe, it, expect } from "vitest";
import { cell, Cell } from "../src/cell.js";
import { lift, curry, propagator } from "../src/lift.js";

// Utility function to flush microtasks
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("lift", () => {
  it("should lift a function", async () => {
    const add = lift((a: number, b: number) => a + b);
    const a = cell<number>(1);
    const b = cell(2);
    const c = add(a, b);
    expect(c.get()).toBe(3);
    a.send(2);
    await flushMicrotasks();
    expect(c.get()).toBe(4);
  });

  it("should lift a function with a path", async () => {
    const add = lift((a: { b: number }, b: number) => a.b + b);
    const a = cell({ b: 1 });
    const b = cell(2);
    const c = add(a, b);
    expect(c.get()).toBe(3);
    a.b.send(2);
    await flushMicrotasks();
    expect(c.get()).toBe(4);
  });

  it("should lift a function with a path and an array in the function", async () => {
    const add = lift((a: { b: number }, b: number[]) => a.b + b[0]);
    const a = cell({ b: 1 });
    const b = cell([2]);
    const c = add(a, b);
    expect(c.get()).toBe(3);
    b[0].send(3);
    await flushMicrotasks();
    expect(c.get()).toBe(4);
  });

  it("should lift a function with a path and an array outside the function", async () => {
    const add = lift((a: number, b: number) => a + b);
    const a = cell({ b: 1 });
    const b = cell([2]);
    const c = add(a.b, b[0]);
    expect(c.get()).toBe(3);
    b[0].send(3);
    await flushMicrotasks();
    expect(c.get()).toBe(4);
  });
});

describe("lift.apply", () => {
  it("should lift a function and support apply", async () => {
    const add = lift((a: number, b: number) => a + b);
    const a = cell<number>(1);
    const b = cell(2);
    const c = cell(0);
    add.apply(a, b, c);
    expect(c.get()).toBe(3);
    a.send(2);
    await flushMicrotasks();
    expect(c.get()).toBe(4);
  });
});

describe("curry", () => {
  it("should curry a function", async () => {
    const a = cell<number>(1);
    const add = curry([a], (a: number, b: number) => a + b);
    const b = cell<number>(2);
    const c = add(b);
    expect(c.get()).toBe(3);
    b.send(3);
    a.send(5);
    await flushMicrotasks();
    expect(c.get()).toBe(8);
  });

  it("should curry a function and support apply", async () => {
    const a = cell<number>(1);
    const add = curry([a], (a: number, b: number) => a + b);
    const b = cell<number>(2);
    const c = cell(0);
    add.apply(b, c);
    expect(c.get()).toBe(3);
    b.send(3);
    a.send(5);
    await flushMicrotasks();
    expect(c.get()).toBe(8);
  });
});

describe("lift with writeable cells", () => {
  it("can be used as a propagator", async () => {
    const add = lift(
      (a: number, b: number, c: { result: number }) => (c.result = a + b)
    );
    const a = cell<number>(1);
    const b = cell<number>(2);
    const c = cell({ result: 0 });
    add(a, b, c);
    expect(c.get()).toStrictEqual({ result: 3 });
    a.send(2);
    await flushMicrotasks();
    expect(c.get()).toStrictEqual({ result: 4 });
  });
});

describe("propagator", () => {
  it("should propagate changes", async () => {
    const a = cell<number>(1);
    const b = cell<number>(2);
    const c = cell(0);
    const add = propagator(
      (a: Cell<number>, b: Cell<number>, c: Cell<number>) =>
        c.send(a.get() + b.get())
    );
    add(a, b, c);
    expect(c.get()).toBe(3);
    a.send(2);
    await flushMicrotasks();
    expect(c.get()).toBe(4);
  });
});
