import {
  equal as assertEqual,
  deepEqual as assertDeepEqual,
} from "node:assert/strict";
import { cell, lens, lift } from "../propagator.js";
import { setDebug } from "../logger.js";

setDebug(true);

const sleep = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cell()", () => {
  it("sets the value", async () => {
    const a = cell(1);
    a.send(2);
    await sleep();
    assertEqual(a.get(), 2);
  });

  it("reacts when sent a new value", async () => {
    const a = cell(1);

    let state = 0;
    a.sink((value) => {
      state = value;
    });
    a.send(2);

    await sleep();
    assertEqual(state, 2);
  });

  it("has an optional name", () => {
    const a = cell(1, "a");
    assertEqual(a.name, "a");
  });
});

describe("lens()", () => {
  it("lenses over a cell", async () => {
    const x = cell({ a: { b: { c: 10 } } }, "x");

    const c = lens(x, {
      get: (state) => state.a.b.c,
      update: (state, next) => ({ ...state, a: { b: { c: next } } }),
    });

    assertEqual(c.get(), 10);

    c.send(20);
    await sleep();
    assertDeepEqual(x.get(), { a: { b: { c: 20 } } });
    assertEqual(c.get(), 20);
  });
});

describe("cell.key()", () => {
  it("returns a typesafe cell that reflects the state of the parent", () => {
    const x = cell({ a: 10 });
    const a = x.key("a");

    assertEqual(a.get(), 10);
  });

  it("reflects updates from parent to child", async () => {
    const x = cell({ a: 10 });
    const a = x.key("a");

    x.send({ a: 20 });

    await sleep();
    assertEqual(a.get(), 20);
  });

  it("reflects updates from child to parent", async () => {
    const x = cell({ a: 10 });
    const a = x.key("a");

    a.send(20);

    await sleep();
    assertDeepEqual(x.get(), { a: 20 });
  });

  it("it works for deep derived keys", async () => {
    const x = cell({ a: { b: { c: 10 } } });
    const a = x.key("a");
    const b = a.key("b");
    const c = b.key("c");

    c.send(20);

    await sleep(2);
    assertDeepEqual(x.get(), { a: { b: { c: 20 } } });
    assertDeepEqual(a.get(), { b: { c: 20 } });
    assertDeepEqual(b.get(), { c: 20 });
    assertDeepEqual(c.get(), 20);
  });
});

describe("lift()", () => {
  it("lifts a function into a function that reads from and writes to cells", () => {
    const addCells = lift((a: number, b: number) => a + b);

    const a = cell(1, "lift.a");
    const b = cell(2, "lift.b");
    const out = cell(0, "lift.out");

    const cancel = addCells(a, b, out);

    assertEqual(typeof cancel, "function", "returns a cancel function");

    assertEqual(out.get(), 3);
  });

  it("updates the out cell whenever an input cell updates", async () => {
    const addCells = lift((a: number, b: number) => a + b);

    const a = cell(1, "a");
    const b = cell(1, "b");
    const out = cell(0, "out");

    addCells(a, b, out);
    assertEqual(out.get(), 2);

    a.send(2);

    await sleep();
    assertEqual(out.get(), 3);

    b.send(2);

    await sleep();
    assertEqual(out.get(), 4);
  });

  it("solves the diamond problem", () => {
    const addCells = lift((a: number, b: number) => a + b);

    const a = cell(1, "a");
    const out = cell(0, "out");

    addCells(a, a, out);
    assertEqual(out.get(), 2);

    let calls = 0;
    out.sink((_value) => {
      calls++;
    });

    a.send(2);
    assertEqual(out.get(), 4);

    assertEqual(
      calls,
      2,
      "calls neighbors once per upstream output of the diamond",
    );
  });

  it("solves the diamond problem (2)", () => {
    const add3 = lift((a: number, b: number, c: number) => a + b + c);

    const a = cell(1, "a");
    const b = cell(1, "b");
    const out = cell(0, "out");

    add3(a, b, b, out);
    assertEqual(out.get(), 3);

    let calls = 0;
    out.sink((_value) => {
      calls++;
    });

    b.send(2);
    assertEqual(out.get(), 5);

    assertEqual(
      calls,
      2,
      "calls neighbors once per upstream output of the diamond",
    );
  });

  it("solves the diamond problem for mapped values", () => {
    const add2 = lift((a: number, b: number) => a + b);
    const sq = lift((x: number) => x * x);

    const a = cell(2, "diamond3a");
    const b = cell(0, "diamond3b");

    sq(a, b);
    assertEqual(b.get(), 4);

    const c = cell(0, "diamond3c");
    add2(a, b, c);
    assertEqual(c.get(), 6);

    let calls = 0;
    c.sink((_value) => {
      calls++;
    });

    a.send(4);
    assertEqual(c.get(), 20);

    assertEqual(
      calls,
      2,
      "calls neighbors once per upstream output of the diamond",
    );
  });
});
