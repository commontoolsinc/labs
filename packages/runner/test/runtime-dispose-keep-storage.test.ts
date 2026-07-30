/**
 * `dispose({ closeStorage: false })`: tear the runtime down, leave the store.
 *
 * The shape this exists for is one store with two runtimes, where one of them
 * populates the store and something else READS the store afterwards — the
 * pattern-vintage capture runs a pattern's own tests against a file-backed
 * space and then snapshots the file (`tasks/pattern-vintage-run.ts`).
 *
 * Without this option the writing runtime cannot be disposed at all, because
 * `dispose()` closes the storage manager and that manager belongs to the
 * caller. Leaving it undisposed is not equivalent: `runner.stopAll()`,
 * `patternUpdater.dispose()` and the pointer-commit settle stop and drain
 * background work that lives OUTSIDE the scheduler, so no amount of `idle()` or
 * `synced()` substitutes for them — a reader would be sampling a store its
 * writer can still commit into.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runtime dispose keep storage");
const space = signer.did();

const SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

describe("runtime.dispose({ closeStorage })", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    // Idempotent: the closing case below has already closed it.
    await storageManager?.close().catch(() => {});
  });

  it("leaves a caller-owned store usable by another runtime", async () => {
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const writeTx = writer.edit();
    writer.getCell<{ value: number }>(
      space,
      "dispose-keep-storage",
      SCHEMA,
      writeTx,
    ).set({ value: 7 });
    await writeTx.commit();
    await writer.idle();
    await storageManager.synced();

    await writer.dispose({ closeStorage: false });

    // The store outlived the writer's teardown: still readable…
    const cell = reader.getCell<{ value: number }>(
      space,
      "dispose-keep-storage",
      SCHEMA,
    );
    await cell.sync();
    expect(cell.get()).toEqual({ value: 7 });

    // …and still WRITABLE, which is the stronger claim: a manager whose
    // sessions had been torn down would reject this rather than return a value
    // it already had cached.
    const readerTx = reader.edit();
    cell.withTx(readerTx).set({ value: 8 });
    await readerTx.commit();
    await reader.idle();
    await storageManager.synced();
    expect(cell.get()).toEqual({ value: 8 });

    await reader.dispose({ closeStorage: false });
  });

  it("closes the store by default", async () => {
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const writeTx = writer.edit();
    writer.getCell<{ value: number }>(space, "dispose-closes", SCHEMA, writeTx)
      .set({ value: 7 });
    await writeTx.commit();
    await writer.idle();
    await storageManager.synced();

    await writer.dispose();

    // The paired assertion, same sequence as above: without it `closeStorage`
    // could be ignored in BOTH directions and the case above would still pass.
    //
    // A closed manager fails QUIETLY, which is the hazard worth pinning. The
    // sync resolves and the commit below reports no error — they just reach
    // nothing. So a caller that hands its store to something that closes it
    // gets a store that reads empty rather than an exception saying why.
    const cell = reader.getCell<{ value: number }>(
      space,
      "dispose-closes",
      SCHEMA,
    );
    await cell.sync();
    expect(cell.get()).toBeUndefined();

    await reader.dispose({ closeStorage: false });
  });
});
