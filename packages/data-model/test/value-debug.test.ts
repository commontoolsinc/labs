import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toCompactDebugString, toIndentedDebugString } from "../value-debug.ts";

// ============================================================================
// Tests
// ============================================================================

describe("value-debug", () => {
  // --------------------------------------------------------------------------
  // toCompactDebugString
  // --------------------------------------------------------------------------

  describe("toCompactDebugString", () => {
    it("compactly stringifies a plain object", () => {
      expect(toCompactDebugString({ a: 1, b: "two" }))
        .toBe('{"a":1,"b":"two"}');
    });

    it("compactly stringifies an array", () => {
      expect(toCompactDebugString([1, 2, 3])).toBe("[1,2,3]");
    });

    it("stringifies JSON-native primitives", () => {
      expect(toCompactDebugString(42)).toBe("42");
      expect(toCompactDebugString("hello")).toBe('"hello"');
      expect(toCompactDebugString(true)).toBe("true");
      expect(toCompactDebugString(false)).toBe("false");
      expect(toCompactDebugString(null)).toBe("null");
    });

    it("renders top-level `undefined` as a bare token", () => {
      expect(toCompactDebugString(undefined)).toBe("undefined");
    });

    it("renders `undefined` inside an array as a bare token", () => {
      expect(toCompactDebugString([1, undefined, 2]))
        .toBe("[1,undefined,2]");
    });

    it("renders `undefined` as object value as a bare token", () => {
      expect(toCompactDebugString({ a: undefined, b: 1 }))
        .toBe('{"a":undefined,"b":1}');
    });

    it("renders top-level `bigint` as a bare token with `n` suffix", () => {
      expect(toCompactDebugString(42n)).toBe("42n");
    });

    it("renders zero, negative, and large `bigint`s", () => {
      expect(toCompactDebugString(0n)).toBe("0n");
      expect(toCompactDebugString(-42n)).toBe("-42n");
      expect(toCompactDebugString(12345678901234567890n))
        .toBe("12345678901234567890n");
    });

    it("renders `bigint` inside an array as a bare token", () => {
      expect(toCompactDebugString([42n, 7n]))
        .toBe("[42n,7n]");
    });

    it("renders `bigint` as object value as a bare token", () => {
      expect(toCompactDebugString({ n: 42n }))
        .toBe('{"n":42n}');
    });

    it("does not throw on mixed bigint/undefined values", () => {
      const v = {
        count: 100n,
        missing: undefined,
        items: [1n, 2n, undefined],
      };
      expect(() => toCompactDebugString(v)).not.toThrow();
      expect(toCompactDebugString(v))
        .toBe('{"count":100n,"missing":undefined,"items":[1n,2n,undefined]}');
    });

    it("does not unquote ordinary string values that resemble bare tokens", () => {
      // A user string that just happens to read "undefined" or "42n" should
      // remain a quoted string in the output -- only sentinel-wrapped payloads
      // get unquoted.
      expect(toCompactDebugString("undefined"))
        .toBe('"undefined"');
      expect(toCompactDebugString("42n")).toBe('"42n"');
      expect(toCompactDebugString({ a: "undefined" }))
        .toBe('{"a":"undefined"}');
    });

    it("renders a named function as a bare abbreviated form", () => {
      function foo() {}
      expect(toCompactDebugString(foo)).toBe("function foo(...) {...}");
    });

    it("renders a named function inside a structure", () => {
      function bar() {}
      expect(toCompactDebugString({ fn: bar }))
        .toBe('{"fn":function bar(...) {...}}');
      expect(toCompactDebugString([bar]))
        .toBe("[function bar(...) {...}]");
    });

    it("renders an anonymous arrow function as a bare abbreviated form", () => {
      // An immediately-passed arrow expression has no `name`.
      expect(toCompactDebugString((() => 1) as unknown))
        .toBe("(...) => {...}");
    });

    it("renders an anonymous `function` expression as a bare abbreviated form", () => {
      // Force an empty `name` to simulate a true anonymous function expression
      // (`(function(){}).name === ""`).
      const anon = function () {};
      Object.defineProperty(anon, "name", { value: "" });
      expect(toCompactDebugString(anon)).toBe("(...) => {...}");
    });

    it('renders an interned symbol as `Symbol.for("name")`', () => {
      const s = Symbol.for("my-key");
      expect(toCompactDebugString(s)).toBe('Symbol.for("my-key")');
    });

    it("renders an interned symbol inside a structure", () => {
      const s = Symbol.for("k");
      expect(toCompactDebugString({ s })).toBe('{"s":Symbol.for("k")}');
      expect(toCompactDebugString([s])).toBe('[Symbol.for("k")]');
    });

    it('renders an uninterned symbol as `Symbol("name")`', () => {
      expect(toCompactDebugString(Symbol("d"))).toBe('Symbol("d")');
    });

    it("renders an uninterned symbol with no description", () => {
      expect(toCompactDebugString(Symbol())).toBe('Symbol("")');
    });

    it("renders an uninterned symbol inside a structure", () => {
      const s = Symbol("inner");
      expect(toCompactDebugString({ s })).toBe('{"s":Symbol("inner")}');
      expect(toCompactDebugString([s])).toBe('[Symbol("inner")]');
    });

    it("renders top-level `NaN` as a bare token", () => {
      expect(toCompactDebugString(NaN)).toBe("NaN");
      expect(toCompactDebugString(0 / 0)).toBe("NaN");
    });

    it("renders top-level positive `Infinity` as a bare token", () => {
      expect(toCompactDebugString(Infinity)).toBe("Infinity");
      expect(toCompactDebugString(Number.POSITIVE_INFINITY)).toBe("Infinity");
    });

    it("renders top-level negative `Infinity` as a bare token", () => {
      expect(toCompactDebugString(-Infinity)).toBe("-Infinity");
      expect(toCompactDebugString(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
    });

    it("renders top-level negative zero as `-0`", () => {
      expect(toCompactDebugString(-0)).toBe("-0");
    });

    it("still renders ordinary `0` as `0` (not `-0`)", () => {
      expect(toCompactDebugString(0)).toBe("0");
    });

    it("renders non-finite numbers and -0 inside an object", () => {
      const v = { a: NaN, b: Infinity, c: -Infinity, d: -0, e: 1 };
      expect(toCompactDebugString(v))
        .toBe('{"a":NaN,"b":Infinity,"c":-Infinity,"d":-0,"e":1}');
    });

    it("renders non-finite numbers and -0 inside an array", () => {
      expect(toCompactDebugString([NaN, Infinity, -Infinity, -0, 0]))
        .toBe("[NaN,Infinity,-Infinity,-0,0]");
    });

    describe("with `maxLength`", () => {
      for (const len of [10, 25, 100]) {
        it("renders the full text when `maxLength` fits the whole thing", () => {
          const item = ["xy", NaN];
          const expected = '["xy",NaN]'; // Note: Length 10.
          expect(toCompactDebugString(item, len)).toBe(expected);
        });

        it("truncates to `maxLength` when it is smaller than the whole rendered length", () => {
          const largeString = "This is a very large string! ".repeat(40);
          const item = { a: 123, b: 456, c: 789, d: largeString };
          const expected = JSON.stringify(item).slice(0, len - 3) + "...";
          expect(toCompactDebugString(item, len)).toBe(expected);
        });
      }
    });
  });

  // --------------------------------------------------------------------------
  // toIndentedDebugString
  // --------------------------------------------------------------------------

  describe("toIndentedDebugString", () => {
    it("indents object output with 2 spaces", () => {
      expect(toIndentedDebugString({ a: 1, b: "two" }))
        .toBe('{\n  "a": 1,\n  "b": "two"\n}');
    });

    it("indents array output with 2 spaces", () => {
      expect(toIndentedDebugString([1, 2, 3]))
        .toBe("[\n  1,\n  2,\n  3\n]");
    });

    it("renders top-level `undefined` as bare token", () => {
      expect(toIndentedDebugString(undefined)).toBe("undefined");
    });

    it("renders top-level `bigint` as bare token", () => {
      expect(toIndentedDebugString(42n)).toBe("42n");
    });

    it("renders nested `bigint` and `undefined` as bare tokens", () => {
      const v = { n: 42n, m: undefined };
      expect(toIndentedDebugString(v))
        .toBe('{\n  "n": 42n,\n  "m": undefined\n}');
    });

    it("renders `undefined` and `bigint` inside arrays as bare tokens", () => {
      expect(toIndentedDebugString([1n, undefined, 2n]))
        .toBe("[\n  1n,\n  undefined,\n  2n\n]");
    });

    it("renders top-level named function as bare abbreviated form", () => {
      function baz() {}
      expect(toIndentedDebugString(baz)).toBe("function baz(...) {...}");
    });

    it('renders top-level interned symbol as `Symbol.for("name")`', () => {
      expect(toIndentedDebugString(Symbol.for("ind")))
        .toBe('Symbol.for("ind")');
    });

    it("renders nested function and symbol as bare tokens", () => {
      function qux() {}
      const v = { fn: qux, sym: Symbol("s") };
      expect(toIndentedDebugString(v))
        .toBe(
          '{\n  "fn": function qux(...) {...},\n  "sym": Symbol("s")\n}',
        );
    });

    it("renders non-finite numbers and -0 as bare tokens (top-level)", () => {
      expect(toIndentedDebugString(NaN)).toBe("NaN");
      expect(toIndentedDebugString(Infinity)).toBe("Infinity");
      expect(toIndentedDebugString(-Infinity)).toBe("-Infinity");
      expect(toIndentedDebugString(-0)).toBe("-0");
    });

    it("renders non-finite numbers and -0 inside a structure", () => {
      const v = { a: NaN, b: Infinity, c: -Infinity, d: -0 };
      expect(toIndentedDebugString(v))
        .toBe(
          '{\n  "a": NaN,\n  "b": Infinity,\n  "c": -Infinity,\n  "d": -0\n}',
        );
    });
  });
});
