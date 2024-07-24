import { equal as assertEqual } from "node:assert/strict";
import state from "../state.js";
import { effect, render, isReactive } from "../reactive.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("isReactive", () => {
  it("returns true for any object with a sink method", () => {
    const a = state(0);
    assertEqual(isReactive(a), true);

    class B {
      sink() {}
    }

    assertEqual(isReactive(new B()), true);
  });

  it("returns false for objects without a sink method", () => {
    assertEqual(isReactive({}), false);
  });
});

describe("effect()", () => {
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

describe("render()", () => {
  it("runs callback for nonreactive values", async () => {
    let calls = 0;
    render(10, (_value: number) => {
      calls++;
    });
    await sleep(1);
    assertEqual(calls, 1);
  });

  it("subscribes callback to `sink` for reactive value", async () => {
    const value = state(10);

    let valueMut = 0;
    render(value, (value: number) => {
      valueMut = value;
    });

    value.send(11);
    value.send(12);

    await sleep(1);

    assertEqual(valueMut, 12);
  });

  it("ends subscription to reactive value when cancel is called", async () => {
    const value = state(10);

    let valueMut = 0;
    const cancel = render(value, (value: number) => {
      valueMut = value;
    });

    value.send(11);
    cancel();
    value.send(12);

    await sleep(1);
    assertEqual(valueMut, 11);
  });

  it("returns a cancel function", () => {
    const cancel = render(10, (_value: number) => {});
    assertEqual(typeof cancel, "function");
  });

  it("runs any returned cleanup function when cancel is run", async () => {
    let calls = 0;
    const cancel = render(10, (_value: number) => {
      const cleanup = () => calls++;
      return cleanup;
    });
    cancel();
    await sleep(1);
    assertEqual(calls, 1);
  });
});
