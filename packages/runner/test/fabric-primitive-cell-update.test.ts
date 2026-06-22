// CT-1770: FabricPrimitive values (e.g. FabricBytes) must be updatable in
// place. Before the fix, the storage no-op gates and the reactivity
// change-detection compared two distinct same-class FabricPrimitives via
// `deepEqual`, which sees zero enumerable own-props and reports them equal —
// so the write was diffed away and reactive consumers never re-ran.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getTransactionWriteDetails } from "../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("ct1770 operator");
const space = signer.did();

const bytesOf = (cell: { get(): { bytes: { slice(): Uint8Array } } }) =>
  Array.from(cell.get().bytes.slice());

describe("FabricPrimitive cell updates (CT-1770)", () => {
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
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("updates a FabricBytes value via keyed set()", async () => {
    const c = runtime.getCell<{ bytes: Uint8Array }>(
      space,
      "keyed",
      undefined,
      tx,
    );
    c.set({ bytes: new Uint8Array([1, 2, 3, 4]) });
    await tx.commit();
    tx = runtime.edit();

    c.withTx(tx).key("bytes").set(new Uint8Array([9, 8, 7, 6]));
    const writes = [...getTransactionWriteDetails(tx, space)];
    await tx.commit();

    expect(writes.map((w) => w.address.path.join("/"))).toContain(
      "value/bytes",
    );
    expect(bytesOf(c)).toEqual([9, 8, 7, 6]);
  });

  it("updates a FabricBytes value via whole-object set()", async () => {
    const c = runtime.getCell<{ bytes: Uint8Array }>(
      space,
      "whole",
      undefined,
      tx,
    );
    c.set({ bytes: new Uint8Array([1, 2, 3, 4]) });
    await tx.commit();
    tx = runtime.edit();

    c.withTx(tx).set({ bytes: new Uint8Array([5, 5, 5, 5]) });
    await tx.commit();

    expect(bytesOf(c)).toEqual([5, 5, 5, 5]);
  });

  it("re-fires reactive consumers when a FabricBytes value changes", async () => {
    const c = runtime.getCell<{ bytes: Uint8Array }>(
      space,
      "react",
      undefined,
      tx,
    );
    c.set({ bytes: new Uint8Array([1, 2, 3, 4]) });
    await tx.commit();

    const seen: string[] = [];
    const cancel = c.key("bytes").sink((value: unknown) => {
      const v = value as { slice(): Uint8Array };
      seen.push(Array.from(v.slice()).join(","));
    });
    await runtime.idle();

    tx = runtime.edit();
    c.withTx(tx).key("bytes").set(new Uint8Array([9, 8, 7, 6]));
    await tx.commit();
    await runtime.idle();
    cancel();

    expect(seen).toEqual(["1,2,3,4", "9,8,7,6"]);
  });
});
