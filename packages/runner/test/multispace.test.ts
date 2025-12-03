import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space1 = await Identity.fromPassphrase("space1");
const space2 = await Identity.fromPassphrase("space1");

describe("Multi-space Runtime", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx1: IExtendedStorageTransaction;
  let tx2: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx1 = runtime.edit();
    tx2 = runtime.edit();
  });

  afterEach(async () => {
    await tx1.commit();
    await tx2.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should be able to modify cells from multiple spaces", async () => {
    const a = runtime.getCell<number>(
      space1.did(),
      "cause1",
      undefined,
      tx1,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space2.did(),
      "cause2",
      undefined,
      tx2,
    );
    b.setRaw(a.getAsLink());
    tx1.commit();
    tx2.commit();
    await runtime.idle();
    expect(b.get()).toBe(1);
  });
});
