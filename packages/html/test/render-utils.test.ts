import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { setPropDefault } from "../src/render-utils.ts";

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
