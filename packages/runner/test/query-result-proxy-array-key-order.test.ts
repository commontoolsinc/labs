/**
 * The `ownKeys` trap supplies a `length` key when the underlying value has
 * none of its own. Where it puts that key matters: own-key order is what
 * distinguishes an index-only array from one carrying named properties, and
 * `isArrayWithOnlyIndexProperties()` reads exactly that.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isArrayWithOnlyIndexProperties } from "@commonfabric/utils/arrays";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("query result proxy array key order", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  /**
   * Builds a proxy whose target is array-shaped but whose stored value is
   * record-shaped, which is the case in which the trap has to supply `length`
   * itself. The proxy target is fixed when the proxy is built, so setting an
   * array first and overwriting it afterwards produces the mismatch.
   */
  function arrayTargetOverRecord(cause: string, record: unknown): object {
    const cell = runtime.getCell<unknown>(space, cause, undefined, tx);
    cell.set([1, 2]);
    const proxy = createQueryResultProxy<object>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );
    cell.set(record);
    return proxy;
  }

  it("places a supplied `length` after the index keys, not last", () => {
    const proxy = arrayTargetOverRecord("order-named", { 0: "a", foo: "x" });

    // A real array orders its own keys indices-first, then `length`, then any
    // other name. Appending `length` instead would put it after `foo`.
    expect(Reflect.ownKeys(proxy).map(String)).toEqual(["0", "length", "foo"]);
  });

  it("does not let a named property masquerade as index-only", () => {
    const proxy = arrayTargetOverRecord("order-predicate", {
      0: "a",
      foo: "x",
    });

    // The whole point of the ordering: `foo` is a named property, so this
    // must not read as an index-only array.
    expect(isArrayWithOnlyIndexProperties(proxy)).toBe(false);
  });

  it("still reads as index-only when the value has no named properties", () => {
    const proxy = arrayTargetOverRecord("order-clean", { 0: "a", 1: "b" });

    expect(Reflect.ownKeys(proxy).map(String)).toEqual(["0", "1", "length"]);
    expect(isArrayWithOnlyIndexProperties(proxy)).toBe(true);
  });
});
