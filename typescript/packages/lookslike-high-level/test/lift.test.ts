import { describe, it, expect } from "vitest";
import { cell, Cell } from "../src/cell.js";
import { lift, curry, asHandler, handler, propagator } from "../src/lift.js";

// Utility function to flush microtasks
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("lift", () => {
  it("should lift a function", async () => {
    const add = lift((a: number, b: number) => a + b);
    const a = cell(1);
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
    expect(b[0].get()).toBe(2);
    expect(c.get()).toBe(3);
    b[0].send(3);
    await flushMicrotasks();
    expect(c.get()).toBe(4);
  });

  it("should work with destructing assignment", async () => {
    const nameSplit = lift((name: string) => {
      const [first, last] = name.split(" ", 2);
      return { first, last };
    });
    const name = cell("John Doe");
    const { first, last } = nameSplit(name);
    expect(first.get()).toBe("John");
    expect(last.get()).toBe("Doe");
  });

  it("should work with structured arguments", async () => {
    const nameSplit = lift(({ name }) => {
      const [first, last] = name.split(" ", 2);
      return { first, last };
    });
    const name = cell("John Doe");
    const { first, last } = nameSplit({ name });
    expect(first.get()).toBe("John");
    expect(last.get()).toBe("Doe");
  });
});

describe("lift.apply", () => {
  it("should lift a function and support apply", async () => {
    const add = lift((a: number, b: number) => a + b);
    const a = cell(1);
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
    const a = cell(1);
    const add = curry([a], (a: number, b: number) => a + b);
    const b = cell(2);
    const c = add(b);
    expect(c.get()).toBe(3);
    b.send(3);
    a.send(5);
    await flushMicrotasks();
    expect(c.get()).toBe(8);
  });

  it("should curry a function and support apply", async () => {
    const a = cell(1);
    const add = curry([a], (a: number, b: number) => a + b);
    const b = cell(2);
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
    const a = cell(1);
    const b = cell(2);
    const c = cell({ result: 0 });
    add(a, b, c);
    expect(c.get()).toStrictEqual({ result: 3 });
    a.send(2);
    await flushMicrotasks();
    expect(c.get()).toStrictEqual({ result: 4 });
  });
});

describe("lift with partial reads and so partial updates", () => {
  it("shouldn't be called again if the value wasn't read", async () => {
    let runCount = 0;
    const c = cell({ a: cell(1), b: cell(2) });
    const justA = lift((input) => {
      runCount++;
      return input.a;
    });
    const a = justA(c);
    expect(a.get()).toBe(1);
    expect(runCount).toBe(1);
    c.b.send(3);
    await flushMicrotasks();
    expect(runCount).toBe(1);
    c.a.send(4);
    await flushMicrotasks();
    expect(a.get()).toBe(4);
    expect(runCount).toBe(2);
  });
});

describe("handler", () => {
  it("create handler with asHandler and use it", async () => {
    const a = cell({ value: 1 });
    const h = asHandler((e: number, a: { value: number }) => (a.value += e));
    const s = h(a);
    s.send(2);
    await flushMicrotasks();
    expect(a.get()).toStrictEqual({ value: 3 });
  });

  it("create handler with handler and use it", async () => {
    const a = cell({ value: 1 });
    const s = handler([a], (e: number, a: { value: number }) => (a.value += e));
    s.send(2);
    await flushMicrotasks();
    expect(a.get()).toStrictEqual({ value: 3 });
  });
});

describe("propagator", () => {
  it("should propagate changes", async () => {
    const a = cell(1);
    const b = cell(2);
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
