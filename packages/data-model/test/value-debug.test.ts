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
 * `value-debug-cases.test.ts` checks; what is tested here is what a case
 * file cannot express.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  CompactDebugStringOptions,
  DebugValueOptions,
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
    // a value at the top level, and the `maxLength` behavior at more than one
    // length.

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

    describe("with `maxDepth`", () => {
      it("renders to the given depth rather than to the default", () => {
        const value = { a: { b: { c: 1 } } };
        expect(toCompactDebugString(value, { maxDepth: 2 })).toBe("{a:...}");
        expect(toCompactDebugString(value, { maxDepth: 3 })).toBe(
          "{a:{b:...}}",
        );
      });

      it("renders past the default depth given `Infinity`", () => {
        let value: unknown = "leaf";
        for (let i = 0; i < 20; i++) value = { o: value };
        expect(toCompactDebugString(value, { maxDepth: Infinity }))
          .toContain('"leaf"');
        expect(toIndentedDebugString(value, { maxDepth: Infinity }))
          .toContain('"leaf"');
      });

      it("throws given a `maxDepth` that is not a positive integer", () => {
        expect(() => toCompactDebugString({}, { maxDepth: 0 }))
          .toThrow("`maxDepth` must be a positive integer, `Infinity`, or");
      });
    });

    describe("with `maxArrayLength`", () => {
      it("renders the elements below the limit, and the array's length in place of the rest", () => {
        expect(toCompactDebugString([1, 2, 3, 4, 5], { maxArrayLength: 3 }))
          .toBe("[1,2,3,... length: 5]");
        expect(toCompactDebugString({ a: [1, 2, 3] }, { maxArrayLength: 2 }))
          .toBe("{a:[1,2,... length: 3]}");
      });

      it("renders an array whose length is the limit whole", () => {
        expect(toCompactDebugString([1, 2, 3], { maxArrayLength: 3 }))
          .toBe("[1,2,3]");
      });

      it("renders only the holes below the limit of a run of holes which crosses it", () => {
        expect(toCompactDebugString([1, , , , , 6], { maxArrayLength: 3 }))
          .toBe("[1,<2 holes>,... length: 6]");
        expect(toCompactDebugString([1, , , , , 6], { maxArrayLength: 2 }))
          .toBe("[1,<hole>,... length: 6]");
        expect(toCompactDebugString([1, , 3, , , , 7], { maxArrayLength: 4 }))
          .toBe("[1,<hole>,3,<hole>,... length: 7]");
      });

      it("renders no more than 100 elements when the limit is not given", () => {
        const value = Array.from({ length: 101 }, (_, i) => i);
        expect(toCompactDebugString(value)).toMatch(
          /,99,\.\.\. length: 101\]$/,
        );
      });

      it("throws given a `maxArrayLength` that is not a positive integer", () => {
        expect(() => toCompactDebugString([], { maxArrayLength: 0 })).toThrow(
          "`maxArrayLength` must be a positive integer, `Infinity`, or",
        );
      });
    });

    describe("with `maxStringLength`", () => {
      it("renders an excerpt of the string, and the string's length after it", () => {
        expect(toCompactDebugString("abcdefgh", { maxStringLength: 5 }))
          .toBe('"abcde" + ... length: 8');
        expect(toCompactDebugString({ s: "abcdefgh" }, { maxStringLength: 5 }))
          .toBe('{s:"abcde" + ... length: 8}');
      });

      it("renders a string whose length is the limit whole", () => {
        expect(toCompactDebugString("abcde", { maxStringLength: 5 }))
          .toBe('"abcde"');
      });

      it("renders no more than 200 characters when the limit is not given", () => {
        expect(toCompactDebugString("x".repeat(250)))
          .toMatch(/^"x{200}" \+ \.\.\. length: 250$/);
      });

      it("throws given a `maxStringLength` that is not a positive integer", () => {
        expect(() => toCompactDebugString("", { maxStringLength: 0 })).toThrow(
          "`maxStringLength` must be a positive integer, `Infinity`, or",
        );
      });
    });

    describe("with `maxStringLines`", () => {
      it("renders the string's first lines, and the string's length after them", () => {
        expect(toCompactDebugString("a\nb\nc", { maxStringLines: 2 }))
          .toBe('"a\\nb" + ... length: 5');
        expect(toCompactDebugString({ s: "a\nb\nc" }, { maxStringLines: 2 }))
          .toBe('{s:"a\\nb" + ... length: 5}');
      });

      it("renders a string whose line count is the limit whole", () => {
        expect(toCompactDebugString("a\nb", { maxStringLines: 2 }))
          .toBe('"a\\nb"');
      });

      it("renders no more than 5 lines when the limit is not given", () => {
        expect(toCompactDebugString("a\nb\nc\nd\ne\nf"))
          .toBe('"a\\nb\\nc\\nd\\ne" + ... length: 11');
      });

      it("throws given a `maxStringLines` that is not a positive integer", () => {
        expect(() => toCompactDebugString("", { maxStringLines: 0 })).toThrow(
          "`maxStringLines` must be a positive integer, `Infinity`, or",
        );
      });
    });

    describe("with a `replacer`", () => {
      it("renders the replacement in place of the original value", () => {
        const options: CompactDebugStringOptions = {
          replacer: (value) => (value === 1 ? "one" : value),
        };
        expect(toCompactDebugString({ a: 1, b: 2 }, options))
          .toBe('{a:"one",b:2}');
      });
    });

    it("throws given `options` that are not a plain object", () => {
      expect(() =>
        toCompactDebugString({}, 20 as unknown as CompactDebugStringOptions)
      ).toThrow("`options` must be a plain object or `undefined`; got `20`");
    });
  });

  describe("toIndentedDebugString", () => {
    it("renders a top-level scalar the same as the compact form does", () => {
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
        new FabricEpochNsec(123n),
      ];
      for (const value of values) {
        expect(toIndentedDebugString(value)).toBe(toCompactDebugString(value));
      }
    });

    it("renders to the given depth rather than to the default", () => {
      const value = { a: { b: 1 } };
      expect(toIndentedDebugString(value, { maxDepth: 2 }))
        .toBe("{\n  a: ...\n}");
    });

    it("renders the array's length on its own line in place of the elements past the limit", () => {
      expect(toIndentedDebugString([1, , , 4, 5], { maxArrayLength: 3 }))
        .toBe("[\n  1,\n  <2 holes>,\n  ... length: 5\n]");
    });

    it("renders a string's excerpt and length in the string's place", () => {
      expect(toIndentedDebugString({ s: "abcdefgh" }, { maxStringLength: 5 }))
        .toBe('{\n  s: "abcde" + ... length: 8\n}');
    });

    it("renders a string's first lines and length in the string's place", () => {
      expect(toIndentedDebugString({ s: "a\nb\nc" }, { maxStringLines: 2 }))
        .toBe('{\n  s: "a\\nb" + ... length: 5\n}');
    });

    it("renders the replacement in place of the original value", () => {
      const options: DebugValueOptions = {
        replacer: (value) => (value === 1 ? "one" : value),
      };
      expect(toIndentedDebugString({ a: 1 }, options)).toBe('{\n  a: "one"\n}');
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
      expect(Deno.inspect(bytes)).toBe("/Bytes(buf [010203])");
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
      expect(Deno.inspect({ blob: bytes })).toBe("{ blob: /Bytes(buf [09]) }");
      expect(Deno.inspect([bytes, bytes]))
        .toBe("[ /Bytes(buf [09]), /Bytes(buf [09]) ]");
    });
  });
});
