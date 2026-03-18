import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  cfcCasLabelBindingsAddress,
  readCfcCasBlob,
  writeCfcCasBlob,
} from "../src/cfc/cas-storage.ts";

const signer = await Identity.fromPassphrase("cfc cas write test");
const space = signer.did();

const aliceLabel = {
  classification: [[{
    type: "https://commonfabric.org/cfc/atom/User",
    subject: space,
  }]],
} as const;

const attestedLabel = {
  classification: [[{
    type: "https://commonfabric.org/cfc/atom/User",
    subject: space,
  }]],
  integrity: [{
    type: "https://commonfabric.org/cfc/atom/RuntimeProfile",
    profile: "approved-profile",
  }],
} as const;

describe("CFC direct CAS write substrate", () => {
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

  it("stores immutable bytes by blob hash and records the first binding", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);

    const tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, aliceLabel);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const verifyTx = runtime.edit();
    const storedPayload = readCfcCasBlob(verifyTx, space, blobHash);
    const storedBindings = verifyTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, blobHash),
    );
    await verifyTx.abort();

    expect(Array.from(storedPayload as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(storedBindings).toEqual({
      blobHash,
      bindings: [{ label: aliceLabel }],
    });
  });

  it("appends a second binding for the same bytes without changing the payload", async () => {
    const payload = new Uint8Array([9, 8, 7, 6]);

    let tx = runtime.edit();
    const first = writeCfcCasBlob(tx, space, payload, aliceLabel);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    const second = writeCfcCasBlob(tx, space, payload, attestedLabel);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();
    expect(second.blobHash).toBe(first.blobHash);

    const verifyTx = runtime.edit();
    const storedPayload = readCfcCasBlob(verifyTx, space, first.blobHash);
    const storedBindings = verifyTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, first.blobHash),
    ) as {
      blobHash: string;
      bindings: Array<{ label: unknown }>;
    };
    await verifyTx.abort();

    expect(Array.from(storedPayload as Uint8Array)).toEqual([9, 8, 7, 6]);
    expect(storedBindings.blobHash).toBe(first.blobHash);
    expect(storedBindings.bindings).toEqual([
      { label: aliceLabel },
      { label: attestedLabel },
    ]);
  });

  it("does not append duplicate bindings for the same bytes and label", async () => {
    const payload = new Uint8Array([5, 5, 5, 5]);

    let tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, attestedLabel);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    writeCfcCasBlob(tx, space, payload, attestedLabel);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const verifyTx = runtime.edit();
    const storedBindings = verifyTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, blobHash),
    ) as {
      blobHash: string;
      bindings: Array<{ label: unknown }>;
    };
    await verifyTx.abort();

    expect(storedBindings.bindings).toEqual([{ label: attestedLabel }]);
  });
});
