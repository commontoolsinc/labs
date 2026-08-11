import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createDefaultJsonRegistry,
  jsonFromValue,
  plainObjectFromJson,
  valueFromJson,
} from "@/codecs.ts";
import { seemsLikeJsonEncodedFabricValue } from "@/codec-json/impl.ts";
import { JsonCodec } from "@/codec-json/JsonCodec.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import type { FabricValue } from "@/fabric-value.ts";
import { BaseReconstructionContext } from "@/codec-common/BaseReconstructionContext.ts";

/** Mock runtime for deserialization calls. */
class MockRuntime extends BaseReconstructionContext {
  constructor() {
    super(true);
  }

  override getCell(): never {
    throw new Error("getCell not implemented in test runtime");
  }
}
const mockRuntime = new MockRuntime();

/** Encodes and then decodes a value, per the current dispatch configuration. */
function roundTrip(value: FabricValue): FabricValue {
  return valueFromJson(jsonFromValue(value), mockRuntime);
}

/**
 * Asserts that encoding a value produces the expected JSON wire format,
 * compared as parsed structure, after stripping the modern encoding prefix.
 */
function expectWireFormat(value: FabricValue, expected: unknown): void {
  const json = jsonFromValue(value);
  expect(seemsLikeJsonEncodedFabricValue(json)).toBe(true);
  expect(
    JSON.parse(JsonCodec.unwrapEncodedValueForTesting(json)),
  ).toEqual(expected);
}

describe("codecs", () => {
  describe("`createDefaultJsonRegistry()`", () => {
    it("returns a frozen registry", () => {
      expect(Object.isFrozen(createDefaultJsonRegistry())).toBe(true);
    });

    it("registers this package's fabric classes on top of the base", () => {
      const registry = createDefaultJsonRegistry();
      const value = FabricError.fromNativeError(new Error("boom"));

      // The base alone reports `undefined` here; see
      // `createBaseJsonRegistry.test.ts`.
      expect(registry.codecFromValue(value)).toBeDefined();
    });
  });

  it("round-trips `undefined`", () => {
    expect(roundTrip(undefined)).toBe(undefined);
  });

  it("round-trips `bigint`", () => {
    expect(roundTrip(42n)).toBe(42n);
  });

  it("`jsonFromValue()` encodes `undefined` to tagged JSON", () => {
    expectWireFormat(undefined, { "/Undefined@1": null });
  });

  it("`jsonFromValue()` encodes `bigint` to tagged JSON", () => {
    expectWireFormat(42n, { "/BigInt@1": "Kg" });
  });

  it("`valueFromJson()` decodes tagged `undefined`", () => {
    const json = 'fvj1:{"\/Undefined@1":null}';
    expect(valueFromJson(json, mockRuntime)).toBe(undefined);
  });

  it("`valueFromJson()` decodes tagged `bigint`", () => {
    const json = 'fvj1:{"\/BigInt@1":"Kg"}';
    expect(valueFromJson(json, mockRuntime)).toBe(42n);
  });

  it("round-trips plain objects", () => {
    const value = { a: 1, b: "two" };
    expect(roundTrip(value)).toEqual({ a: 1, b: "two" });
  });

  it("round-trips arrays", () => {
    const value = [1, "two", null];
    expect(roundTrip(value)).toEqual([1, "two", null]);
  });

  it("round-trips `null`", () => {
    expect(roundTrip(null)).toBe(null);
  });

  it("JSON-safe primitives stringify normally (under the encoding prefix)", () => {
    expect(jsonFromValue(42)).toBe("fvj1:42");
    expect(jsonFromValue("hello")).toBe('fvj1:"hello"');
    expect(jsonFromValue(true)).toBe("fvj1:true");
    expect(jsonFromValue(null)).toBe("fvj1:null");
  });

  describe("edge case", () => {
    it("round-trips object with slash-prefixed key", () => {
      const value = { "/foo": "bar" };
      expect(roundTrip(value)).toEqual({ "/foo": "bar" });
    });

    it("decoded objects are frozen", () => {
      const value = { a: 1, b: "two" };
      expect(Object.isFrozen(roundTrip(value))).toBe(true);
    });

    it("decoded arrays are frozen", () => {
      const value = [1, 2, 3];
      expect(Object.isFrozen(roundTrip(value))).toBe(true);
    });

    it("round-trips nested object with special types", () => {
      const value = {
        name: "test",
        count: 42n,
        missing: undefined,
      };
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.name).toBe("test");
      expect(decoded.count).toBe(42n);
      expect(decoded.missing).toBe(undefined);
    });
  });

  describe("slash-prefixed keys and legacy markers", () => {
    it('`{ "/": value }` round-trips via `/object` escaping', () => {
      // Arbitrary object-valued `/` key (not a link). Write path wraps in
      // /object, read path unwraps it.
      const slashObject = {
        "/": { kind: "widget", tags: ["a", "b"], size: 3 },
      };
      expect(roundTrip(slashObject)).toEqual(slashObject);
    });

    it('nested `{ "/": value }` within object round-trips', () => {
      const value = {
        name: "test",
        slashKeyed: { "/": { inner: { flag: true }, count: 0 } },
      };
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.name).toBe("test");
      expect(decoded.slashKeyed).toEqual(
        { "/": { inner: { flag: true }, count: 0 } },
      );
    });

    it('`{ "/": "string" }` round-trips via `/object` escaping', () => {
      // An arbitrary string-valued `/` key — not an entity ref; exercises the
      // escaping for the `/` key per se.
      const slashKeyed = { "/": "an arbitrary string" };
      expect(roundTrip(slashKeyed)).toEqual(slashKeyed);
    });

    it("`$stream` marker passes through unchanged", () => {
      const value = { $stream: true };
      expect(roundTrip(value)).toEqual({ $stream: true });
    });

    it("`@Error` marker passes through unchanged", () => {
      const value = {
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      };
      expect(roundTrip(value)).toEqual({
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      });
    });

    it('`$alias` marker with nested `{ "/": value }` round-trips', () => {
      const value = {
        $alias: {
          path: ["value", "name"],
          cell: { "/": "an arbitrary string" },
        },
      };
      expect(roundTrip(value)).toEqual({
        $alias: {
          path: ["value", "name"],
          cell: { "/": "an arbitrary string" },
        },
      });
    });

    it("mixed value with fabric types and slash-keys round-trips", () => {
      const value = {
        count: 42n,
        slashKeyed: { "/": { values: [1, 2, 3], note: "hello" } },
        items: [1, { "/": "another arbitrary string" }, undefined],
      };
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.count).toBe(42n);
      expect(decoded.slashKeyed).toEqual(
        { "/": { values: [1, 2, 3], note: "hello" } },
      );
      expect((decoded.items as unknown[])[0]).toBe(1);
      expect((decoded.items as unknown[])[1]).toEqual({
        "/": "another arbitrary string",
      });
      expect((decoded.items as unknown[])[2]).toBe(undefined);
    });

    it('`{ "/": value }` inside array round-trips', () => {
      const value = [
        { "/": { count: 1 } },
        { "/": { labels: ["x"], ready: true } },
      ];
      expect(roundTrip(value)).toEqual(value);
    });
  });

  describe("`valueFromJson()` without a runtime argument", () => {
    it("decodes a plain object", () => {
      expect(valueFromJson('fvj1:{"a":1}')).toEqual({ a: 1 });
    });

    it("decodes a primitive", () => {
      expect(valueFromJson("fvj1:42")).toBe(42);
    });

    it("decodes tagged values that don't need cell reconstruction", () => {
      expect(valueFromJson('fvj1:{"\/Undefined@1":null}')).toBe(undefined);
      expect(valueFromJson('fvj1:{"\/BigInt@1":"Kg"}')).toBe(42n);
    });

    it("explicit `undefined` runtime is equivalent to omission", () => {
      expect(valueFromJson('fvj1:{"a":1}', undefined)).toEqual({ a: 1 });
    });
  });

  describe("plainObjectFromJson", () => {
    it("returns the decoded plain object", () => {
      const json = jsonFromValue({ a: 1, b: 42n });
      const result = plainObjectFromJson<{ a: number; b: bigint }>(json);
      expect(result.a).toBe(1);
      expect(result.b).toBe(42n);
    });

    it("throws on a class instance (`FabricError`)", () => {
      const err = FabricError.fromNativeError(new Error("test"));
      const json = jsonFromValue(err);
      expect(() => plainObjectFromJson(json)).toThrow(/instance/);
    });

    it("throws on an array", () => {
      const json = jsonFromValue(["whoops"]);
      expect(() => plainObjectFromJson(json)).toThrow(/array/);
    });

    for (const prim of [null, 123, "florp", true]) {
      it(`throws on primitive \`${prim}\``, () => {
        const json = jsonFromValue(prim);
        expect(() => plainObjectFromJson(json)).toThrow(/primitive/);
      });
    }
  });
});
