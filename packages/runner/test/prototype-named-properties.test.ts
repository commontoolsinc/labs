// A property whose NAME happens to match a member of `Object.prototype` is
// ordinary data. `toString`, `valueOf`, `hasOwnProperty` and the rest are legal
// keys — unlike `__proto__`/`constructor` they are not refused by the
// FabricValue boundary (#5264), so they store and round-trip like any other.
//
// Several paths asked whether such a key was present with `in`, which walks the
// prototype chain. The answer was always yes, for every object, so:
//
//   - schema defaults were never applied for those names, and the caller got
//     `Object.prototype`'s FUNCTION where the schema promised a value;
//   - a binding keyed on such a name matched every object and forwarded the
//     inherited function as the bound value;
//   - writing `undefined` to such a key looked like a no-op and was dropped.
//
// These pin the fix at the two paths reachable from the public API. Each has a
// control case using an ordinary name, so a harness that stops exercising the
// path fails loudly rather than passing vacuously.
//
// Sibling of the same bug class in the query-result proxy's
// `getOwnPropertyDescriptor` trap (#5357).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Every name here is an own property of `Object.prototype`, so `k in {}` is
// true for all of them while `Object.hasOwn({}, k)` is false.
const PROTOTYPE_NAMES = [
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
] as const;

describe("properties named after Object.prototype members", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let seq = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("the premise: `in` sees these names, `Object.hasOwn` does not", () => {
    for (const name of PROTOTYPE_NAMES) {
      expect(name in {}).toBe(true);
      expect(Object.hasOwn({}, name)).toBe(false);
    }
  });

  it("CONTROL: an ordinary missing property gets its schema default", () => {
    const c = runtime.getCell<{ name: string }>(
      space,
      `proto-names-control-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John" });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number", default: 30 },
      },
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get() as Record<string, unknown>;
    expect(value.age).toBe(30);
  });

  it("a string-typed default applies to a property named `toString`", () => {
    const c = runtime.getCell<{ name: string }>(
      space,
      `proto-names-tostring-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John" });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        toString: { type: "string", default: "the-default" },
      },
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get() as Record<string, unknown>;
    // Before the fix this was `Object.prototype.toString` — a function, where
    // the schema promised a string. Silent, wrong-typed data.
    expect(typeof value.toString).toBe("string");
    expect(value.toString).toBe("the-default");
  });

  it("defaults apply for every Object.prototype-named property", () => {
    for (const name of PROTOTYPE_NAMES) {
      const c = runtime.getCell<{ name: string }>(
        space,
        `proto-names-each-${name}-${seq++}`,
        undefined,
        tx,
      );
      c.set({ name: "John" });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          [name]: { type: "number", default: 7 },
        },
      } as unknown as JSONSchema;

      const value = c.asSchema(schema).get() as Record<string, unknown>;
      expect(value[name]).toBe(7);
    }
  });

  it("an explicitly stored value at such a name survives a read", () => {
    const c = runtime.getCell<Record<string, unknown>>(
      space,
      `proto-names-stored-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John", valueOf: 99 });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        valueOf: { type: "number", default: 7 },
      },
    } as unknown as JSONSchema;

    const value = c.asSchema(schema).get() as Record<string, unknown>;
    // The stored value wins over the default — the fix must not have swapped
    // one wrong answer for another.
    expect(value.valueOf).toBe(99);
  });

  it("writes to such a name are not dropped as no-ops", () => {
    const c = runtime.getCell<Record<string, unknown>>(
      space,
      `proto-names-write-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John" });
    c.set({ name: "John", toLocaleString: "written" });

    const stored = c.get() as Record<string, unknown>;
    expect(stored.toLocaleString).toBe("written");
  });
});
