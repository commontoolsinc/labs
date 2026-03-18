import { assertEquals, assertThrows } from "@std/assert";
import {
  assertPlainData,
  freezeVerifiedPlainData,
} from "../../src/sandbox/plain-data.ts";
import { createDataWrapper } from "../../src/sandbox/runtime-helpers.ts";

Deno.test("plain-data validation accepts the v1 subset", () => {
  const value = freezeVerifiedPlainData({
    ok: true,
    count: 2,
    big: 3n,
    nested: ["a", 1, null, undefined, { fine: "yes" }],
  });

  assertEquals(Object.isFrozen(value), true);
  assertEquals(Object.isFrozen(value.nested), true);
});

Deno.test("plain-data validation rejects accessors without invoking getters", () => {
  let getterCalls = 0;
  const value = Object.create(null, {
    bad: {
      enumerable: true,
      get() {
        getterCalls++;
        return "nope";
      },
    },
  });

  assertThrows(() => assertPlainData(value));
  assertEquals(getterCalls, 0);
});

Deno.test("plain-data validation rejects unsupported shapes", () => {
  assertThrows(() => assertPlainData(new Map()));
  assertThrows(() => assertPlainData(new Set()));
  assertThrows(() => assertPlainData(new Date()));
  assertThrows(() => assertPlainData(Promise.resolve(1)));
  assertThrows(() => assertPlainData({ [Symbol("bad")]: 1 }));

  const sparse: unknown[] = [];
  sparse[2] = "x";
  assertThrows(() => assertPlainData(sparse));

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assertThrows(() => assertPlainData(cycle));
});

Deno.test("plain-data validation rejects array extra own properties and non-enumerable data", () => {
  const withExtra = [1, 2];
  Object.defineProperty(withExtra, "extra", {
    value: { nested: true },
    enumerable: false,
  });
  assertThrows(() => assertPlainData(withExtra));

  const withHidden = {};
  Object.defineProperty(withHidden, "hidden", {
    value: new Map([["nope", 1]]),
    enumerable: false,
  });
  assertThrows(() => assertPlainData(withHidden));
});

Deno.test("freezeVerifiedPlainData deep-freezes non-enumerable nested data", () => {
  const nested = { ok: true };
  const value: Record<string, unknown> = {};
  Object.defineProperty(value, "hidden", {
    value: nested,
    enumerable: false,
  });

  const frozen = freezeVerifiedPlainData(value);
  const hidden = Object.getOwnPropertyDescriptor(frozen, "hidden")?.value;

  assertEquals(Object.isFrozen(frozen), true);
  assertEquals(hidden === undefined, false);
  assertEquals(Object.isFrozen(hidden), true);
});

Deno.test("plain-data validation rejects proxies without invoking traps", () => {
  let getPrototypeOfCalls = 0;
  let ownKeysCalls = 0;
  const value = new Proxy({}, {
    getPrototypeOf() {
      getPrototypeOfCalls++;
      return Object.prototype;
    },
    ownKeys() {
      ownKeysCalls++;
      return [];
    },
  });

  assertThrows(() => assertPlainData(value));
  assertEquals(getPrototypeOfCalls, 0);
  assertEquals(ownKeysCalls, 0);
});

Deno.test("createDataWrapper rejects proxies before attaching metadata", () => {
  let definePropertyCalls = 0;
  const value = new Proxy({}, {
    defineProperty(target, key, descriptor) {
      definePropertyCalls++;
      return Reflect.defineProperty(target, key, descriptor);
    },
  });

  assertThrows(() => createDataWrapper("main.tsx#000:data", [], value));
  assertEquals(definePropertyCalls, 0);
});
