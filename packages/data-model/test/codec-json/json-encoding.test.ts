import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  jsonFromValue,
  plainObjectFromJson,
  seemsLikeJsonEncodedFabricValue,
  valueFromJson,
} from "@/codec-json/json-encoding.ts";
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

/** Encode then decode a value through the current dispatch configuration. */
function roundTrip(value: FabricValue): FabricValue {
  return valueFromJson(jsonFromValue(value), mockRuntime);
}

/**
 * Assert that encoding a value produces the expected JSON wire format
 * (compared as parsed structure, after stripping the modern encoding prefix).
 */
function expectWireFormat(value: FabricValue, expected: unknown): void {
  const PREFIX = "fvj1:";
  const json = jsonFromValue(value);
  expect(json.startsWith(PREFIX)).toBe(true);
  expect(JSON.parse(json.slice(PREFIX.length))).toEqual(expected);
}

describe("json-encoding", () => {
  it("round-trips `undefined`", () => {
    expect(roundTrip(undefined)).toBe(undefined);
  });

  it("round-trips `bigint`", () => {
    expect(roundTrip(42n as FabricValue)).toBe(42n);
  });

  it("`jsonFromValue()` encodes `undefined` to tagged JSON", () => {
    expectWireFormat(undefined, { "/Undefined@1": null });
  });

  it("`jsonFromValue()` encodes `bigint` to tagged JSON", () => {
    expectWireFormat(42n as FabricValue, { "/BigInt@1": "Kg" });
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
    const value = { a: 1, b: "two" } as FabricValue;
    expect(roundTrip(value)).toEqual({ a: 1, b: "two" });
  });

  it("round-trips arrays", () => {
    const value = [1, "two", null] as FabricValue;
    expect(roundTrip(value)).toEqual([1, "two", null]);
  });

  it("round-trips `null`", () => {
    expect(roundTrip(null)).toBe(null);
  });

  it("JSON-safe primitives stringify normally (under the encoding prefix)", () => {
    expect(jsonFromValue(42 as FabricValue)).toBe("fvj1:42");
    expect(jsonFromValue("hello" as FabricValue)).toBe('fvj1:"hello"');
    expect(jsonFromValue(true as FabricValue)).toBe("fvj1:true");
    expect(jsonFromValue(null)).toBe("fvj1:null");
  });

  describe("edge case", () => {
    it("round-trips object with slash-prefixed key", () => {
      const value = { "/foo": "bar" } as FabricValue;
      expect(roundTrip(value)).toEqual({ "/foo": "bar" });
    });

    it("decoded objects are frozen", () => {
      const value = { a: 1, b: "two" } as FabricValue;
      expect(Object.isFrozen(roundTrip(value))).toBe(true);
    });

    it("decoded arrays are frozen", () => {
      const value = [1, 2, 3] as FabricValue;
      expect(Object.isFrozen(roundTrip(value))).toBe(true);
    });

    it("round-trips nested object with special types", () => {
      const value = {
        name: "test",
        count: 42n,
        missing: undefined,
      } as FabricValue;
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.name).toBe("test");
      expect(decoded.count).toBe(42n);
      expect(decoded.missing).toBe(undefined);
    });
  });

  describe("slash-prefixed keys and legacy markers", () => {
    it('`{ "/": value }` round-trips via `/object` escaping', () => {
      // Write path wraps in /object, read path unwraps it.
      const sigilLink = {
        "/": { "link@1": { id: "of:bafyabc", path: [], space: "did:key:z1" } },
      } as FabricValue;
      expect(roundTrip(sigilLink)).toEqual(sigilLink);
    });

    it('nested `{ "/": value }` within object round-trips', () => {
      const value = {
        name: "test",
        ref: { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      } as FabricValue;
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.name).toBe("test");
      expect(decoded.ref).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
    });

    it('`{ "/": "string" }` round-trips via `/object` escaping', () => {
      // An arbitrary string-valued `/` key — not an entity ref; exercises the
      // escaping for the `/` key per se.
      const slashKeyed = { "/": "an arbitrary string" } as FabricValue;
      expect(roundTrip(slashKeyed)).toEqual(slashKeyed);
    });

    it("`$stream` marker passes through unchanged", () => {
      const value = { $stream: true } as FabricValue;
      expect(roundTrip(value)).toEqual({ $stream: true });
    });

    it("`@Error` marker passes through unchanged", () => {
      const value = {
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      } as FabricValue;
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
      } as FabricValue;
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
        ref: { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
        items: [1, { "/": "another arbitrary string" }, undefined],
      } as FabricValue;
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.count).toBe(42n);
      expect(decoded.ref).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
      expect((decoded.items as unknown[])[0]).toBe(1);
      expect((decoded.items as unknown[])[1]).toEqual({
        "/": "another arbitrary string",
      });
      expect((decoded.items as unknown[])[2]).toBe(undefined);
    });

    it('`{ "/": value }` inside array round-trips', () => {
      const value = [
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
        { "/": { "link@1": { id: "of:bafydef", path: ["x"] } } },
      ] as FabricValue;
      expect(roundTrip(value)).toEqual(value);
    });
  });

  describe("seemsLikeJsonEncodedFabricValue", () => {
    it("recognizes a string with the encoding prefix", () => {
      expect(seemsLikeJsonEncodedFabricValue('fvj1:{"a":1}')).toBe(true);
      expect(seemsLikeJsonEncodedFabricValue("fvj1:null")).toBe(true);
      expect(seemsLikeJsonEncodedFabricValue("fvj1:42")).toBe(true);
    });

    it("recognizes the bare prefix", () => {
      expect(seemsLikeJsonEncodedFabricValue("fvj1:")).toBe(true);
    });

    it("recognizes the actual output of `jsonFromValue()` (round-trip check)", () => {
      const encoded = jsonFromValue({ a: 1, b: 42n } as FabricValue);
      expect(seemsLikeJsonEncodedFabricValue(encoded)).toBe(true);
    });

    it("rejects empty string", () => {
      expect(seemsLikeJsonEncodedFabricValue("")).toBe(false);
    });

    it("rejects plain JSON without the prefix", () => {
      // These are plain JSON without the prefix, so the dispatch must reject
      // them.
      expect(seemsLikeJsonEncodedFabricValue("true")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("false")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("null")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue('"hello"')).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("[1,2,3]")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue('{"a":1}')).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("42")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("-1")).toBe(false);
    });

    it("rejects partial or misplaced prefixes", () => {
      expect(seemsLikeJsonEncodedFabricValue("fvj")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("fvj1")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("FVJ1:")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("fvj2:")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue(" fvj1:")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("xfvj1:")).toBe(false);
    });

    it("rejects bare identifiers and other non-JSON-looking strings", () => {
      expect(seemsLikeJsonEncodedFabricValue("hello")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("undefined")).toBe(false);
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

    // (B) fold-in: the no-runtime fallback is a decode-framed empty context
    // (`JSON_DECODE_EMPTY_CONTEXT`) instead of the bare singleton. This is
    // message-only and behavior-preserving: every no-cell-ref decode above
    // must still succeed unchanged (covered by the cases in this describe),
    // and the round-trip with a runtime is unaffected. The decode-framed
    // throw message itself is asserted on the exported class (see
    // `EmptyReconstructionContext (exported class)` below) since a cell-ref
    // decode requires runner-owned wire machinery not available here.
    it("(B) no-runtime decode behavior is unchanged (round-trips, no cell ref)", () => {
      // Same payloads as above, asserted as a single behavior-preservation
      // checkpoint tied to the (B) fold-in.
      expect(valueFromJson("fvj1:42")).toBe(42);
      expect(valueFromJson('fvj1:{"a":1}')).toEqual({ a: 1 });
      expect(valueFromJson('fvj1:{"\/Undefined@1":null}')).toBe(undefined);
      expect(roundTrip(7 as FabricValue)).toBe(7);
    });
  });

  describe("plainObjectFromJson", () => {
    it("returns the decoded plain object", () => {
      const json = jsonFromValue({ a: 1, b: 42n } as FabricValue);
      const result = plainObjectFromJson<{ a: number; b: bigint }>(json);
      expect(result.a).toBe(1);
      expect(result.b).toBe(42n);
    });

    it("throws on a class instance (`FabricError`)", () => {
      const err = FabricError.fromNativeError(new Error("test"));
      const json = jsonFromValue(err as FabricValue);
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
