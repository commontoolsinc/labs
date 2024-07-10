import { equal as assertEqual } from "node:assert/strict";
import state from "../state.js";
import { effect, isReactive } from "../reactive.js";

describe("isReactive", () => {
  it("returns true for any object with a sink method", () => {
    const a = state(0);
    assertEqual(isReactive(a), true);

    class B {
      sink() {}
    }

    assertEqual(isReactive(new B()), true);
  })

  it("returns false for objects without a sink method", () => {
    assertEqual(isReactive({}), false);
  });
});

describe("effect", () => {
  it("runs callback for nonreactive values", () => {
    let calls = 0;
    effect(10, (_value: number) => {
      calls++;
    });
    assertEqual(calls, 1);
  });

  it("subscribes callback to `sink` for reactive value", () => {
    const value = state(10);

    let valueMut = 0;
    effect(value, (value: number) => {
      valueMut = value;
    });

    value.send(11);
    value.send(12);

    assertEqual(valueMut, 12);
  });

  it("ends subscription to reactive value when cancel is called", () => {
    const value = state(10);

    let valueMut = 0;
    const cancel = effect(value, (value: number) => {
      valueMut = value;
    });
 
    value.send(11);
    cancel();
    value.send(12);

    assertEqual(valueMut, 11);
  });

  it("returns a cancel function", () => {
    const cancel = effect(10, (_value: number) => {});
    assertEqual(typeof cancel, "function");
  });

  it("runs any returned cleanup function when cancel is run", () => {
    let calls = 0;
    const cancel = effect(10, (_value: number) => {
      const cleanup = () => calls++;
      return cleanup;
    });
    cancel();
    assertEqual(calls, 1);
  });
});
