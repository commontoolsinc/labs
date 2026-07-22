import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { setPropDefault, stringifyText } from "../src/render-utils.ts";

describe("setPropDefault", () => {
  it("does not re-assign an unchanged NaN property", () => {
    // The write guard uses `Object.is` semantics: an incoming `NaN` over a
    // stored `NaN` is unchanged, and must not trigger a property set (custom
    // elements often re-render on any property assignment).
    let sets = 0;
    const target = {
      _value: NaN,
      get value(): number {
        return this._value;
      },
      set value(v: number) {
        sets++;
        this._value = v;
      },
    };
    setPropDefault(target, "value", NaN);
    expect(sets).toBe(0);
  });

  it("assigns `-0` over a `0` property (distinct values)", () => {
    const target = { value: 0 };
    setPropDefault(target, "value", -0);
    expect(Object.is(target.value, -0)).toBe(true);
  });
});

describe("stringifyText", () => {
  function captureWarn(): { calls: unknown[][]; restore(): void } {
    const calls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    return { calls, restore: () => (console.warn = original) };
  }

  it("JSON-renders a $alias-shaped record with a warning, not empty text", () => {
    // `$alias` records are Pattern-binding vocabulary; in data they are inert
    // plain values. The old unresolved-alias special case rendered them as
    // empty text; now they warn and JSON-render like any unexpected object.
    const aliasRecord = { $alias: { path: ["x"] } };
    const spy = captureWarn();
    let text: string;
    try {
      text = stringifyText(aliasRecord);
    } finally {
      spy.restore();
    }
    expect(text).toBe(JSON.stringify(aliasRecord));
    expect(spy.calls.length).toBe(1);
  });
});
