import { describe, it, expect } from "vitest";
import { cell } from "../src/cell.js";
import { lift } from "../src/lift.js";

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
    const add = lift((a: { b: number }, b: number) => {
      console.log("lifted", a, b);
      return a.b + b;
    });
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
