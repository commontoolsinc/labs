import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  readCfcCasBlobByExpectedLabel,
  writeCfcCasBlob,
} from "../src/cfc/cas-storage.ts";

const signer = await Identity.fromPassphrase("cfc cas read test");
const space = signer.did();

const aliceLabel = {
  classification: [[{
    type: "https://commonfabric.org/cfc/atom/User",
    subject: space,
  }]],
} as const;

const bobLabel = {
  classification: [[{
    type: "https://commonfabric.org/cfc/atom/User",
    subject: "did:example:bob",
  }]],
} as const;

const aliceLabelReordered = {
  classification: [[{
    subject: space,
    type: "https://commonfabric.org/cfc/atom/User",
  }]],
} as const;

describe("CFC direct CAS read contract", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("returns bytes only when the exact expected label is bound and readable", async () => {
    const payload = new Uint8Array([7, 7, 7, 7]);

    const tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, aliceLabel);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const readTx = runtime.edit();
    const read = await readCfcCasBlobByExpectedLabel(readTx, {
      space,
      blobHash,
      expectedLabel: aliceLabel,
      canReadLabel: () => true,
    });
    await readTx.abort();

    expect(Array.from(read ?? [])).toEqual([7, 7, 7, 7]);
  });

  it("normalizes absent hash and label mismatch to the same undefined result", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);

    const tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, aliceLabel);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const readTx = runtime.edit();
    const mismatch = await readCfcCasBlobByExpectedLabel(readTx, {
      space,
      blobHash,
      expectedLabel: bobLabel,
      canReadLabel: () => true,
    });
    const absent = await readCfcCasBlobByExpectedLabel(readTx, {
      space,
      blobHash: "missing-blob-hash",
      expectedLabel: aliceLabel,
      canReadLabel: () => true,
    });
    await readTx.abort();

    expect(mismatch).toBeUndefined();
    expect(absent).toBeUndefined();
  });

  it("returns undefined when the expected label matches but caller readability rejects it", async () => {
    const payload = new Uint8Array([8, 6, 7, 5]);

    const tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, aliceLabel);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const readTx = runtime.edit();
    const read = await readCfcCasBlobByExpectedLabel(readTx, {
      space,
      blobHash,
      expectedLabel: aliceLabel,
      canReadLabel: () => false,
    });
    await readTx.abort();

    expect(read).toBeUndefined();
  });

  it("matches expected labels by canonical structure rather than atom key order", async () => {
    const payload = new Uint8Array([9, 9, 9, 9]);

    const tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, aliceLabel);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const readTx = runtime.edit();
    const read = await readCfcCasBlobByExpectedLabel(readTx, {
      space,
      blobHash,
      expectedLabel: aliceLabelReordered,
      canReadLabel: () => true,
    });
    await readTx.abort();

    expect(Array.from(read ?? [])).toEqual([9, 9, 9, 9]);
  });
});
