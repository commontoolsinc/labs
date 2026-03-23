import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FrozenMap, FrozenSet } from "@commontools/memory/frozen-builtins";
import {
  assertPlainData,
  freezeVerifiedPlainData,
  PlainDataValidationError,
} from "../src/sandbox/plain-data.ts";

describe("plain-data sandbox helper", () => {
  it("freezes plain objects and arrays", () => {
    const value = {
      name: "test",
      nested: {
        count: 1,
      },
      list: [1, { ok: true }],
    };

    const result = freezeVerifiedPlainData(value);

    expect(result).toBe(value);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nested)).toBe(true);
    expect(Object.isFrozen(result.list)).toBe(true);
    expect(Object.isFrozen(result.list[1] as object)).toBe(true);
  });

  it("accepts Map and Set using immutable wrappers", () => {
    const key = { id: 1 };
    const value = new Map<unknown, unknown>([
      [key, new Set([1, 2])],
    ]);

    const result = freezeVerifiedPlainData(value);

    expect(result).toBeInstanceOf(FrozenMap);
    expect(key).toBeDefined();
    expect(Object.isFrozen(key)).toBe(true);

    const nested = result.get(key);
    expect(nested).toBeInstanceOf(FrozenSet);
    expect((nested as ReadonlySet<number>).has(2)).toBe(true);

    expect(() => (result as Map<unknown, unknown>).set("next", true)).toThrow(
      "Cannot mutate a FrozenMap",
    );
    expect(() => (nested as Set<number>).add(3)).toThrow(
      "Cannot mutate a FrozenSet",
    );
  });

  it("reuses previously frozen object keys when collections are wrapped", () => {
    const key = freezeVerifiedPlainData({ code: "open" });
    const lookup = freezeVerifiedPlainData(
      new Map<unknown, unknown>([[key, "Open"]]),
    );

    expect(lookup.get(key)).toBe("Open");
  });

  it("assertPlainData validates without freezing or wrapping", () => {
    const value = {
      nested: new Map([["a", 1]]),
    };

    assertPlainData(value);

    expect(Object.isFrozen(value)).toBe(false);
    expect(value.nested).toBeInstanceOf(Map);
    expect(value.nested).not.toBeInstanceOf(FrozenMap);
  });

  it("rejects accessor properties", () => {
    const value = Object.defineProperty({}, "secret", {
      get() {
        return 1;
      },
      enumerable: true,
    });

    expect(() => freezeVerifiedPlainData(value)).toThrow(
      PlainDataValidationError,
    );
    expect(() => freezeVerifiedPlainData(value)).toThrow(
      "Object properties must be data properties",
    );
  });

  it("rejects sparse arrays", () => {
    const value = [1, 2];
    delete value[1];

    expect(() => freezeVerifiedPlainData(value)).toThrow(
      "Sparse arrays are not allowed",
    );
  });

  it("preserves __proto__ as data when cloning frozen objects", () => {
    const value = { nested: new Set([1]) } as Record<string, unknown>;
    Object.defineProperty(value, "__proto__", {
      value: "sentinel",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.freeze(value);

    const result = freezeVerifiedPlainData(value);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toBe(
      "sentinel",
    );
    expect(result.__proto__).toBe("sentinel");
    expect(result.nested).toBeInstanceOf(FrozenSet);
  });

  it("rejects Map instances with extra own properties", () => {
    const value = new Map([["a", 1]]);
    Object.defineProperty(value, "extra", {
      value: true,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(() => freezeVerifiedPlainData(value)).toThrow(
      "Collections cannot have extra own properties",
    );
  });

  it("rejects Map subclasses", () => {
    class CustomMap<K, V> extends Map<K, V> {}

    expect(() => freezeVerifiedPlainData(new CustomMap([["a", 1]]))).toThrow(
      "Unsupported object prototype 'CustomMap'",
    );
  });

  it("rejects cycles", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => freezeVerifiedPlainData(value)).toThrow(
      "Circular references are not allowed",
    );
  });

  it("rejects non-finite numbers in collections", () => {
    const value = new Set([1, NaN]);

    expect(() => freezeVerifiedPlainData(value)).toThrow(
      "Non-finite numbers are not allowed",
    );
  });
});
