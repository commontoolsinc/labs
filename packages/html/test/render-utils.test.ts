/**
 * The two render-utility contracts a renderer depends on and neither the name
 * nor the signature states.
 *
 * `setPropDefault` compares under `Object.is` rather than `===`, which decides
 * two cases that differ from each other: `NaN` over a stored `NaN` is
 * unchanged and must not assign, while `-0` over `0` is a change and must.
 * The bound matters because a custom element commonly re-renders on any
 * property assignment, so a redundant write is a visible cost rather than a
 * wasted one.
 *
 * `styleObjectToCssString` is pinned across the cases where a plausible
 * implementation quietly does the wrong thing: a unitless property, a zero, a
 * vendor prefix, a custom property (which keeps its case and takes no unit),
 * and a `null` or `undefined` value, which drops rather than rendering.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { setPropDefault, styleObjectToCssString } from "../src/render-utils.ts";

describe("render-utils", () => {
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

  describe("styleObjectToCssString", () => {
    it("converts camelCase property names to kebab-case", () => {
      expect(
        styleObjectToCssString({
          backgroundColor: "red",
          fontSize: "16px",
          marginTop: "10px",
        }),
      ).toBe("background-color: red; font-size: 16px; margin-top: 10px");
    });

    it("adds px to numeric values", () => {
      expect(styleObjectToCssString({ width: 100, marginTop: 10 })).toBe(
        "width: 100px; margin-top: 10px",
      );
    });

    it("leaves unitless properties without px", () => {
      expect(
        styleObjectToCssString({
          opacity: 0.5,
          zIndex: 10,
          fontWeight: 700,
          lineHeight: 1.5,
          flexGrow: 2,
        }),
      ).toBe(
        "opacity: 0.5; z-index: 10; font-weight: 700; line-height: 1.5; " +
          "flex-grow: 2",
      );
    });

    it("writes zero without a unit", () => {
      expect(styleObjectToCssString({ margin: 0, padding: 0, width: 0 })).toBe(
        "margin: 0; padding: 0; width: 0",
      );
    });

    it("expands vendor prefixes into leading-dash form", () => {
      expect(
        styleObjectToCssString({
          WebkitTransform: "rotate(45deg)",
          webkitBoxShadow: "0 0 5px black",
          mozAppearance: "none",
        }),
      ).toBe(
        "-webkit-transform: rotate(45deg); -webkit-box-shadow: 0 0 5px black; " +
          "-moz-appearance: none",
      );
    });

    it("drops null and undefined values", () => {
      expect(
        styleObjectToCssString({
          color: "red",
          backgroundColor: null,
          fontSize: undefined,
          margin: "10px",
        }),
      ).toBe("color: red; margin: 10px");
    });

    it("leaves custom properties uppercased and unitless", () => {
      expect(
        styleObjectToCssString({
          "--myColor": "blue",
          "--spacing": 16,
          "--Custom-Prop": "value",
        }),
      ).toBe("--myColor: blue; --spacing: 16; --Custom-Prop: value");
    });

    it("passes complex values through unchanged", () => {
      expect(
        styleObjectToCssString({
          background: "linear-gradient(to right, red, blue)",
          transform: "translateX(10px) rotate(45deg)",
          gridTemplateColumns: "repeat(3, 1fr)",
        }),
      ).toBe(
        "background: linear-gradient(to right, red, blue); " +
          "transform: translateX(10px) rotate(45deg); " +
          "grid-template-columns: repeat(3, 1fr)",
      );
    });

    it("produces the empty string for an empty object", () => {
      expect(styleObjectToCssString({})).toBe("");
    });
  });
});
