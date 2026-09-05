/**
 * Rendering a value for a human to read, including the values that resist
 * being rendered.
 *
 * A debug renderer is called on whatever is at hand, usually while something
 * is already wrong, so it has to survive input that would defeat an ordinary
 * serializer: a cycle, a value that refuses to be rendered, a structure too
 * large to print whole. Producing something useful and bounded matters more
 * than producing something complete, which is what the length limit is for.
 *
 * The compact and indented forms differ only in spacing, while the kind string
 * names what a value is without rendering it at all. The custom inspector is
 * how all of this reaches a `console.log()`. The renderings themselves are
 * recorded as case files under `value-debug-cases/`, which
 * `value-debug-cases.test.ts` checks, a file's `/options` binding covering the
 * renderings under other than the default options; what is tested here is
 * what a case file cannot express.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type CompactDebugStringOptions,
  type DebugValueOptions,
} from "@/interface.ts";
import {
  toCompactDebugString,
  toDebugKindString,
  toIndentedDebugString,
} from "@/value-debug.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricLink } from "@/fabric-instances/FabricLink.ts";
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";

describe("value-debug", () => {
  describe("toCompactDebugString", () => {
    // The renderings themselves are recorded as case files in
    // `value-debug-cases/`. What is here is what a case file cannot express:
    // a value at the top level against the same value nested, the `maxLength`
    // behavior at more than one length, and the options that are refused.

    it("renders a top-level value the same as it renders that value in an array", () => {
      function foo() {}
      const values = [
        undefined,
        null,
        true,
        42,
        -0,
        NaN,
        42n,
        "str",
        Symbol.for("k"),
        Symbol("d"),
        foo,
        new Set(),
        new FabricEpochNsec(123n),
      ];
      for (const value of values) {
        const nested = toCompactDebugString([value]);
        expect(toCompactDebugString(value)).toBe(nested.slice(1, -1));
      }
    });

    describe("with `maxLength`", () => {
      it("renders the full text given a `maxLength` of `Infinity`", () => {
        const item = { text: "x".repeat(200) };
        expect(toCompactDebugString(item, { maxLength: Infinity }))
          .toBe(toCompactDebugString(item));
      });

      for (const len of [10, 25, 100]) {
        it("renders the full text when `maxLength` fits the whole thing", () => {
          const item = ["xy", NaN];
          const expected = '["xy",NaN]'; // Note: Length 10.
          expect(toCompactDebugString(item, { maxLength: len })).toBe(expected);
        });

        it("truncates to `maxLength` when it is smaller than the whole rendered length", () => {
          const largeString = "This is a very large string! ".repeat(40);
          const item = { a: 123, b: 456, c: 789, d: largeString };
          const whole = toCompactDebugString(item);
          const expected = whole.slice(0, len - 3) + "...";
          expect(whole.length).toBeGreaterThan(len);
          expect(toCompactDebugString(item, { maxLength: len })).toBe(expected);
          expect(toCompactDebugString(item, { maxLength: len }).length).toBe(
            len,
          );
        });
      }
    });

    describe("with `backtickQuote`", () => {
      it("renders the truncated result as the code span, when both are asked for", () => {
        const options = { maxLength: 8, backtickQuote: true };
        expect(toCompactDebugString({ abc: "defghij" }, options))
          .toBe("`{abc:...`");
      });

      it("renders the result bare when the option is `false` or absent", () => {
        expect(toCompactDebugString({ a: 1 }, { backtickQuote: false }))
          .toBe("{a:1}");
        expect(toCompactDebugString({ a: 1 })).toBe("{a:1}");
      });
    });

    it("throws given a limit that is not a positive integer", () => {
      const names = [
        "maxDepth",
        "maxArrayLength",
        "maxProperties",
        "maxStringLength",
        "maxStringLines",
      ];
      for (const name of names) {
        expect(() => toCompactDebugString({}, { [name]: 0 })).toThrow(
          `\`${name}\` must be a positive integer, \`Infinity\`, or`,
        );
      }
    });

    it("throws given `options` that are not a plain object", () => {
      expect(() =>
        toCompactDebugString({}, 20 as unknown as CompactDebugStringOptions)
      ).toThrow("`options` must be a plain object or `undefined`; got `20`");
    });
  });

  describe("toIndentedDebugString", () => {
    it("renders a top-level scalar the same as the compact form does", () => {
      const values = [
        undefined,
        null,
        true,
        42,
        -0,
        NaN,
        42n,
        "str",
        Symbol.for("k"),
        Symbol("d"),
        new FabricEpochNsec(123n),
      ];
      for (const value of values) {
        expect(toIndentedDebugString(value)).toBe(toCompactDebugString(value));
      }
    });

    describe("with a string holding a line break", () => {
      it("renders each line quoted on a line of its own, joined by ` +`", () => {
        expect(toIndentedDebugString("a\nb\nc"))
          .toBe('"a\\n" +\n  "b\\n" +\n  "c"');
      });

      it("renders the lines after the first one level further in than the value", () => {
        expect(toIndentedDebugString({ s: "a\nb" }))
          .toBe('{\n  s: "a\\n" +\n    "b"\n}');
        expect(toIndentedDebugString({ o: { s: "a\nb" } }))
          .toBe('{\n  o: {\n    s: "a\\n" +\n      "b"\n  }\n}');
        expect(toIndentedDebugString(["a\nb"]))
          .toBe('[\n  "a\\n" +\n    "b"\n]');
      });

      it("renders a carriage return, with or without a newline, as a line break", () => {
        expect(toIndentedDebugString("a\r\nb\rc"))
          .toBe('"a\\r\\n" +\n  "b\\r" +\n  "c"');
      });

      it("renders a string ending in a line break with no empty line after it", () => {
        expect(toIndentedDebugString("a\nb\n")).toBe('"a\\n" +\n  "b\\n"');
        expect(toIndentedDebugString("a\n")).toBe('"a\\n"');
      });

      it("renders a class instance's `toString()` form the same way", () => {
        class Foo {
          toString() {
            return "a\nb";
          }
        }
        expect(toIndentedDebugString({ foo: new Foo() }))
          .toBe('{\n  foo: /Foo("a\\n" +\n    "b")\n}');
      });
    });

    it("throws given `options` that are not a plain object", () => {
      expect(() =>
        toIndentedDebugString({}, null as unknown as DebugValueOptions)
      ).toThrow("`options` must be a plain object or `undefined`; got `null`");
    });
  });

  describe("toDebugKindString", () => {
    it("renders `null` and `undefined` literally", () => {
      expect(toDebugKindString(null)).toBe("null");
      expect(toDebugKindString(undefined)).toBe("undefined");
    });

    it("renders plain objects as 'object'", () => {
      expect(toDebugKindString({})).toBe("object");
      expect(toDebugKindString({ a: 1 })).toBe("object");
      expect(toDebugKindString(Object.create(null))).toBe("object");
    });

    it("renders arrays as 'array'", () => {
      expect(toDebugKindString([])).toBe("array");
      expect(toDebugKindString([1, 2, 3])).toBe("array");
    });

    it("renders JS primitives as their typeof", () => {
      expect(toDebugKindString(42)).toBe("number");
      expect(toDebugKindString(42n)).toBe("bigint");
      expect(toDebugKindString("hi")).toBe("string");
      expect(toDebugKindString(true)).toBe("boolean");
      expect(toDebugKindString(Symbol("s"))).toBe("symbol");
      expect(toDebugKindString(() => {})).toBe("function");
    });

    it("renders FabricInstance subclasses with their constructor name", () => {
      expect(toDebugKindString(FabricError.fromNativeError(new Error("x"))))
        .toBe("FabricInstance (FabricError)");
      expect(toDebugKindString(new FabricMap(new Map())))
        .toBe("FabricInstance (FabricMap)");
    });

    it("renders FabricPrimitive subclasses with their constructor name", () => {
      expect(toDebugKindString(new FabricEpochNsec(123n)))
        .toBe("FabricPrimitive (FabricEpochNsec)");
      expect(toDebugKindString(new FabricBytes(new Uint8Array([1, 2, 3]))))
        .toBe("FabricPrimitive (FabricBytes)");
      expect(toDebugKindString(new FabricRegExp(/abc/g)))
        .toBe("FabricPrimitive (FabricRegExp)");
    });

    it("renders a non-`FabricSpecialObject` instance with its constructor name", () => {
      expect(toDebugKindString(new Date())).toBe("Date");
      expect(toDebugKindString(new Map())).toBe("Map");
      expect(toDebugKindString(new Set())).toBe("Set");
      expect(toDebugKindString(new Error("oops"))).toBe("Error");
      expect(toDebugKindString(/abc/)).toBe("RegExp");

      class Foo {}
      expect(toDebugKindString(new Foo())).toBe("Foo");
    });

    it("falls back to 'object' when constructor name is unavailable", () => {
      // An object whose prototype was sliced out has no usable
      // `constructor` chain; the predicate returns "object" as a final
      // fallback.

      const weird = Object.create({ constructor: undefined as unknown });
      expect(toDebugKindString(weird)).toBe("object");
    });
  });

  describe("custom inspector", () => {
    // Without the inspector these all render as `{}`: state lives in private
    // fields, which have no enumerable own properties for an inspector to find.

    it("renders a FabricPrimitive as its debug string, not `{}`", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(Deno.inspect(bytes)).toBe("/Bytes(buf[010203])");
    });

    it("renders a FabricInstance as its debug string, not `{}`", () => {
      const link = new FabricLink({
        id: "of:fid1:abc",
        path: ["x"],
        space: "did:key:z",
      });
      expect(Deno.inspect(link))
        .toBe('/Link(id:"of:fid1:abc",path:["x"],space:"did:key:z")');
    });

    it("renders when nested in containers", () => {
      const bytes = new FabricBytes(new Uint8Array([9]));
      expect(Deno.inspect({ blob: bytes })).toBe("{ blob: /Bytes(buf[09]) }");
      expect(Deno.inspect([bytes, bytes]))
        .toBe("[ /Bytes(buf[09]), /Bytes(buf[09]) ]");
    });
  });
});
