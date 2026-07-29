import { expect } from "@std/expect";

Deno.test("DataUnavailable fails closed on an invalid canonical constructor", async () => {
  const key = Symbol.for("common.fabric.DataUnavailable.constructor");
  const original = Object.getOwnPropertyDescriptor(globalThis, key);

  try {
    Object.defineProperty(globalThis, key, {
      value: {},
      configurable: true,
      enumerable: false,
      writable: false,
    });

    await expect(
      import("../../src/fabric-instances/DataUnavailable.ts?invalid-slot"),
    ).rejects.toThrow("Invalid global DataUnavailable constructor");
  } finally {
    if (original === undefined) {
      delete (globalThis as Record<PropertyKey, unknown>)[key];
    } else {
      Object.defineProperty(globalThis, key, original);
    }
  }
});
