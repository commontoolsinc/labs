import { describe, it, expect } from "vitest";
import { cell } from "../src/cell.js";

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
});
