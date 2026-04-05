import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FrozenMap, FrozenSet } from "@commonfabric/data-model/frozen-builtins";
import {
  assertPlainData,
  freezeVerifiedPlainData,
} from "../src/sandbox/plain-data.ts";

describe("plain-data sandbox helper", () => {
  it("returns a frozen snapshot for plain objects and arrays", () => {
    const value = {
      name: "test",
      nested: {
        count: 1,
      },
      list: [1, { ok: true }],
    };

    const result = freezeVerifiedPlainData(value);

    expect(result).not.toBe(value);
    expect(result.nested).not.toBe(value.nested);
    expect(result.list).not.toBe(value.list);
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
    const [resultKey] = result.keys();
    expect(resultKey).not.toBe(key);
    expect(Object.isFrozen(resultKey as object)).toBe(true);

    const nested = result.get(resultKey);
    expect(nested).toBeInstanceOf(FrozenSet);
    expect((nested as ReadonlySet<number>).has(2)).toBe(true);

    expect(() => (result as Map<unknown, unknown>).set("next", true)).toThrow(
      "Cannot mutate a FrozenMap",
    );
    expect(() => (nested as Set<number>).add(3)).toThrow(
      "Cannot mutate a FrozenSet",
    );
    expect(() =>
      Map.prototype.set.call(result as Map<unknown, unknown>, "next", true)
    ).toThrow();
    expect(() => Set.prototype.add.call(nested as Set<number>, 3)).toThrow();
    expect(result.has("next")).toBe(false);
    expect((nested as ReadonlySet<number>).has(3)).toBe(false);
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

  it("materializes accessor properties once into data properties", () => {
    let reads = 0;
    const value = Object.defineProperty({}, "secret", {
      get() {
        reads += 1;
        return { ok: true };
      },
      enumerable: true,
    });

    const result = freezeVerifiedPlainData(
      value,
    ) as Record<string, unknown>;

    expect(reads).toBe(1);
    expect(result.secret).toEqual({ ok: true });
    expect(reads).toBe(1);
    expect(Object.getOwnPropertyDescriptor(result, "secret")).toMatchObject({
      enumerable: true,
      value: { ok: true },
    });
    expect(
      Object.getOwnPropertyDescriptor(result, "secret")?.get,
    ).toBeUndefined();
  });

  it("accepts proxy-wrapped plain objects by snapshotting them", () => {
    let reads = 0;
    const target = {
      count: 1,
      nested: { ok: true },
    };
    const source = new Proxy(
      target,
      {
        get(innerTarget, key, receiver) {
          if (key === "count" || key === "nested") {
            reads += 1;
          }
          return Reflect.get(innerTarget, key, receiver);
        },
      },
    );

    const result = freezeVerifiedPlainData(
      source,
    ) as Record<string, unknown>;

    const readsAfterSnapshot = reads;
    expect(result).toEqual({
      count: 1,
      nested: { ok: true },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nested as object)).toBe(true);

    expect(result.count).toBe(1);
    expect(result.nested).toEqual({ ok: true });
    expect(reads).toBe(readsAfterSnapshot);

    target.count = 2;
    expect(result.count).toBe(1);
  });

  it("preserves sparse arrays and extra array properties", () => {
    const value = new Array(3) as Array<unknown> & { label?: string };
    value[0] = 1;
    value[2] = 3;
    value.label = "kept";

    const result = freezeVerifiedPlainData(value) as ReadonlyArray<unknown> & {
      readonly label?: string;
    };

    expect(result.length).toBe(3);
    expect(result[0]).toBe(1);
    expect(1 in result).toBe(false);
    expect(result[2]).toBe(3);
    expect(result.label).toBe("kept");
    expect(Object.isFrozen(result)).toBe(true);
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

  it("preserves extra own properties on Maps and Sets", () => {
    const value = new Map([["a", 1]]);
    Object.defineProperty(value, "extra", {
      value: true,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const tags = new Set(["a"]);
    Object.defineProperty(tags, "label", {
      value: "kept",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const frozenMap = freezeVerifiedPlainData(
      value,
    ) as ReadonlyMap<string, number> & { readonly extra?: boolean };
    const frozenSet = freezeVerifiedPlainData(
      tags,
    ) as ReadonlySet<string> & { readonly label?: string };

    expect(frozenMap).toBeInstanceOf(FrozenMap);
    expect(frozenMap.get("a")).toBe(1);
    expect(frozenMap.extra).toBe(true);
    expect(frozenSet).toBeInstanceOf(FrozenSet);
    expect(frozenSet.has("a")).toBe(true);
    expect(frozenSet.label).toBe("kept");
  });

  it("rejects Map subclasses", () => {
    class CustomMap<K, V> extends Map<K, V> {}

    expect(() => freezeVerifiedPlainData(new CustomMap([["a", 1]]))).toThrow(
      "Unsupported object prototype 'CustomMap'",
    );
  });

  it("preserves cycles and shared references", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    value.list = [value];
    value.nested = { ref: value };

    const result = freezeVerifiedPlainData(value) as Record<string, unknown>;

    expect(result.self).toBe(result);
    expect((result.list as unknown[])[0]).toBe(result);
    expect((result.nested as Record<string, unknown>).ref).toBe(result);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("preserves non-finite numbers in collections", () => {
    const value = new Set([1, NaN]);

    const result = freezeVerifiedPlainData(value);

    expect(result.has(NaN)).toBe(true);
    expect(result.has(1)).toBe(true);
  });

  it("preserves symbol-keyed properties", () => {
    const secret = Symbol("secret");
    const value = {
      visible: "ok",
    } as Record<string | symbol, unknown>;
    value[secret] = { count: Infinity };

    const result = freezeVerifiedPlainData(
      value,
    ) as Record<string | symbol, unknown>;

    expect(Object.getOwnPropertySymbols(result)).toEqual([secret]);
    expect(result[secret]).toEqual({ count: Infinity });
    expect(Object.isFrozen(result[secret] as object)).toBe(true);
  });

  it("rejects intrinsic stateful RegExp instances", () => {
    const value = /hello/gi;
    value.lastIndex = 2;

    expect(() => freezeVerifiedPlainData(value)).toThrow(
      "Stateful RegExp values are not allowed in verified plain data",
    );
  });
});
