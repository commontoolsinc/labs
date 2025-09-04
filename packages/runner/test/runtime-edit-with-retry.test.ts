import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { DEFAULT_MAX_RETRIES, Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Runtime.editWithRetry", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ blobbyServerUrl: import.meta.url, storageManager });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("commits successfully without retry", async () => {
    const cell = runtime.getCell<number>(
      space,
      "editWithRetry-success",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();

    const ok = await runtime.editWithRetry((t) => {
      cell.withTx(t).send(1);
    });

    expect(ok).toBe(true);
    expect(cell.get()).toBe(1);
  });

  it("retries commit failures and eventually succeeds", async () => {
    // Prepare a cell and commit initial value
    const cell = runtime.getCell<number>(
      space,
      "editWithRetry-retry-succeed",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();

    // Track attempts and force early aborts to trigger retry
    let attempts = 0;
    const ok = await runtime.editWithRetry((t) => {
      attempts++;
      // Abort the first few attempts to force retry
      if (attempts <= 2) {
        t.abort("force-abort-for-retry");
        return;
      }
      cell.withTx(t).send(2);
    }, 5);

    expect(ok).toBe(true);
    expect(attempts).toBe(3); // initial + 2 retries
    expect(cell.get()).toBe(2);
  });

  it("returns false after exhausting retries", async () => {
    const cell = runtime.getCell<number>(
      space,
      "editWithRetry-retry-fail",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();

    let attempts = 0;
    const max = 3;
    const ok = await runtime.editWithRetry((t) => {
      attempts++;
      t.abort("always-fail");
    }, max);

    expect(ok).toBe(false);
    // initial + max retries
    expect(attempts).toBe(max + 1);
    // Value unchanged
    expect(cell.get()).toBe(0);
  });

  it("uses DEFAULT_MAX_RETRIES when not provided", async () => {
    const cell = runtime.getCell<number>(
      space,
      "editWithRetry-default-retries",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();

    let attempts = 0;
    const ok = await runtime.editWithRetry((t) => {
      attempts++;
      t.abort("always-fail");
    });

    expect(ok).toBe(false);
    expect(attempts).toBe(DEFAULT_MAX_RETRIES + 1);
    expect(cell.get()).toBe(0);
  });
});
