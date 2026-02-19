import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  deserialize,
  deserializeFromBytes,
  serialize,
  serializeToBytes,
} from "../serialization.ts";
import { JsonEncodingContext } from "../json-encoding.ts";
import type { ReconstructionContext } from "../storable-protocol.ts";
import {
  DECONSTRUCT,
  isStorableInstance,
  RECONSTRUCT,
} from "../storable-protocol.ts";
import type { StorableClass, StorableInstance } from "../storable-protocol.ts";
import type { StorableValue } from "../interface.ts";
import type { SerializedForm } from "../json-serialization-context.ts";
import { UnknownStorable } from "../unknown-storable.ts";
import { ProblematicStorable } from "../problematic-storable.ts";
import {
  deepNativeValueFromStorableValue,
  nativeValueFromStorableValue,
  StorableError,
  StorableMap,
  StorableSet,
} from "../storable-native-instances.ts";
import { FrozenMap, FrozenSet } from "../frozen-builtins.ts";
import { canBeStored } from "../rich-storable-value.ts";

/** Creates a standard test context (non-lenient) and a mock runtime. */
function makeTestContext() {
  const context = new JsonEncodingContext();
  const runtime: ReconstructionContext = {
    getCell(_ref) {
      throw new Error("getCell not implemented in test runtime");
    },
  };
  return { context, runtime };
}

/** Helper: serialize then deserialize (round-trip). */
function roundTrip(value: StorableValue): StorableValue {
  const { context, runtime } = makeTestContext();
  const serialized = serialize(value, context);
  return deserialize(serialized, context, runtime);
}

// ============================================================================
// Tests
// ============================================================================

describe("serialization", () => {
  // --------------------------------------------------------------------------
  // Public API: Uint8Array boundary
  // --------------------------------------------------------------------------

  describe("Uint8Array public API", () => {
    it("serializeToBytes returns Uint8Array", () => {
      const { context } = makeTestContext();
      const result = serializeToBytes(42, context);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("serializeToBytes produces valid JSON bytes", () => {
      const { context } = makeTestContext();
      const bytes = serializeToBytes(
        { a: 1 } as unknown as StorableValue,
        context,
      );
      const json = new TextDecoder().decode(bytes);
      expect(JSON.parse(json)).toEqual({ a: 1 });
    });

    it("deserializeFromBytes accepts Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const bytes = new TextEncoder().encode(JSON.stringify({ a: 1 }));
      const result = deserializeFromBytes(
        bytes,
        context,
        runtime,
      ) as Record<string, StorableValue>;
      expect(result.a).toBe(1);
    });

    it("round-trips through Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const value = {
        name: "test",
        count: 42,
      } as unknown as StorableValue;
      const bytes = serializeToBytes(value, context);
      const result = deserializeFromBytes(
        bytes,
        context,
        runtime,
      ) as Record<string, StorableValue>;
      expect(result.name).toBe("test");
      expect(result.count).toBe(42);
    });

    it("round-trips StorableError through Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const err = new StorableError(new TypeError("oops"));
      const bytes = serializeToBytes(err as StorableValue, context);
      const result = deserializeFromBytes(
        bytes,
        context,
        runtime,
      );
      expect(result).toBeInstanceOf(StorableError);
      const se = result as unknown as StorableError;
      expect(se.error).toBeInstanceOf(TypeError);
      expect(se.error.message).toBe("oops");
    });

    it("round-trips undefined through Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const bytes = serializeToBytes(undefined, context);
      const result = deserializeFromBytes(bytes, context, runtime);
      expect(result).toBe(undefined);
    });

    it("round-trips complex structure through Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const value = {
        users: [{ name: "Alice" }, { name: "Bob" }],
        error: new StorableError(new Error("fail")),
        nothing: undefined,
      } as unknown as StorableValue;
      const bytes = serializeToBytes(value, context);
      const result = deserializeFromBytes(
        bytes,
        context,
        runtime,
      ) as Record<string, StorableValue>;
      const users = result.users as StorableValue[];
      expect((users[0] as Record<string, StorableValue>).name).toBe("Alice");
      expect(result.error).toBeInstanceOf(StorableError);
      expect(result.nothing).toBe(undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Round-trip tests for primitives
  // --------------------------------------------------------------------------

  describe("primitives round-trip", () => {
    it("passes through null", () => {
      expect(roundTrip(null)).toBe(null);
    });

    it("passes through true", () => {
      expect(roundTrip(true)).toBe(true);
    });

    it("passes through false", () => {
      expect(roundTrip(false)).toBe(false);
    });

    it("passes through 0", () => {
      expect(roundTrip(0)).toBe(0);
    });

    it("passes through 42", () => {
      expect(roundTrip(42)).toBe(42);
    });

    it("passes through 3.14", () => {
      expect(roundTrip(3.14)).toBe(3.14);
    });

    it("passes through empty string", () => {
      expect(roundTrip("")).toBe("");
    });

    it("passes through 'hello'", () => {
      expect(roundTrip("hello")).toBe("hello");
    });

    it("passes through strings with special characters", () => {
      expect(roundTrip("with\nnewlines")).toBe("with\nnewlines");
      expect(roundTrip("with\ttabs")).toBe("with\ttabs");
      expect(roundTrip('with"quotes')).toBe('with"quotes');
    });

    it("passes through Number.MAX_SAFE_INTEGER", () => {
      expect(roundTrip(Number.MAX_SAFE_INTEGER)).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it("passes through negative numbers", () => {
      expect(roundTrip(-1)).toBe(-1);
      expect(roundTrip(-3.14)).toBe(-3.14);
    });
  });

  // --------------------------------------------------------------------------
  // undefined
  // --------------------------------------------------------------------------

  describe("undefined", () => {
    it("serializes to { '/Undefined@1': null }", () => {
      const { context } = makeTestContext();
      const result = serialize(undefined, context);
      expect(result).toEqual({ "/Undefined@1": null });
    });

    it("round-trips at top level", () => {
      expect(roundTrip(undefined)).toBe(undefined);
    });

    it("round-trips in arrays", () => {
      const arr = [1, undefined, 3] as StorableValue;
      const result = roundTrip(arr) as StorableValue[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(undefined);
      expect(1 in result).toBe(true); // not a hole
      expect(result[2]).toBe(3);
    });

    it("round-trips as object values", () => {
      const obj = { a: 1, b: undefined } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<string, StorableValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true); // key preserved
    });

    it("is distinct from null", () => {
      const { context } = makeTestContext();
      const serializedNull = serialize(null, context);
      const serializedUndef = serialize(undefined, context);
      expect(serializedNull).not.toEqual(serializedUndef);
    });
  });

  // --------------------------------------------------------------------------
  // bigint (primitive, handled by BigIntHandler)
  // --------------------------------------------------------------------------

  describe("bigint", () => {
    it("serializes to { '/BigInt@1': '<string>' }", () => {
      const { context } = makeTestContext();
      const result = serialize(
        42n as StorableValue,
        context,
      );
      expect(result).toEqual({ "/BigInt@1": "42" });
    });

    it("round-trips at top level", () => {
      const result = roundTrip(42n as StorableValue);
      expect(result).toBe(42n);
    });

    it("round-trips negative bigint", () => {
      const result = roundTrip(-999n as StorableValue);
      expect(result).toBe(-999n);
    });

    it("round-trips zero bigint", () => {
      const result = roundTrip(0n as StorableValue);
      expect(result).toBe(0n);
    });

    it("round-trips large bigint", () => {
      const big = 2n ** 64n;
      const result = roundTrip(big as StorableValue);
      expect(result).toBe(big);
    });

    it("round-trips in arrays", () => {
      const arr = [1, 42n, "hello"] as unknown as StorableValue;
      const result = roundTrip(arr) as StorableValue[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(42n);
      expect(result[2]).toBe("hello");
    });

    it("round-trips as object values", () => {
      const obj = { a: 1, b: 42n } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<string, StorableValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe(42n);
    });

    it("is distinct from number", () => {
      const { context } = makeTestContext();
      const serializedNum = serialize(42, context);
      const serializedBig = serialize(
        42n as StorableValue,
        context,
      );
      expect(serializedNum).not.toEqual(serializedBig);
    });

    it("deserializes non-string state to ProblematicStorable", () => {
      const { context, runtime } = makeTestContext();
      // Manually construct a wire value with a non-string BigInt@1 state.
      const data = { "/BigInt@1": 42 } as SerializedForm;
      const result = deserialize(data, context, runtime);
      expect(result).toBeInstanceOf(ProblematicStorable);
      const prob = result as unknown as ProblematicStorable;
      expect(prob.typeTag).toBe("BigInt@1");
      expect(prob.state).toBe(42);
    });

    it("deserializes null state to ProblematicStorable", () => {
      const { context, runtime } = makeTestContext();
      const data = { "/BigInt@1": null } as SerializedForm;
      const result = deserialize(data, context, runtime);
      expect(result).toBeInstanceOf(ProblematicStorable);
    });

    it("deserializes object state to ProblematicStorable", () => {
      const { context, runtime } = makeTestContext();
      const data = { "/BigInt@1": { bad: true } } as SerializedForm;
      const result = deserialize(data, context, runtime);
      expect(result).toBeInstanceOf(ProblematicStorable);
    });
  });

  // --------------------------------------------------------------------------
  // StorableError (Error wrapper)
  // --------------------------------------------------------------------------

  describe("StorableError", () => {
    it("serializes basic StorableError to /Error@1", () => {
      const { context } = makeTestContext();
      const se = new StorableError(new Error("test"));
      const result = serialize(
        se as StorableValue,
        context,
      ) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(["/Error@1"]);
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("Error");
      expect(state.name).toBe(null); // null = same as type (common case)
      expect(state.message).toBe("test");
    });

    it("round-trips basic Error via StorableError", () => {
      const se = new StorableError(new Error("hello"));
      const result = roundTrip(
        se as StorableValue,
      ) as unknown as StorableError;
      expect(result).toBeInstanceOf(StorableError);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.name).toBe("Error");
      expect(result.error.message).toBe("hello");
    });

    it("round-trips TypeError", () => {
      const se = new StorableError(new TypeError("bad type"));
      const result = roundTrip(
        se as StorableValue,
      ) as unknown as StorableError;
      expect(result).toBeInstanceOf(StorableError);
      expect(result.error).toBeInstanceOf(TypeError);
      expect(result.error.name).toBe("TypeError");
      expect(result.error.message).toBe("bad type");
    });

    it("round-trips RangeError", () => {
      const se = new StorableError(new RangeError("out of range"));
      const result = roundTrip(
        se as StorableValue,
      ) as unknown as StorableError;
      expect(result).toBeInstanceOf(StorableError);
      expect(result.error).toBeInstanceOf(RangeError);
      expect(result.error.name).toBe("RangeError");
    });

    it("round-trips Error with cause", () => {
      const inner = new StorableError(new Error("inner"));
      const outer = new StorableError(
        new Error("outer", { cause: inner }),
      );
      const result = roundTrip(
        outer as StorableValue,
      ) as unknown as StorableError;
      expect(result.error.message).toBe("outer");
      // The cause was serialized as a StorableError (the inner wrapper).
      // After round-trip, the cause is a StorableError.
      expect(result.error.cause).toBeInstanceOf(StorableError);
      expect(
        (result.error.cause as StorableError).error.message,
      ).toBe("inner");
    });

    it("round-trips Error with custom properties", () => {
      const err = new Error("oops");
      (err as unknown as Record<string, unknown>).code = 42;
      (err as unknown as Record<string, unknown>).detail = "more info";
      const se = new StorableError(err);
      const result = roundTrip(
        se as StorableValue,
      ) as unknown as StorableError;
      expect(result.error.message).toBe("oops");
      expect(
        (result.error as unknown as Record<string, unknown>).code,
      ).toBe(42);
      expect(
        (result.error as unknown as Record<string, unknown>).detail,
      ).toBe("more info");
    });

    it("round-trips Error with custom name", () => {
      const err = new Error("custom");
      err.name = "MyCustomError";
      const se = new StorableError(err);
      const result = roundTrip(
        se as StorableValue,
      ) as unknown as StorableError;
      expect(result.error.name).toBe("MyCustomError");
      expect(result.error.message).toBe("custom");
    });

    it("wire format has name: null when name matches type (TypeError)", () => {
      const { context } = makeTestContext();
      // TypeError: name === constructor.name === "TypeError"
      const se = new StorableError(new TypeError("type check"));
      const result = serialize(
        se as StorableValue,
        context,
      ) as Record<string, unknown>;
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe(null); // null = same as type
      expect(state.message).toBe("type check");
    });

    it("wire format has explicit name when name differs from type", () => {
      const { context } = makeTestContext();
      const err = new Error("custom");
      err.name = "MyCustomError";
      const se = new StorableError(err);
      const result = serialize(
        se as StorableValue,
        context,
      ) as Record<string, unknown>;
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("Error");
      expect(state.name).toBe("MyCustomError");
      expect(state.message).toBe("custom");
    });

    it("round-trips TypeError preserving name === type identity", () => {
      // After round-trip, name and type should both be "TypeError",
      // and the Error should reconstruct as a TypeError instance.
      const se = new StorableError(new TypeError("rt"));
      const result = roundTrip(
        se as StorableValue,
      ) as unknown as StorableError;
      expect(result.error).toBeInstanceOf(TypeError);
      expect(result.error.name).toBe("TypeError");
      expect(result.error.constructor.name).toBe("TypeError");
    });

    it("round-trips Error with mismatched name and type", () => {
      // Error constructor is "Error" but name is overridden.
      const err = new Error("mismatch");
      err.name = "CustomName";
      const se = new StorableError(err);
      const result = roundTrip(
        se as StorableValue,
      ) as unknown as StorableError;
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.name).toBe("CustomName");
      expect(result.error.constructor.name).toBe("Error");
    });

    it("isStorableInstance returns true for StorableError", () => {
      const se = new StorableError(new Error("test"));
      expect(isStorableInstance(se)).toBe(true);
    });

    it("has typeTag property", () => {
      const se = new StorableError(new Error("test"));
      expect(se.typeTag).toBe("Error@1");
    });

    it("round-trips StorableError with pre-converted cause (raw Error)", () => {
      // Simulates what toDeepStorableValue produces: a StorableError
      // wrapping an Error whose cause is itself a StorableError (not a
      // raw Error). The serializer's recurse on [DECONSTRUCT] output
      // must find StorableValue, not raw Error.
      const innerSe = new StorableError(new Error("inner"));
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      const outerSe = new StorableError(outerErr);

      const result = roundTrip(
        outerSe as StorableValue,
      ) as unknown as StorableError;
      expect(result.error.message).toBe("outer");
      expect(result.error.cause).toBeInstanceOf(StorableError);
      expect(
        (result.error.cause as StorableError).error.message,
      ).toBe("inner");
    });
  });

  // --------------------------------------------------------------------------
  // Dense arrays
  // --------------------------------------------------------------------------

  describe("dense arrays", () => {
    it("round-trips empty array", () => {
      const result = roundTrip([]) as StorableValue[];
      expect(result).toEqual([]);
    });

    it("round-trips single-element array", () => {
      const result = roundTrip([42]) as StorableValue[];
      expect(result.length).toBe(1);
      expect(result[0]).toBe(42);
    });

    it("round-trips mixed-type array", () => {
      const arr = [null, "str", true, 42] as StorableValue;
      const result = roundTrip(arr) as StorableValue[];
      expect(result[0]).toBe(null);
      expect(result[1]).toBe("str");
      expect(result[2]).toBe(true);
      expect(result[3]).toBe(42);
    });

    it("round-trips nested arrays", () => {
      const arr = [[1, 2], [3, [4, 5]]] as StorableValue;
      const result = roundTrip(arr) as StorableValue[];
      expect((result[0] as StorableValue[])[0]).toBe(1);
      expect((result[0] as StorableValue[])[1]).toBe(2);
      expect(
        ((result[1] as StorableValue[])[1] as StorableValue[])[0],
      ).toBe(4);
    });
  });

  // --------------------------------------------------------------------------
  // Sparse arrays
  // --------------------------------------------------------------------------

  describe("sparse arrays", () => {
    it("serializes [1,,3] with /hole", () => {
      const { context } = makeTestContext();
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , 3] as StorableValue;
      const result = serialize(arr, context) as SerializedForm[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(result[1]).toEqual({ "/hole": 1 });
      expect(result[2]).toBe(3);
    });

    it("round-trips [1,,3] preserving holes", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , 3] as StorableValue;
      const result = roundTrip(arr) as StorableValue[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // true hole
      expect(result[2]).toBe(3);
    });

    it("serializes consecutive holes as run-length encoded", () => {
      const { context } = makeTestContext();
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , , , 5] as StorableValue;
      const result = serialize(arr, context) as SerializedForm[];
      expect(result.length).toBe(3); // [1, {"/hole": 3}, 5]
      expect(result[0]).toBe(1);
      expect(result[1]).toEqual({ "/hole": 3 });
      expect(result[2]).toBe(5);
    });

    it("round-trips [1,,,,5]", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [1, , , , 5] as StorableValue;
      const result = roundTrip(arr) as StorableValue[];
      expect(result.length).toBe(5);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false);
      expect(2 in result).toBe(false);
      expect(3 in result).toBe(false);
      expect(result[4]).toBe(5);
    });

    it("round-trips all-holes array [,,,]", () => {
      // deno-lint-ignore no-sparse-arrays
      const arr = [, , ,] as StorableValue;
      const result = roundTrip(arr) as StorableValue[];
      expect(result.length).toBe(3);
      expect(0 in result).toBe(false);
      expect(1 in result).toBe(false);
      expect(2 in result).toBe(false);
    });

    it("round-trips very sparse array", () => {
      const arr = new Array(1000001) as StorableValue[];
      arr[1000000] = "x";
      const result = roundTrip(arr as StorableValue) as StorableValue[];
      expect(result.length).toBe(1000001);
      expect(0 in result).toBe(false);
      expect(999999 in result).toBe(false);
      expect(result[1000000]).toBe("x");
    });

    it("round-trips interleaved holes and undefined", () => {
      // [1, <hole>, undefined, <hole>, 3]
      const arr = new Array(5) as StorableValue[];
      arr[0] = 1;
      // index 1 is a hole
      arr[2] = undefined;
      // index 3 is a hole
      arr[4] = 3;
      const result = roundTrip(arr as StorableValue) as StorableValue[];
      expect(result.length).toBe(5);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // hole
      expect(result[2]).toBe(undefined);
      expect(2 in result).toBe(true); // not a hole
      expect(3 in result).toBe(false); // hole
      expect(result[4]).toBe(3);
    });

    it("serializes interleaved holes/undefined correctly", () => {
      const { context } = makeTestContext();
      const arr = new Array(5) as StorableValue[];
      arr[0] = 1;
      arr[2] = undefined;
      arr[4] = 3;
      const result = serialize(
        arr as StorableValue,
        context,
      ) as SerializedForm[];
      expect(result).toEqual([
        1,
        { "/hole": 1 },
        { "/Undefined@1": null },
        { "/hole": 1 },
        3,
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // Plain objects
  // --------------------------------------------------------------------------

  describe("plain objects", () => {
    it("round-trips empty object", () => {
      const result = roundTrip({}) as Record<string, StorableValue>;
      expect(Object.keys(result)).toEqual([]);
    });

    it("round-trips simple object", () => {
      const obj = { a: 1, b: "two", c: true } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<string, StorableValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe("two");
      expect(result.c).toBe(true);
    });

    it("round-trips nested objects", () => {
      const obj = { outer: { inner: 42 } } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<
        string,
        Record<string, StorableValue>
      >;
      expect(result.outer.inner).toBe(42);
    });

    it("preserves undefined values in objects", () => {
      const obj = { a: 1, b: undefined } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<string, StorableValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // /object escaping (Section 5.6)
  // --------------------------------------------------------------------------

  describe("/object escaping", () => {
    it("wraps single-key object with /-prefixed key", () => {
      const { context } = makeTestContext();
      const obj = { "/myKey": "val" } as unknown as StorableValue;
      const result = serialize(obj, context);
      expect(result).toEqual({
        "/object": { "/myKey": "val" },
      });
    });

    it("round-trips {'/myKey': 'val'}", () => {
      const obj = { "/myKey": "val" } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<string, StorableValue>;
      expect(result["/myKey"]).toBe("val");
    });

    it("wraps {'/Link@1': 'fake'} (looks like tag but is user data)", () => {
      const { context } = makeTestContext();
      const obj = { "/Link@1": "fake" } as unknown as StorableValue;
      const result = serialize(obj, context);
      expect(result).toEqual({
        "/object": { "/Link@1": "fake" },
      });
    });

    it("round-trips {'/Link@1': 'fake'}", () => {
      const obj = { "/Link@1": "fake" } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<string, StorableValue>;
      expect(result["/Link@1"]).toBe("fake");
    });

    it("does not wrap multi-key objects with / keys", () => {
      const { context } = makeTestContext();
      const obj = { a: 1, "/b": 2 } as unknown as StorableValue;
      const result = serialize(obj, context);
      expect(result).toEqual({ a: 1, "/b": 2 });
    });

    it("round-trips multi-key object with / key", () => {
      const obj = { a: 1, "/b": 2 } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<string, StorableValue>;
      expect(result.a).toBe(1);
      expect(result["/b"]).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // /quote handling (Section 5.6)
  // --------------------------------------------------------------------------

  describe("/quote handling", () => {
    it("deserializes /quote as literal (no inner deserialization)", () => {
      const { context, runtime } = makeTestContext();
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as SerializedForm;
      const result = deserialize(data, context, runtime);
      // The inner structure is returned as-is, not reconstructed.
      const obj = result as Record<string, unknown>;
      expect(obj["/Link@1"]).toEqual({ id: "abc" });
    });

    it("deep-freezes /quote result objects", () => {
      const { context, runtime } = makeTestContext();
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as SerializedForm;
      const result = deserialize(data, context, runtime) as Record<
        string,
        unknown
      >;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result["/Link@1"])).toBe(true);
    });

    it("deep-freezes /quote result arrays", () => {
      const { context, runtime } = makeTestContext();
      const data = {
        "/quote": [1, { nested: "obj" }, [2, 3]],
      } as SerializedForm;
      const result = deserialize(data, context, runtime) as unknown[];
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(Object.isFrozen(result[2])).toBe(true);
    });

    it("mutation of /quote result throws", () => {
      const { context, runtime } = makeTestContext();
      const data = {
        "/quote": { key: "val" },
      } as SerializedForm;
      const result = deserialize(data, context, runtime) as Record<
        string,
        unknown
      >;
      expect(() => {
        result.key = "changed";
      }).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Unknown type tags -> UnknownStorable
  // --------------------------------------------------------------------------

  describe("unknown type tags", () => {
    it("deserializes unknown tag to UnknownStorable", () => {
      const { context, runtime } = makeTestContext();
      const data = {
        "/FutureType@2": { some: "data" },
      } as SerializedForm;
      const result = deserialize(data, context, runtime);
      expect(result).toBeInstanceOf(UnknownStorable);
      const unknown = result as unknown as UnknownStorable;
      expect(unknown.typeTag).toBe("FutureType@2");
    });

    it("round-trips UnknownStorable through serialization", () => {
      const { context, runtime } = makeTestContext();
      const data = {
        "/FutureType@2": { some: "data" },
      } as SerializedForm;
      const deserialized = deserialize(data, context, runtime);

      // Re-serialize
      const reserialized = serialize(
        deserialized as StorableValue,
        context,
      );
      expect(reserialized).toEqual({
        "/FutureType@2": { some: "data" },
      });
    });

    it("/hole outside array is treated as unknown type", () => {
      const { context, runtime } = makeTestContext();
      const data = { "/hole": 5 } as SerializedForm;
      const result = deserialize(data, context, runtime);
      // Should be UnknownStorable since `hole` is not in the class registry
      // and is encountered outside array context.
      expect(result).toBeInstanceOf(UnknownStorable);
      const unknown = result as unknown as UnknownStorable;
      expect(unknown.typeTag).toBe("hole");
      expect(unknown.state).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // Circular reference detection
  // --------------------------------------------------------------------------

  describe("circular reference detection", () => {
    it("throws on object referencing itself", () => {
      const { context } = makeTestContext();
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(() => serialize(obj as StorableValue, context)).toThrow(
        "Circular reference",
      );
    });

    it("throws on array referencing itself", () => {
      const { context } = makeTestContext();
      const arr: unknown[] = [];
      arr.push(arr);
      expect(() => serialize(arr as StorableValue, context)).toThrow(
        "Circular reference",
      );
    });

    it("throws on indirect circular reference (A -> B -> A)", () => {
      const { context } = makeTestContext();
      const a: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      a.ref = b;
      b.ref = a;
      expect(() => serialize(a as StorableValue, context)).toThrow(
        "Circular reference",
      );
    });

    it("throws on StorableInstance whose state references itself", () => {
      const { context } = makeTestContext();
      // Create an UnknownStorable whose state transitively references itself.
      const us = new UnknownStorable("Test@1", null);
      // Mutate state to create a cycle: us -> [us] -> us.
      (us as unknown as { state: StorableValue }).state = [
        us,
      ] as unknown as StorableValue;
      expect(() => serialize(us as StorableValue, context))
        .toThrow(
          "Circular reference",
        );
    });

    it("allows shared references (same object at multiple positions)", () => {
      const { context } = makeTestContext();
      const shared = { val: 42 } as unknown as StorableValue;
      const obj = { a: shared, b: shared } as unknown as StorableValue;
      // Should not throw -- shared references are fine, only cycles are rejected.
      const result = serialize(obj, context);
      expect(result).toEqual({ a: { val: 42 }, b: { val: 42 } });
    });
  });

  // --------------------------------------------------------------------------
  // ProblematicStorable (lenient mode)
  // --------------------------------------------------------------------------

  describe("ProblematicStorable (lenient mode)", () => {
    it("wraps failed reconstruction in ProblematicStorable", () => {
      const context = new JsonEncodingContext({ lenient: true });
      const runtime: ReconstructionContext = {
        getCell(_ref) {
          throw new Error("not available");
        },
      };

      // Register a class that throws on reconstruct.
      const ThrowingClass: StorableClass<StorableInstance> = {
        [RECONSTRUCT](
          _state: StorableValue,
          _context: ReconstructionContext,
        ): StorableInstance {
          throw new Error("reconstruction failed");
        },
      };

      const mockContext = {
        ...context,
        getClassFor(tag: string) {
          if (tag === "TestThrow@1") return ThrowingClass;
          return context.getClassFor(tag);
        },
        getTagFor: context.getTagFor.bind(context),
        encode: context.encode.bind(context),
        decode: context.decode.bind(context),
        lenient: true,
      };

      const data = { "/TestThrow@1": "some state" } as SerializedForm;
      const result = deserialize(data, mockContext, runtime);
      expect(result).toBeInstanceOf(ProblematicStorable);
      const prob = result as unknown as ProblematicStorable;
      expect(prob.typeTag).toBe("TestThrow@1");
      expect(prob.error).toBe("reconstruction failed");
    });

    it("round-trips ProblematicStorable", () => {
      const prob = new ProblematicStorable(
        "BadType@1",
        "original data",
        "something went wrong",
      );
      const { context, runtime } = makeTestContext();
      const serialized = serialize(
        prob as StorableValue,
        context,
      );
      expect(serialized).toEqual({ "/BadType@1": "original data" });

      // Deserializing produces UnknownStorable (BadType@1 is not registered).
      const deserialized = deserialize(serialized, context, runtime);
      expect(deserialized).toBeInstanceOf(UnknownStorable);
    });

    it("wraps failed Error@1 reconstruction in lenient mode", () => {
      const context = new JsonEncodingContext({ lenient: true });
      const runtime: ReconstructionContext = {
        getCell(_ref) {
          throw new Error("not available");
        },
      };

      // Create a mock context that overrides getClassFor to return a
      // throwing class for Error@1.
      const ThrowingErrorClass: StorableClass<StorableInstance> = {
        [RECONSTRUCT](
          _state: StorableValue,
          _context: ReconstructionContext,
        ): StorableInstance {
          throw new Error("Error reconstruction failed");
        },
      };

      const mockContext = {
        ...context,
        getClassFor(tag: string) {
          if (tag === "Error@1") return ThrowingErrorClass;
          return context.getClassFor(tag);
        },
        getTagFor: context.getTagFor.bind(context),
        encode: context.encode.bind(context),
        decode: context.decode.bind(context),
        lenient: true,
      };

      const data = {
        "/Error@1": { name: "Error", message: "test" },
      } as SerializedForm;
      const result = deserialize(data, mockContext, runtime);
      expect(result).toBeInstanceOf(ProblematicStorable);
      const prob = result as unknown as ProblematicStorable;
      expect(prob.typeTag).toBe("Error@1");
      expect(prob.error).toBe("Error reconstruction failed");
    });
  });

  // --------------------------------------------------------------------------
  // Object.freeze() guarantees
  // --------------------------------------------------------------------------

  describe("freeze guarantees", () => {
    it("deserialized arrays are frozen", () => {
      const { context, runtime } = makeTestContext();
      const result = deserialize(
        [1, 2, 3] as SerializedForm,
        context,
        runtime,
      ) as StorableValue[];
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deserialized objects are frozen", () => {
      const { context, runtime } = makeTestContext();
      const result = deserialize(
        { a: 1 } as SerializedForm,
        context,
        runtime,
      ) as Record<string, StorableValue>;
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("mutation of deserialized array throws", () => {
      const { context, runtime } = makeTestContext();
      const result = deserialize(
        [1, 2, 3] as SerializedForm,
        context,
        runtime,
      ) as StorableValue[];
      expect(() => {
        (result as unknown as number[])[0] = 99;
      }).toThrow();
    });

    it("mutation of deserialized object throws", () => {
      const { context, runtime } = makeTestContext();
      const result = deserialize(
        { a: 1 } as SerializedForm,
        context,
        runtime,
      ) as Record<string, StorableValue>;
      expect(() => {
        (result as Record<string, unknown>).a = 99;
      }).toThrow();
    });

    it("nested deserialized objects are frozen", () => {
      const { context, runtime } = makeTestContext();
      const result = deserialize(
        { inner: { val: 42 } } as SerializedForm,
        context,
        runtime,
      ) as Record<string, Record<string, StorableValue>>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.inner)).toBe(true);
    });

    it("deserialized /object-unwrapped objects are frozen", () => {
      const { context, runtime } = makeTestContext();
      const data = { "/object": { "/myKey": "val" } } as SerializedForm;
      const result = deserialize(data, context, runtime) as Record<
        string,
        StorableValue
      >;
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // storable-protocol: isStorableInstance type guard
  // --------------------------------------------------------------------------

  describe("isStorableInstance type guard", () => {
    it("returns false for null", () => {
      expect(isStorableInstance(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isStorableInstance(undefined)).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isStorableInstance(42)).toBe(false);
      expect(isStorableInstance("hello")).toBe(false);
      expect(isStorableInstance(true)).toBe(false);
    });

    it("returns false for plain objects", () => {
      expect(isStorableInstance({})).toBe(false);
      expect(isStorableInstance({ a: 1 })).toBe(false);
    });

    it("returns true for UnknownStorable", () => {
      const us = new UnknownStorable("Test@1", null);
      expect(isStorableInstance(us)).toBe(true);
    });

    it("returns true for ProblematicStorable", () => {
      const ps = new ProblematicStorable("Test@1", null, "oops");
      expect(isStorableInstance(ps)).toBe(true);
    });

    it("returns true for custom StorableInstance", () => {
      const instance = {
        [DECONSTRUCT]() {
          return { value: 42 };
        },
      };
      expect(isStorableInstance(instance)).toBe(true);
    });

    it("returns true for StorableError", () => {
      const se = new StorableError(new Error("test"));
      expect(isStorableInstance(se)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // UnknownStorable
  // --------------------------------------------------------------------------

  describe("UnknownStorable", () => {
    it("preserves typeTag and state", () => {
      const us = new UnknownStorable("FancyType@3", { data: [1, 2, 3] });
      expect(us.typeTag).toBe("FancyType@3");
      expect(us.state).toEqual({ data: [1, 2, 3] });
    });

    it("has DECONSTRUCT method", () => {
      const us = new UnknownStorable("Test@1", "state");
      expect(us[DECONSTRUCT]()).toEqual({
        type: "Test@1",
        state: "state",
      });
    });
  });

  // --------------------------------------------------------------------------
  // ProblematicStorable
  // --------------------------------------------------------------------------

  describe("ProblematicStorable", () => {
    it("preserves typeTag, state, and error", () => {
      const ps = new ProblematicStorable("BadType@1", { x: 1 }, "boom");
      expect(ps.typeTag).toBe("BadType@1");
      expect(ps.state).toEqual({ x: 1 });
      expect(ps.error).toBe("boom");
    });

    it("has DECONSTRUCT method", () => {
      const ps = new ProblematicStorable("T@1", "s", "e");
      expect(ps[DECONSTRUCT]()).toEqual({
        type: "T@1",
        state: "s",
        error: "e",
      });
    });
  });

  // --------------------------------------------------------------------------
  // JsonEncodingContext
  // --------------------------------------------------------------------------

  describe("JsonEncodingContext", () => {
    it("encode produces /<tag> key", () => {
      const ctx = new JsonEncodingContext();
      expect(ctx.encode("Error@1", { name: "Error" })).toEqual({
        "/Error@1": { name: "Error" },
      });
    });

    it("decode recognizes /<tag> key", () => {
      const ctx = new JsonEncodingContext();
      const result = ctx.decode({ "/Error@1": { name: "Error" } });
      expect(result).toEqual({
        tag: "Error@1",
        state: { name: "Error" },
      });
    });

    it("decode returns null for non-tagged objects", () => {
      const ctx = new JsonEncodingContext();
      expect(ctx.decode({ a: 1, b: 2 })).toBe(null);
      expect(ctx.decode({ notSlash: 1 })).toBe(null);
      expect(ctx.decode(42)).toBe(null);
      expect(ctx.decode(null)).toBe(null);
      expect(ctx.decode("string")).toBe(null);
      expect(ctx.decode([1, 2])).toBe(null);
    });

    it("decode returns null for multi-key objects even with / key", () => {
      const ctx = new JsonEncodingContext();
      expect(ctx.decode({ "/a": 1, "/b": 2 })).toBe(null);
    });

    it("getTagFor returns typeTag for UnknownStorable", () => {
      const ctx = new JsonEncodingContext();
      const us = new UnknownStorable("Custom@1", null);
      expect(ctx.getTagFor(us)).toBe("Custom@1");
    });

    it("getTagFor returns typeTag for ProblematicStorable", () => {
      const ctx = new JsonEncodingContext();
      const ps = new ProblematicStorable("Bad@1", null, "err");
      expect(ctx.getTagFor(ps)).toBe("Bad@1");
    });

    it("getTagFor returns typeTag for StorableError", () => {
      const ctx = new JsonEncodingContext();
      const se = new StorableError(new Error("test"));
      expect(ctx.getTagFor(se)).toBe("Error@1");
    });

    it("getClassFor returns StorableError for Error@1", () => {
      const ctx = new JsonEncodingContext();
      expect(ctx.getClassFor("Error@1")).toBeDefined();
    });

    it("getClassFor returns undefined for unknown tags", () => {
      const ctx = new JsonEncodingContext();
      expect(ctx.getClassFor("Unknown@1")).toBeUndefined();
    });

    it("finalize produces valid JSON Uint8Array", () => {
      const ctx = new JsonEncodingContext();
      const bytes = ctx.finalize({ a: 1 } as SerializedForm);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
        a: 1,
      });
    });

    it("parse decodes Uint8Array to JsonWireValue", () => {
      const ctx = new JsonEncodingContext();
      const bytes = new TextEncoder().encode('{"a":1}');
      const result = ctx.parse(bytes);
      expect(result).toEqual({ a: 1 });
    });

    it("finalize/parse round-trip", () => {
      const ctx = new JsonEncodingContext();
      const data = {
        "/Error@1": { name: "Error", message: "test" },
      } as SerializedForm;
      const bytes = ctx.finalize(data);
      const parsed = ctx.parse(bytes);
      expect(parsed).toEqual(data);
    });
  });

  // --------------------------------------------------------------------------
  // nativeValueFromStorableValue
  // --------------------------------------------------------------------------

  describe("nativeValueFromStorableValue", () => {
    it("unwraps StorableError to Error (frozen)", () => {
      const err = new Error("test");
      const se = new StorableError(err);
      const result = nativeValueFromStorableValue(se as StorableValue);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("test");
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("unwraps StorableError to Error (unfrozen)", () => {
      const err = new Error("test");
      const se = new StorableError(err);
      const result = nativeValueFromStorableValue(
        se as StorableValue,
        false,
      );
      expect(result).toBe(err); // same reference when unfrozen
      expect(result).toBeInstanceOf(Error);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("passes through primitives", () => {
      expect(nativeValueFromStorableValue(null)).toBe(null);
      expect(nativeValueFromStorableValue(undefined)).toBe(undefined);
      expect(nativeValueFromStorableValue(42)).toBe(42);
      expect(nativeValueFromStorableValue("hello")).toBe("hello");
      expect(nativeValueFromStorableValue(true)).toBe(true);
    });

    it("returns frozen copy of unfrozen plain objects (frozen=true)", () => {
      const obj = { a: 1 } as unknown as StorableValue;
      const result = nativeValueFromStorableValue(obj);
      expect(Object.isFrozen(result)).toBe(true);
      expect((result as Record<string, unknown>).a).toBe(1);
    });

    it("passes through unfrozen plain objects (frozen=false)", () => {
      const obj = { a: 1 } as unknown as StorableValue;
      expect(nativeValueFromStorableValue(obj, false)).toBe(obj);
    });

    it("passes through frozen plain objects (frozen=true)", () => {
      const obj = Object.freeze({ a: 1 }) as unknown as StorableValue;
      expect(nativeValueFromStorableValue(obj, true)).toBe(obj);
    });

    it("returns unfrozen copy of frozen plain objects (frozen=false)", () => {
      const obj = Object.freeze({ a: 1 }) as unknown as StorableValue;
      const result = nativeValueFromStorableValue(obj, false);
      expect(Object.isFrozen(result)).toBe(false);
      expect((result as Record<string, unknown>).a).toBe(1);
    });

    it("returns frozen copy of unfrozen arrays (frozen=true)", () => {
      const arr = [1, 2, 3] as StorableValue;
      const result = nativeValueFromStorableValue(arr);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).toEqual([1, 2, 3]);
    });

    it("passes through unfrozen arrays (frozen=false)", () => {
      const arr = [1, 2, 3] as StorableValue;
      expect(nativeValueFromStorableValue(arr, false)).toBe(arr);
    });

    it("passes through non-native StorableInstance unchanged (frozen=true)", () => {
      // Non-native StorableInstance values (UnknownStorable, Cell, etc.) pass
      // through as-is -- spreading would strip their prototype/methods.
      const us = new UnknownStorable("Test@1", null);
      const result = nativeValueFromStorableValue(us as StorableValue);
      expect(result).toBe(us);
    });

    it("passes through non-native StorableInstance unchanged (frozen=false)", () => {
      const us = new UnknownStorable("Test@1", null);
      expect(nativeValueFromStorableValue(
        us as StorableValue,
        false,
      )).toBe(us);
    });

    it("unwraps StorableMap to FrozenMap", () => {
      const map = new Map<StorableValue, StorableValue>([
        ["a", 1],
        ["b", 2],
      ] as [StorableValue, StorableValue][]);
      const sm = new StorableMap(map);
      const result = nativeValueFromStorableValue(
        sm as StorableValue,
      );
      expect(result).toBeInstanceOf(FrozenMap);
      expect(result).toBeInstanceOf(Map);
      expect((result as Map<string, number>).get("a")).toBe(1);
      expect((result as Map<string, number>).get("b")).toBe(2);
      expect((result as Map<string, number>).size).toBe(2);
    });

    it("unwraps StorableSet to FrozenSet", () => {
      const set = new Set<StorableValue>([1, 2, 3] as StorableValue[]);
      const ss = new StorableSet(set);
      const result = nativeValueFromStorableValue(
        ss as StorableValue,
      );
      expect(result).toBeInstanceOf(FrozenSet);
      expect(result).toBeInstanceOf(Set);
      expect((result as Set<number>).has(1)).toBe(true);
      expect((result as Set<number>).has(2)).toBe(true);
      expect((result as Set<number>).has(3)).toBe(true);
      expect((result as Set<number>).size).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // deepNativeValueFromStorableValue
  // --------------------------------------------------------------------------

  describe("deepNativeValueFromStorableValue", () => {
    it("deeply unwraps StorableError in objects (frozen)", () => {
      const err = new Error("deep");
      const se = new StorableError(err);
      const obj = {
        error: se,
        code: 500,
      } as unknown as StorableValue;
      const result = deepNativeValueFromStorableValue(obj) as Record<
        string,
        unknown
      >;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("deep");
      expect(Object.isFrozen(result.error)).toBe(true);
      expect(result.code).toBe(500);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deeply unwraps StorableError in arrays (frozen)", () => {
      const err = new Error("array");
      const se = new StorableError(err);
      const arr = [1, se, 3] as unknown as StorableValue;
      const result = deepNativeValueFromStorableValue(arr) as unknown[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(Error);
      expect((result[1] as Error).message).toBe("array");
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(result[2]).toBe(3);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("output is not frozen when frozen=false", () => {
      const obj = Object.freeze({
        a: 1,
        b: "two",
      }) as unknown as StorableValue;
      const result = deepNativeValueFromStorableValue(obj, false) as Record<
        string,
        unknown
      >;
      // Output should be a new, unfrozen object.
      expect(Object.isFrozen(result)).toBe(false);
      result.a = 99; // should not throw
      expect(result.a).toBe(99);
    });

    it("output is frozen when frozen=true (default)", () => {
      const obj = { a: 1, b: "two" } as unknown as StorableValue;
      const result = deepNativeValueFromStorableValue(obj) as Record<
        string,
        unknown
      >;
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves sparse holes", () => {
      const arr = new Array(3) as StorableValue[];
      arr[0] = 1;
      arr[2] = 3;
      Object.freeze(arr);
      const result = deepNativeValueFromStorableValue(
        arr as StorableValue,
      ) as unknown[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // hole preserved
      expect(result[2]).toBe(3);
    });

    it("passes through non-native StorableInstance", () => {
      const us = new UnknownStorable("Test@1", null);
      const obj = { thing: us } as unknown as StorableValue;
      const result = deepNativeValueFromStorableValue(obj) as Record<
        string,
        unknown
      >;
      expect(result.thing).toBe(us);
    });

    it("deeply unwraps StorableMap to FrozenMap", () => {
      const map = new Map<StorableValue, StorableValue>([
        ["x", 10],
      ] as [StorableValue, StorableValue][]);
      const sm = new StorableMap(map);
      const obj = { data: sm } as unknown as StorableValue;
      const result = deepNativeValueFromStorableValue(obj) as Record<
        string,
        unknown
      >;
      expect(result.data).toBeInstanceOf(FrozenMap);
      expect((result.data as Map<string, number>).get("x")).toBe(10);
    });

    it("deeply unwraps StorableSet to FrozenSet", () => {
      const set = new Set<StorableValue>([42] as StorableValue[]);
      const ss = new StorableSet(set);
      const arr = [ss] as unknown as StorableValue;
      const result = deepNativeValueFromStorableValue(arr) as unknown[];
      expect(result[0]).toBeInstanceOf(FrozenSet);
      expect((result[0] as Set<number>).has(42)).toBe(true);
    });

    it("deeply unwraps Error internals (C2)", () => {
      // Error with a StorableError cause and a custom StorableMap property.
      const innerErr = new Error("inner");
      const innerSe = new StorableError(innerErr);
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      (outerErr as unknown as Record<string, unknown>).data = new StorableMap(
        new Map([["k", 1]] as [StorableValue, StorableValue][]),
      );
      const outerSe = new StorableError(outerErr);

      const result = deepNativeValueFromStorableValue(
        outerSe as StorableValue,
      ) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("outer");
      // cause should be deeply unwrapped to a native Error, not StorableError.
      expect(result.cause).toBeInstanceOf(Error);
      expect((result.cause as Error).message).toBe("inner");
      // custom property should be unwrapped to FrozenMap.
      const data = (result as unknown as Record<string, unknown>).data;
      expect(data).toBeInstanceOf(FrozenMap);
    });

    it("deeply unwraps Error internals unfrozen (C2)", () => {
      const innerErr = new Error("inner");
      const innerSe = new StorableError(innerErr);
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      const outerSe = new StorableError(outerErr);

      const result = deepNativeValueFromStorableValue(
        outerSe as StorableValue,
        false,
      ) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.cause).toBeInstanceOf(Error);
      expect(Object.isFrozen(result.cause)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Complex round-trip scenarios
  // --------------------------------------------------------------------------

  describe("complex round-trips", () => {
    it("round-trips deeply nested structure", () => {
      const value = {
        users: [
          { name: "Alice", scores: [100, undefined, 95] },
          { name: "Bob", scores: [] },
        ],
        meta: { version: 1, debug: undefined },
      } as unknown as StorableValue;

      const result = roundTrip(value) as Record<string, StorableValue>;
      const users = result.users as StorableValue[];
      const alice = users[0] as Record<string, StorableValue>;
      expect(alice.name).toBe("Alice");
      const scores = alice.scores as StorableValue[];
      expect(scores[0]).toBe(100);
      expect(scores[1]).toBe(undefined);
      expect(1 in scores).toBe(true);
      expect(scores[2]).toBe(95);

      const meta = result.meta as Record<string, StorableValue>;
      expect(meta.version).toBe(1);
      expect(meta.debug).toBe(undefined);
      expect("debug" in meta).toBe(true);
    });

    it("round-trips StorableError in array", () => {
      const se = new StorableError(new Error("oops"));
      const arr = [1, se, 3] as unknown as StorableValue;
      const result = roundTrip(arr) as StorableValue[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(StorableError);
      expect(
        (result[1] as unknown as StorableError).error.message,
      ).toBe("oops");
      expect(result[2]).toBe(3);
    });

    it("round-trips StorableError as object value", () => {
      const obj = {
        error: new StorableError(new Error("fail")),
        code: 500,
      } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<string, StorableValue>;
      expect(result.error).toBeInstanceOf(StorableError);
      expect(
        (result.error as unknown as StorableError).error.message,
      ).toBe("fail");
      expect(result.code).toBe(500);
    });

    it("wire format is unchanged (backward compatible)", () => {
      // StorableError should produce the same wire format as the old ErrorHandler.
      const { context } = makeTestContext();
      const se = new StorableError(new TypeError("compat test"));
      const serialized = serialize(
        se as StorableValue,
        context,
      ) as Record<string, unknown>;
      expect(Object.keys(serialized)).toEqual(["/Error@1"]);
      const state = serialized["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe(null); // null = same as type (common case)
      expect(state.message).toBe("compat test");
    });
  });

  // --------------------------------------------------------------------------
  // canBeStored: deep storability check
  // --------------------------------------------------------------------------

  describe("canBeStored", () => {
    // -- Primitives that ARE storable --
    it("accepts null", () => {
      expect(canBeStored(null)).toBe(true);
    });

    it("accepts boolean", () => {
      expect(canBeStored(true)).toBe(true);
      expect(canBeStored(false)).toBe(true);
    });

    it("accepts finite numbers", () => {
      expect(canBeStored(42)).toBe(true);
      expect(canBeStored(0)).toBe(true);
      expect(canBeStored(-3.14)).toBe(true);
    });

    it("accepts strings", () => {
      expect(canBeStored("hello")).toBe(true);
      expect(canBeStored("")).toBe(true);
    });

    it("accepts undefined", () => {
      expect(canBeStored(undefined)).toBe(true);
    });

    it("accepts bigint", () => {
      expect(canBeStored(42n)).toBe(true);
      expect(canBeStored(0n)).toBe(true);
    });

    // -- Primitives that are NOT storable --
    it("rejects NaN", () => {
      expect(canBeStored(NaN)).toBe(false);
    });

    it("rejects Infinity", () => {
      expect(canBeStored(Infinity)).toBe(false);
      expect(canBeStored(-Infinity)).toBe(false);
    });

    it("rejects symbols", () => {
      expect(canBeStored(Symbol("test"))).toBe(false);
    });

    it("rejects functions without toJSON", () => {
      expect(canBeStored(() => 42)).toBe(false);
    });

    // -- StorableNativeObject types (would be wrapped) --
    it("accepts Error instances", () => {
      expect(canBeStored(new Error("test"))).toBe(true);
      expect(canBeStored(new TypeError("test"))).toBe(true);
    });

    it("accepts Map instances", () => {
      expect(canBeStored(new Map())).toBe(true);
    });

    it("accepts Set instances", () => {
      expect(canBeStored(new Set())).toBe(true);
    });

    it("accepts Date instances", () => {
      expect(canBeStored(new Date())).toBe(true);
    });

    it("accepts Uint8Array instances", () => {
      expect(canBeStored(new Uint8Array([1, 2, 3]))).toBe(true);
    });

    // -- StorableInstance values --
    it("accepts StorableError wrappers", () => {
      expect(canBeStored(new StorableError(new Error("test")))).toBe(true);
    });

    // -- Containers --
    it("accepts plain objects with storable values", () => {
      expect(canBeStored({ a: 1, b: "hello", c: null })).toBe(true);
    });

    it("accepts arrays with storable values", () => {
      expect(canBeStored([1, "hello", null, true])).toBe(true);
    });

    it("accepts nested structures", () => {
      expect(canBeStored({
        users: [{ name: "Alice", age: 30 }],
        meta: { version: 1 },
      })).toBe(true);
    });

    // -- Deep checks with StorableNativeObject --
    it("accepts objects containing Error values", () => {
      expect(canBeStored({ error: new Error("test"), code: 500 })).toBe(true);
    });

    it("accepts arrays containing Error values", () => {
      expect(canBeStored([1, new Error("test"), "hello"])).toBe(true);
    });

    // -- Rejections --
    it("rejects class instances without toJSON", () => {
      class Foo {
        x = 1;
      }
      expect(canBeStored(new Foo())).toBe(false);
    });

    it("rejects objects with non-storable nested values", () => {
      expect(canBeStored({ a: 1, b: Symbol("bad") })).toBe(false);
    });

    it("rejects arrays with non-storable elements", () => {
      expect(canBeStored([1, Symbol("bad")])).toBe(false);
    });

    it("rejects deeply nested non-storable values", () => {
      expect(canBeStored({
        a: { b: { c: [1, 2, { d: Symbol("bad") }] } },
      })).toBe(false);
    });

    // -- Circular references --
    it("returns false for circular references", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      expect(canBeStored(obj)).toBe(false);
    });

    // -- toJSON support --
    it("accepts objects with toJSON returning storable values", () => {
      const obj = { toJSON: () => ({ x: 1 }) };
      expect(canBeStored(obj)).toBe(true);
    });

    it("rejects objects with toJSON returning non-storable values", () => {
      const obj = { toJSON: () => Symbol("bad") };
      expect(canBeStored(obj)).toBe(false);
    });
  });
});
