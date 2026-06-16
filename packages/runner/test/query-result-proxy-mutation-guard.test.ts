import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test proxy mutation guard");
const space = signer.did();

// A query-result proxy is a live, transaction-backed view. Structural
// mutations (freeze/seal/defineProperty/delete) cannot be honored without
// either corrupting the backing store or defeating live read-resolution, so
// the proxy refuses them outright -- callers must snapshot to a plain value
// first. These tests lock in that refusal.
describe("query-result proxy structural-mutation guard", () => {
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

  function makeProxy(): Record<string, unknown> {
    const cell = runtime.getCell(space, "guarded", undefined, tx);
    cell.set({ a: 1, b: { c: 2 } });
    return cell.getAsQueryResult() as Record<string, unknown>;
  }

  it("refuses Object.freeze", () => {
    const proxy = makeProxy();
    expect(() => Object.freeze(proxy)).toThrow("live cell-result proxy");
  });

  it("refuses Object.seal", () => {
    const proxy = makeProxy();
    expect(() => Object.seal(proxy)).toThrow("live cell-result proxy");
  });

  it("refuses Object.preventExtensions", () => {
    const proxy = makeProxy();
    expect(() => Object.preventExtensions(proxy)).toThrow(
      "live cell-result proxy",
    );
  });

  it("refuses Object.defineProperty", () => {
    const proxy = makeProxy();
    expect(() =>
      Object.defineProperty(proxy, "added", { value: 1, enumerable: true })
    ).toThrow("live cell-result proxy");
  });

  it("refuses delete", () => {
    const proxy = makeProxy();
    expect(() => {
      delete proxy.a;
    }).toThrow("live cell-result proxy");
  });

  it("still allows a snapshotted plain copy to be frozen", () => {
    const proxy = makeProxy();
    // The documented escape hatch: round-trip to a detached plain value, which
    // is freely freezable.
    const snapshot = JSON.parse(JSON.stringify(proxy));
    expect(() => Object.freeze(snapshot)).not.toThrow();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({ a: 1, b: { c: 2 } });
  });
});
