import * as assert from "node:assert/strict";
import { state, State, shouldUpdate } from "../state.js";

describe("shouldUpdate", () => {
  it("returns true if no causes are out of date, and at least one is newer", () => {
    const curr = { a: 1, b: 1 };
    const next = { a: 1, b: 2 };
    assert.equal(shouldUpdate(curr, next), true);
  });

  it("returns false if all causes are equal", () => {
    const curr = { a: 1, b: 1 };
    const next = { a: 1, b: 1 };
    assert.equal(shouldUpdate(curr, next), false);
  });

  it("returns false any cause is out of date", () => {
    const curr = { a: 1, b: 2 };
    const next = { a: 1, b: 1 };
    assert.equal(shouldUpdate(curr, next), false);
  });
});

describe("State", () => {
  it("includes itself in the causes", () => {
    const a = new State({ value: 1 });
    assert.equal(Object.hasOwn(a.causes, a.id), true);
  });
});

describe("State.step()", () => {
  it("creates the next state", () => {
    const a = state({ value: 1 });
    const b = a.step(2);
    assert.notEqual(a, b);
    assert.equal(b.value, 2);
    assert.equal(a.id, b.id);
    assert.equal(a.time, b.time - 1);
  });

  it("returns the current state if the values are equal", () => {
    const a = state({ value: 1 });
    const b = a.step(1);
    assert.equal(a, b);
  });
});

describe("State.merge()", () => {
  it("advances to newer states", () => {
    const a = state({ value: 1 });
    const b = a.step(2);
    const c = a.merge(b);
    assert.equal(b, c);
  });

  it("advances to newer states (2)", () => {
    const a = state({ value: 1 });
    const b = state({ value: 2 });
    const c = state({ value: 3 });

    const d = state({
      value: a.value + b.value + c.value,
      causes: { ...a.causes, ...b.causes, ...c.causes },
    });

    const b2 = b.step(4);

    const d2 = state({
      id: d.id,
      value: a.value + b2.value + c.value,
      causes: { ...a.causes, ...b2.causes, ...c.causes },
    });

    const d3 = d.merge(d2);

    assert.equal(d2, d3);
  });

  it("ignores a state that is out of date", () => {
    const a = state({ value: 1, time: 2 });
    const b = state({ id: a.id, value: 5, time: 0 });
    const c = a.merge(b);
    assert.equal(a, c);
  });

  it("ignores a state that is out of date (2)", () => {
    const a = state({ value: 1 });
    const b = state({ id: a.id, value: 5 });
    const c = a.merge(b);
    assert.equal(a, c);
  });
});

describe("State.key()", () => {
  it("it returns a new state for the key of the value", () => {
    const a = state({ value: { b: 1 } });
    const b = a.key("b");
    assert.notEqual(a, b);
    assert.equal(b.value, 1);
  });

  it("carries forward the causes of the parent state", () => {
    const a = state({ value: { b: 1 }, causes: { z: 1 } });
    const b = a.key("b");
    assert.equal(b.causes.z, 1);
  });
});
