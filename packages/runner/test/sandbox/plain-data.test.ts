import { assertEquals, assertThrows } from "@std/assert";
import {
  assertPlainData,
  freezeVerifiedPlainData,
  VerifiedPlainMap,
  VerifiedPlainSet,
} from "../../src/sandbox/plain-data.ts";
import { createDataWrapper } from "../../src/sandbox/runtime-helpers.ts";

Deno.test("plain-data sanitization accepts the v1 subset plus non-stateful RegExp, Map, and Set", () => {
  const source = {
    ok: true,
    count: 2,
    big: 3n,
    nested: [
      "a",
      1,
      null,
      undefined,
      { fine: "yes", lookup: new Map([["nested", true]]) },
    ],
  };
  const matcher = freezeVerifiedPlainData(/^[a-z]+$/i);
  const lookup = freezeVerifiedPlainData(new Map([["alpha", 1], ["beta", 2]]));
  const allowed = freezeVerifiedPlainData(new Set(["email", "sms"]));
  const value = freezeVerifiedPlainData(source);

  assertEquals(Object.isFrozen(matcher), true);
  assertEquals(matcher.test("Alpha"), true);
  assertEquals(lookup instanceof VerifiedPlainMap, true);
  assertEquals(lookup.get("alpha"), 1);
  assertEquals(((lookup as unknown) as Record<string, unknown>).set, undefined);
  assertEquals(allowed instanceof VerifiedPlainSet, true);
  assertEquals(allowed.has("sms"), true);
  assertEquals(
    ((allowed as unknown) as Record<string, unknown>).add,
    undefined,
  );
  assertEquals(Object.isFrozen(value), true);
  assertEquals(Object.isFrozen(value.nested), true);
  assertEquals(value === source, false);
  assertEquals(value.nested === source.nested, false);
  assertEquals(
    (value.nested[4] as { lookup: unknown }).lookup instanceof VerifiedPlainMap,
    true,
  );
});

Deno.test("plain-data sanitization materializes getters into data", () => {
  let getterCalls = 0;
  const value = Object.create(null, {
    bad: {
      enumerable: true,
      get() {
        getterCalls++;
        return { nested: true };
      },
    },
  });

  const sanitized = freezeVerifiedPlainData(value) as {
    bad: { nested: boolean };
  };

  assertEquals(getterCalls, 1);
  assertEquals(sanitized.bad.nested, true);
  assertEquals(Object.isFrozen(sanitized.bad), true);
});

Deno.test("plain-data sanitization preserves __proto__ as inert data", () => {
  const originalProtoDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "__proto__",
  );
  let setterCalls = 0;

  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    enumerable: false,
    get() {
      return undefined;
    },
    set(_value) {
      setterCalls++;
    },
  });

  try {
    const value = Object.create(null);
    Object.defineProperty(value, "__proto__", {
      value: { ok: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const sanitized = freezeVerifiedPlainData(value) as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(sanitized, "__proto__");

    assertEquals(setterCalls, 0);
    assertEquals(Object.getPrototypeOf(sanitized), Object.prototype);
    assertEquals(descriptor?.enumerable, true);
    assertEquals(descriptor?.value, { ok: true });
    assertEquals(Object.isFrozen(descriptor?.value), true);
  } finally {
    if (originalProtoDescriptor) {
      Object.defineProperty(
        Object.prototype,
        "__proto__",
        originalProtoDescriptor,
      );
    } else {
      Reflect.deleteProperty(Object.prototype, "__proto__");
    }
  }
});

Deno.test("plain-data sanitization densifies sparse arrays and ignores extra own properties", () => {
  const value: unknown[] = [];
  value[2] = "x";
  Object.defineProperty(value, "extra", {
    value: "ignored",
    enumerable: true,
  });

  const sanitized = freezeVerifiedPlainData(value);

  assertEquals(sanitized.length, 3);
  assertEquals(sanitized[0], undefined);
  assertEquals(sanitized[1], undefined);
  assertEquals(sanitized[2], "x");
  assertEquals("extra" in sanitized, false);
});

Deno.test("plain-data sanitization drops symbol and non-enumerable properties", () => {
  const hidden = Symbol("hidden");
  const value: Record<string | symbol, unknown> = { ok: true, [hidden]: 1 };
  Object.defineProperty(value, "secret", {
    value: 2,
    enumerable: false,
  });

  const sanitized = freezeVerifiedPlainData(value) as Record<string, unknown>;

  assertEquals(sanitized.ok, true);
  assertEquals(
    Object.prototype.hasOwnProperty.call(sanitized, "secret"),
    false,
  );
  assertEquals(
    Object.getOwnPropertySymbols(sanitized).includes(hidden),
    false,
  );
});

Deno.test("plain-data validation rejects unsupported shapes", () => {
  assertThrows(() => assertPlainData(new Date()));
  assertThrows(() => assertPlainData(Promise.resolve(1)));
  assertThrows(() => assertPlainData(new WeakMap()));
  assertThrows(() => assertPlainData(new WeakSet()));
  assertThrows(() => assertPlainData(/a/g));
  assertThrows(() => assertPlainData(/a/y));
  assertThrows(() => assertPlainData(Symbol("bad")));
  assertThrows(() => assertPlainData(() => 1));

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assertThrows(() => assertPlainData(cycle));
});

Deno.test("verified collection wrapper methods are frozen without SES harden", () => {
  const lookup = freezeVerifiedPlainData(new Map([["alpha", 1]]));
  const allowed = freezeVerifiedPlainData(new Set(["email"]));
  const mapProto = Object.getPrototypeOf(lookup) as {
    get: (key: string) => number | undefined;
    [Symbol.iterator]: () => IterableIterator<[string, number]>;
  };
  const setProto = Object.getPrototypeOf(allowed) as {
    has: (value: string) => boolean;
    [Symbol.iterator]: () => IterableIterator<string>;
  };

  assertEquals(Object.isFrozen(mapProto), true);
  assertEquals(Object.isFrozen(mapProto.get), true);
  assertEquals(Object.isFrozen(mapProto[Symbol.iterator]), true);
  assertEquals(Object.isFrozen(setProto), true);
  assertEquals(Object.isFrozen(setProto.has), true);
  assertEquals(Object.isFrozen(setProto[Symbol.iterator]), true);
  assertEquals(Object.isFrozen([...lookup.entries()][0]), true);
  assertEquals(Object.isFrozen([...allowed.entries()][0]), true);
});

Deno.test("createDataWrapper sanitizes accessor-backed records before attaching metadata", () => {
  let getterCalls = 0;
  const value = {
    get ok() {
      getterCalls++;
      return "yes";
    },
  };

  const wrapped = createDataWrapper("main.tsx#000:data", [], value) as {
    ok: string;
  };

  assertEquals(getterCalls, 1);
  assertEquals(wrapped.ok, "yes");
  assertEquals(Object.isFrozen(wrapped), true);
});
