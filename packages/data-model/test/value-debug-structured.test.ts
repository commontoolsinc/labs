/**
 * Converting an arbitrary value into a `FabricValue` that stands in for it,
 * including the values that resist being converted at all.
 *
 * The conversion is called on whatever is at hand, usually while something is
 * already wrong, so the two properties that matter most are pinned throughout:
 * the result is always a valid `FabricValue`, and a subvalue that cannot be
 * converted costs only itself rather than the whole result. The cases here are
 * arranged by what the input is, and then by the two knobs -- `maxDepth` and
 * `replacer` -- that change what comes back.
 *
 * The marker vocabulary (`/circle`, `/...`, `/function`, `/uniqueSymbol`,
 * `/unconvertible`, and the leading-slash key escape) is deliberately not
 * specified in the source doc comment, so this file is where it is written
 * down.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { toStructuredDebugValue } from "@/value-debug.ts";
import { isValidFabricValue } from "@/type-check.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricLink } from "@/fabric-instances/FabricLink.ts";

/**
 * Makes a plain object carrying a genuine own `__proto__` property. An object
 * literal cannot: `__proto__:` in source repoints the prototype instead of
 * creating a property.
 */
function withOwnProto(): Record<string, unknown> {
  return JSON.parse('{"__proto__": 1, "ok": 2}');
}

describe("toStructuredDebugValue()", () => {
  describe("scalars", () => {
    it("returns a boolean, number, or string unchanged", () => {
      expect(toStructuredDebugValue(true)).toBe(true);
      expect(toStructuredDebugValue(42)).toBe(42);
      expect(toStructuredDebugValue("hello")).toBe("hello");
    });

    it("returns `null` and `undefined` unchanged", () => {
      expect(toStructuredDebugValue(null)).toBe(null);
      expect(toStructuredDebugValue(undefined)).toBe(undefined);
    });

    it("returns a `bigint` unchanged", () => {
      expect(toStructuredDebugValue(42n)).toBe(42n);
      expect(toStructuredDebugValue(-7n)).toBe(-7n);
    });

    it("returns `-0` as `-0` and not as `0`", () => {
      // `toBe` is `Object.is`, which is the only matcher that can tell the two
      // apart; `toEqual` would pass either way.
      expect(toStructuredDebugValue(-0)).toBe(-0);
    });

    it("returns `NaN` and the infinities unchanged", () => {
      const nan = toStructuredDebugValue(NaN);
      expect(typeof nan).toBe("number");
      expect(Number.isNaN(nan)).toBe(true);
      expect(toStructuredDebugValue(Infinity)).toBe(Infinity);
      expect(toStructuredDebugValue(-Infinity)).toBe(-Infinity);
    });
  });

  describe("symbols", () => {
    it("returns a registry-interned symbol unchanged", () => {
      const sym = Symbol.for("a-key");
      expect(toStructuredDebugValue(sym)).toBe(sym);
    });

    it("returns a unique symbol's description under `/uniqueSymbol`", () => {
      expect(toStructuredDebugValue(Symbol("desc")))
        .toEqual({ "/uniqueSymbol": "desc" });
    });

    it("returns `undefined` under `/uniqueSymbol` for an undescribed one", () => {
      const result = toStructuredDebugValue(Symbol());
      expect(Object.keys(result as object)).toEqual(["/uniqueSymbol"]);
      expect((result as Record<string, unknown>)["/uniqueSymbol"])
        .toBe(undefined);
    });
  });

  describe("functions", () => {
    it("returns a named function's name under `/function`", () => {
      expect(toStructuredDebugValue(function foo() {}))
        .toEqual({ "/function": "foo(...)" });
    });

    it("returns `<anonymous>(...)` for a function with no name", () => {
      // A bare arrow assigned to nothing has an empty `name`.
      expect(toStructuredDebugValue((() => () => {})()))
        .toEqual({ "/function": "<anonymous>(...)" });
    });

    it("returns a class under `/function`, classes being functions", () => {
      expect(toStructuredDebugValue(class Foo {}))
        .toEqual({ "/function": "Foo(...)" });
    });
  });

  // Every case here holds at least one value that does not survive conversion
  // unchanged, so that a walk which returned its input untouched would be
  // caught. A container of scalars alone cannot tell the two apart.
  describe("containers", () => {
    it("returns a plain object with its values converted", () => {
      expect(
        toStructuredDebugValue({ a: 1, fn: function foo() {}, m: new Map() }),
      )
        .toEqual({
          a: 1,
          fn: { "/function": "foo(...)" },
          m: { "/Map": "/..." },
        });
    });

    it("returns an array with its elements converted", () => {
      expect(toStructuredDebugValue([1, function foo() {}, new Map()]))
        .toEqual([1, { "/function": "foo(...)" }, { "/Map": "/..." }]);
    });

    it("returns nested containers converted all the way down", () => {
      // The converting value sits at the bottom of an object-array-object
      // chain, so reaching it at all is the assertion.
      expect(toStructuredDebugValue({ a: [{ b: Symbol("deep") }] }))
        .toEqual({ a: [{ b: { "/uniqueSymbol": "deep" } }] });
    });

    it("returns a present-`undefined` property as present", () => {
      const result = toStructuredDebugValue({
        a: undefined,
        m: new Map(),
      }) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(["a", "m"]);
      expect(result.a).toBe(undefined);
      expect(result.m).toEqual({ "/Map": "/..." });
    });

    it("returns a sparse array with its holes still holes", () => {
      const result = toStructuredDebugValue([1, , new Map()]) as unknown[];
      expect(result.length).toBe(3);
      expect(1 in result).toBe(false);
      expect(result[2]).toEqual({ "/Map": "/..." });
    });

    it("returns a null-prototype object as an ordinary plain object", () => {
      // Were it treated as a general instance instead, the result would carry
      // a class-name tag rather than the object's own keys.
      const value = Object.assign(Object.create(null), { m: new Map() });
      expect(toStructuredDebugValue(value)).toEqual({ m: { "/Map": "/..." } });
    });
  });

  describe("plain-object keys", () => {
    it("returns a `/`-prefixed key with one more `/` prepended", () => {
      // Without the escape, a key of `/circle` would be indistinguishable
      // from the cycle marker this module writes.
      expect(toStructuredDebugValue({ "/circle": 3 }))
        .toEqual({ "//circle": 3 });
    });

    it("returns an already-escaped-looking key escaped once more", () => {
      expect(toStructuredDebugValue({ "//circle": 3 }))
        .toEqual({ "///circle": 3 });
    });

    it("returns a reserved key escaped the same way", () => {
      expect(toStructuredDebugValue({ constructor: 1 }))
        .toEqual({ "/constructor": 1 });
      expect(toStructuredDebugValue(withOwnProto()))
        .toEqual({ "/__proto__": 1, ok: 2 });
    });

    it("returns an unreserved key untouched", () => {
      expect(toStructuredDebugValue({ proto: 1, circle: 2 }))
        .toEqual({ proto: 1, circle: 2 });
    });
  });

  describe("fabric values", () => {
    it("returns a `FabricPrimitive` as the very same object", () => {
      const value = new FabricEpochNsec(123n);
      expect(toStructuredDebugValue(value)).toBe(value);
      expect((toStructuredDebugValue({ t: value }) as { t: unknown }).t)
        .toBe(value);
    });

    it("returns a `FabricInstance`'s state under its own tag", () => {
      const value = FabricError.fromNativeError(new Error("boom"));
      const result = toStructuredDebugValue(value) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(["/Error@1"]);
      expect(result["/Error@1"]).toMatchObject({
        type: "Error",
        message: "boom",
      });
    });

    it("returns each `FabricInstance` under the tag of its own class", () => {
      // The tag comes from the value's codec, so a second class must not
      // arrive under the first one's tag.
      const value = new FabricLink({
        id: "of:fid1:abc",
        path: ["x"],
        space: "did:key:z",
      });
      expect(toStructuredDebugValue(value)).toEqual({
        "/Link@1": { id: "of:fid1:abc", path: ["x"], space: "did:key:z" },
      });
    });
  });

  describe("general instances", () => {
    it("returns an informative `toString()` under the class name", () => {
      const date = new Date(0);
      expect(toStructuredDebugValue(date))
        .toEqual({ "/Date": date.toString() });
      expect(toStructuredDebugValue(/ab+c/gi)).toEqual({
        "/RegExp": "/ab+c/gi",
      });
      expect(toStructuredDebugValue(new Error("boom")))
        .toEqual({ "/Error": "Error: boom" });
    });

    it("returns own properties when `toString()` says nothing", () => {
      class Data {
        x = 1;
        y = "two";
      }
      expect(toStructuredDebugValue(new Data()))
        .toEqual({ "/Data": { x: 1, y: "two" } });
    });

    it("returns the result of `toJSON()` in preference to properties", () => {
      class HasJson {
        ignored = "no";
        toJSON() {
          return { j: 1 };
        }
      }
      expect(toStructuredDebugValue(new HasJson()))
        .toEqual({ "/HasJson": { j: 1 } });
    });

    it("returns `/...` rather than `{}` when there is nothing to show", () => {
      // Claiming an empty object about a `Map` would be a lie; `/...` says
      // "contents not represented", which is true.
      expect(toStructuredDebugValue(new Map([["a", 1]])))
        .toEqual({ "/Map": "/..." });
      expect(toStructuredDebugValue(new Set([1, 2])))
        .toEqual({ "/Set": "/..." });
      expect(toStructuredDebugValue(new (class Empty {})()))
        .toEqual({ "/Empty": "/..." });
    });
  });

  describe("with circular references", () => {
    it("returns `/circle` naming the depth of the repeated object", () => {
      const value: Record<string, unknown> = { name: "root" };
      value.self = value;
      expect(toStructuredDebugValue(value))
        .toEqual({ name: "root", self: { "/circle": 0 } });
    });

    it("returns the depth of the ancestor the cycle closes on", () => {
      const inner: Record<string, unknown> = {};
      const middle: Record<string, unknown> = { b: inner };
      inner.up = middle;
      expect(toStructuredDebugValue({ a: middle }))
        .toEqual({ a: { b: { up: { "/circle": 1 } } } });
    });

    it("returns two siblings holding one object as two conversions", () => {
      // Only ancestors count as a cycle. A value reached twice by different
      // paths is shown at both, since identical siblings are an ordinary
      // shape and calling the second one circular would misdescribe it.
      const shared = { s: 1 };
      expect(toStructuredDebugValue({ x: shared, y: shared }))
        .toEqual({ x: { s: 1 }, y: { s: 1 } });
    });
  });

  describe("with `maxDepth`", () => {
    it("returns `/...` and the elided value's kind at the limit", () => {
      expect(toStructuredDebugValue({ a: { b: 1 } }, 2))
        .toEqual({ a: { "/...": "object" } });
      expect(toStructuredDebugValue({ a: [1, 2] }, 2))
        .toEqual({ a: { "/...": "array" } });
    });

    it("returns the elision at the top level given a `maxDepth` of `1`", () => {
      expect(toStructuredDebugValue({ a: 1 }, 1))
        .toEqual({ "/...": "object" });
    });

    it("returns content within the limit unelided", () => {
      // The converting leaf makes this say that conversion reached the
      // bottom, not merely that nothing was elided on the way.
      expect(toStructuredDebugValue({ a: { b: Symbol("leaf") } }, 3))
        .toEqual({ a: { b: { "/uniqueSymbol": "leaf" } } });
    });

    it("returns a `FabricPrimitive` at the limit rather than eliding it", () => {
      // A primitive is atomic, so including it adds no nesting to the result.
      const value = new FabricEpochNsec(123n);
      expect((toStructuredDebugValue({ t: value }, 2) as { t: unknown }).t)
        .toBe(value);
    });

    it("returns a bounded result for a structure deeper than the default", () => {
      let value: unknown = 1;
      for (let i = 0; i < 300; i++) value = { o: value };

      let at = toStructuredDebugValue(value) as Record<string, unknown>;
      let levels = 0;
      while (at && (typeof at === "object") && ("o" in at)) {
        at = at.o as Record<string, unknown>;
        levels++;
      }
      expect(levels).toBe(99);
      expect(at).toEqual({ "/...": "object" });
    });

    it("throws given a `maxDepth` that is not a positive integer", () => {
      for (const bad of [0, -1, 1.5, Infinity, NaN]) {
        expect(() => toStructuredDebugValue({}, bad))
          .toThrow("`maxDepth` must be a positive integer or `undefined`");
      }
    });

    it("throws given a `maxDepth` that is not a number", () => {
      for (const bad of ["3", null, {}]) {
        expect(() => toStructuredDebugValue({}, bad as unknown as number))
          .toThrow("`maxDepth` must be a positive integer or `undefined`");
      }
    });
  });

  describe("with a `replacer`", () => {
    it("returns the replacement in place of the original value", () => {
      const result = toStructuredDebugValue(
        { a: 1, b: 2 },
        undefined,
        (value) => (value === 1 ? "one" : value),
      );
      expect(result).toEqual({ a: "one", b: 2 });
    });

    it("returns a replacement offered for the top-level value", () => {
      const result = toStructuredDebugValue(
        { a: 1 },
        undefined,
        (value) => (typeof value === "object" ? "replaced" : value),
      );
      expect(result).toBe("replaced");
    });

    it("returns the converted replacement, not the replacement verbatim", () => {
      // The replacement re-enters conversion, so a value the replacer hands
      // back still gets escaped, tagged, and depth-limited like any other.
      const result = toStructuredDebugValue(
        { a: 1 },
        undefined,
        (value) => (value === 1 ? new Map() : value),
      );
      expect(result).toEqual({ a: { "/Map": "/..." } });
    });

    it("returns the original value when the `replacer` throws", () => {
      // A failed replacement reads as a refusal to replace rather than as a
      // conversion error, so the rest of the result is unaffected.
      const result = toStructuredDebugValue(
        { a: 1, m: new Map() },
        undefined,
        (value) => {
          if (value === 1) throw new Error("no thanks");
          return value;
        },
      );
      expect(result).toEqual({ a: 1, m: { "/Map": "/..." } });
    });
  });

  describe("with values that resist conversion", () => {
    it("returns `/unconvertible` carrying the error message", () => {
      const value = {
        get boom(): number {
          throw new Error("getter blew up");
        },
      };
      expect(toStructuredDebugValue(value))
        .toEqual({ "/unconvertible": "getter blew up" });
    });

    it("returns the failure in place, leaving siblings converted", () => {
      const value = {
        before: "kept",
        bad: {
          get boom(): number {
            throw new Error("getter blew up");
          },
        },
        after: [1, 2],
      };
      expect(toStructuredDebugValue(value)).toEqual({
        before: "kept",
        bad: { "/unconvertible": "getter blew up" },
        after: [1, 2],
      });
    });

    it("returns the failure in place for a throwing proxy trap", () => {
      // The traps differ in where they are reached from, so each has to be
      // caught close enough to the value to cost only that value.
      const traps: ProxyHandler<object>[] = [
        {
          getPrototypeOf() {
            throw new Error("nope");
          },
        },
        {
          ownKeys() {
            throw new Error("nope");
          },
        },
        {
          get() {
            throw new Error("nope");
          },
        },
      ];

      for (const trap of traps) {
        const value = { a: 1, bad: new Proxy({ k: 1 }, trap), z: 2 };
        expect(toStructuredDebugValue(value)).toEqual({
          a: 1,
          bad: { "/unconvertible": "nope" },
          z: 2,
        });
      }
    });

    it("returns the failure in place for a non-callable `toString`", () => {
      const value = Object.assign(new (class Odd {})(), { toString: 5 });
      const result = toStructuredDebugValue({ bad: value, z: 2 }) as Record<
        string,
        Record<string, unknown>
      >;
      expect(Object.keys(result.bad!)).toEqual(["/unconvertible"]);
      expect(result.z).toBe(2);
    });
  });

  describe("the `FabricValue` result contract", () => {
    it("returns a valid `FabricValue` for every shape it handles", () => {
      // The contract is what the two shipped bugs broke: a unique symbol's
      // payload and a reserved key each produced a result the membership
      // check refuses.
      const cyclic: Record<string, unknown> = { name: "root" };
      cyclic.self = cyclic;

      const values: unknown[] = [
        undefined,
        null,
        -0,
        NaN,
        42n,
        Symbol("desc"),
        Symbol(),
        Symbol.for("interned"),
        () => {},
        [1, , 3],
        withOwnProto(),
        { "/circle": 1 },
        cyclic,
        new Date(0),
        new Map([["a", 1]]),
        new Set([1]),
        new FabricEpochNsec(123n),
        FabricError.fromNativeError(new Error("boom")),
        {
          bad: new Proxy({}, {
            ownKeys: () => {
              throw new Error("x");
            },
          }),
        },
        { deep: { deeper: { deepest: [1, { s: Symbol("x") }] } } },
      ];

      for (const value of values) {
        expect(isValidFabricValue(toStructuredDebugValue(value))).toBe(true);
      }
    });
  });
});
