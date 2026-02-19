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

    it("round-trips Error through Uint8Array", () => {
      const { context, runtime } = makeTestContext();
      const err = new TypeError("oops");
      const bytes = serializeToBytes(err, context);
      const result = deserializeFromBytes(
        bytes,
        context,
        runtime,
      ) as Error;
      expect(result).toBeInstanceOf(TypeError);
      expect(result.message).toBe("oops");
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
        error: new Error("fail"),
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
      expect(result.error).toBeInstanceOf(Error);
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
  // Error instances
  // --------------------------------------------------------------------------

  describe("Error", () => {
    it("serializes basic Error to /Error@1", () => {
      const { context } = makeTestContext();
      const result = serialize(new Error("test"), context) as Record<
        string,
        unknown
      >;
      expect(Object.keys(result)).toEqual(["/Error@1"]);
      const state = result["/Error@1"] as Record<string, unknown>;
      expect(state.name).toBe("Error");
      expect(state.message).toBe("test");
    });

    it("round-trips basic Error", () => {
      const err = new Error("hello");
      const result = roundTrip(err) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(result.name).toBe("Error");
      expect(result.message).toBe("hello");
    });

    it("round-trips TypeError", () => {
      const err = new TypeError("bad type");
      const result = roundTrip(err) as Error;
      expect(result).toBeInstanceOf(TypeError);
      expect(result.name).toBe("TypeError");
      expect(result.message).toBe("bad type");
    });

    it("round-trips RangeError", () => {
      const err = new RangeError("out of range");
      const result = roundTrip(err) as Error;
      expect(result).toBeInstanceOf(RangeError);
      expect(result.name).toBe("RangeError");
    });

    it("round-trips Error with cause", () => {
      const inner = new Error("inner");
      const outer = new Error("outer", { cause: inner });
      const result = roundTrip(outer) as Error;
      expect(result.message).toBe("outer");
      expect(result.cause).toBeInstanceOf(Error);
      expect((result.cause as Error).message).toBe("inner");
    });

    it("round-trips Error with custom properties", () => {
      const err = new Error("oops");
      (err as unknown as Record<string, unknown>).code = 42;
      (err as unknown as Record<string, unknown>).detail = "more info";
      const result = roundTrip(err) as Error;
      expect(result.message).toBe("oops");
      expect(
        (result as unknown as Record<string, unknown>).code,
      ).toBe(42);
      expect(
        (result as unknown as Record<string, unknown>).detail,
      ).toBe("more info");
    });

    it("round-trips Error with custom name", () => {
      const err = new Error("custom");
      err.name = "MyCustomError";
      const result = roundTrip(err) as Error;
      expect(result.name).toBe("MyCustomError");
      expect(result.message).toBe("custom");
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
      expect(() => serialize(us as unknown as StorableValue, context))
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

      // Manually add the class to the context's registry.
      // We need to access the private registry -- use a dedicated test context.
      // Instead, we'll create wire data for Error@1 with invalid state and
      // see if lenient mode catches the reconstruction error.

      // Actually, Error@1 IS registered and its reconstructor is resilient.
      // Let's test with a custom serialized form that we know will fail:
      // We can create a mock by overriding getClassFor on the context.
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
        prob as unknown as StorableValue,
        context,
      );
      expect(serialized).toEqual({ "/BadType@1": "original data" });

      // Deserializing produces UnknownStorable (BadType@1 is not registered).
      const deserialized = deserialize(serialized, context, runtime);
      expect(deserialized).toBeInstanceOf(UnknownStorable);
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

    it("getClassFor returns undefined for Error@1 (handled by TypeHandler)", () => {
      const ctx = new JsonEncodingContext();
      // Error@1 is handled by ErrorHandler in the TypeHandlerRegistry,
      // not the context's class registry.
      expect(ctx.getClassFor("Error@1")).toBeUndefined();
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

    it("round-trips Error in array", () => {
      const arr = [1, new Error("oops"), 3] as StorableValue;
      const result = roundTrip(arr) as StorableValue[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(Error);
      expect((result[1] as Error).message).toBe("oops");
      expect(result[2]).toBe(3);
    });

    it("round-trips Error as object value", () => {
      const obj = {
        error: new Error("fail"),
        code: 500,
      } as unknown as StorableValue;
      const result = roundTrip(obj) as Record<string, StorableValue>;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("fail");
      expect(result.code).toBe(500);
    });
  });
});
