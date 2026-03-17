import { assertEquals, assertThrows } from "@std/assert";
import {
  assertPlainData,
  freezeVerifiedPlainData,
} from "../../src/sandbox/plain-data.ts";

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
