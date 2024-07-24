import {
  equal as assertEqual,
  deepEqual as assertDeepEqual,
} from "node:assert/strict";
import { cell, lens } from "../propagator.js";

describe("cell()", () => {
  it("synchronously sets the value", () => {
    const a = cell({ value: 1 });
    a.send(2);
    assertEqual(a.get(), 2);
  });

  it("reacts synchronously when sent a new value", () => {
    const a = cell({ value: 1 });

    let state = 0;
    a.sink((value) => {
      state = value;
    });
    a.send(2);

    assertEqual(state, 2);
  });

  it("has an optional name", () => {
    const a = cell({ value: 1, name: "a" });
    assertEqual(a.name, "a");
  });
});

describe("lens()", () => {
  it("lenses over a cell", () => {
    const x = cell({ value: { a: { b: { c: 10 } } } });

    const c = lens({
      cell: x,
      get: (state) => state.a.b.c,
      update: (state, next) => ({ ...state, a: { b: { c: next } } }),
    });

    c.send(20);

    assertDeepEqual(x.get(), { a: { b: { c: 20 } } });
    assertEqual(c.get(), 20);
  });
});

describe("cell.key()", () => {
  it("returns a typesafe cell that reflects the state of the parent", () => {
    const x = cell({ value: { a: 10 } });
    const a = x.key("a");

    assertEqual(a.get(), 10);
  });

  it("reflects updates from parent to child", () => {
    const x = cell({ value: { a: 10 } });
    const a = x.key("a");

    x.send({ a: 20 });

    assertEqual(a.get(), 20);
  });

  it("reflects updates from child to parent", () => {
    const x = cell({ value: { a: 10 } });
    const a = x.key("a");

    a.send(20);

    assertDeepEqual(x.get(), { a: 20 });
  });

  it("it works for deep derived keys", () => {
    const x = cell({ value: { a: { b: { c: 10 } } } });
    const a = x.key("a");
    const b = a.key("b");
    const c = b.key("c");

    c.send(20);

    assertDeepEqual(x.get(), { a: { b: { c: 20 } } });
    assertDeepEqual(a.get(), { b: { c: 20 } });
    assertDeepEqual(b.get(), { c: 20 });
    assertDeepEqual(c.get(), 20);
  });
});
