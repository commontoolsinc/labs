import { expect } from "@std/expect";

Deno.test("DataUnavailable fails closed on an invalid canonical constructor", async () => {
  const key = Symbol.for("common.fabric.DataUnavailable.constructor");
  Object.defineProperty(globalThis, key, {
    value: {},
    configurable: false,
    enumerable: false,
    writable: false,
  });

  await expect(
    import("../../src/fabric-instances/DataUnavailable.ts?invalid-slot"),
  ).rejects.toThrow("Invalid global DataUnavailable constructor");
});
