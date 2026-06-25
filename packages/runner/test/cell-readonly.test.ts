// Read-only cell barrier: `freeze()`/`readOnly()` turn the previously-advisory
// `readOnlyReason` into an ENFORCED write barrier (the reactive-interpreter
// backstop for context-requiring read-only leaves). Reads stay allowed; every
// mutation entry point throws; the barrier propagates through derived cells
// (`.key()`/`.asSchema()`/`.withTx()`) so a write cannot escape via a sub-cell.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("ro-barrier operator");
const space = signer.did();

describe("read-only cell barrier", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

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

  it("allows reads but throws on every write entry point once frozen", () => {
    const c = runtime.getCell<{ a: number }>(space, "ro-1", undefined, tx);
    c.set({ a: 1 });
    c.freeze("test");

    // Reads still work.
    expect(c.get()).toEqual({ a: 1 });
    expect(c.sample()).toEqual({ a: 1 });

    // Every mutation throws.
    expect(() => c.set({ a: 2 })).toThrow(/read-only/);
    expect(() => c.send({ a: 2 })).toThrow(/read-only/);
    expect(() => c.update({ a: 2 })).toThrow(/read-only/);
    expect(() => c.setRawUntyped({ a: 2 } as never)).toThrow(/read-only/);
  });

  it("readOnly() returns a frozen SIBLING without mutating the original", () => {
    const c = runtime.getCell<number>(space, "ro-2", undefined, tx);
    c.set(7);
    const ro = c.readOnly("ri-readonly-leaf-input");

    expect(ro.isFrozen()).toBe(true);
    expect(c.isFrozen()).toBe(false); // original untouched
    expect(ro.get()).toBe(7);
    expect(() => ro.set(8)).toThrow(/read-only/);
    // The original is still writable.
    c.set(9);
    expect(c.get()).toBe(9);
    // The read-only sibling sees the new value (same identity) but stays blocked.
    expect(ro.get()).toBe(9);
  });

  it("propagates the barrier through derived cells (.key / .asSchema / .withTx)", () => {
    const c = runtime.getCell<{ nested: { v: number } }>(
      space,
      "ro-3",
      undefined,
      tx,
    );
    c.set({ nested: { v: 1 } });
    const ro = c.readOnly("ri-readonly-leaf-input");

    // .key() child is read-only.
    expect(() => ro.key("nested").key("v").set(2)).toThrow(/read-only/);
    // .asSchema() sibling is read-only.
    expect(() => ro.asSchema().set({ nested: { v: 3 } } as never)).toThrow(
      /read-only/,
    );
    // .withTx() sibling is read-only.
    const tx2 = runtime.edit();
    expect(() => ro.withTx(tx2).set({ nested: { v: 4 } } as never)).toThrow(
      /read-only/,
    );
    // Reads through the children still work.
    expect(ro.key("nested").key("v").get()).toBe(1);
  });
});
