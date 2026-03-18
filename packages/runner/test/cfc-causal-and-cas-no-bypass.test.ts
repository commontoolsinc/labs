import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { writeCfcCasBlob } from "../src/cfc/cas-storage.ts";

const signer = await Identity.fromPassphrase("cfc causal cas no bypass test");
const space = signer.did();

const aliceLabel = {
  classification: [[{
    type: "https://commonfabric.org/cfc/atom/User",
    subject: space,
  }]],
} as const;

describe("CFC causal/CAS non-bypass", () => {
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

  it("does not expose CAS blobs or bindings through the normal causal cell path", async () => {
    const payload = new Uint8Array([4, 2, 4, 2]);

    const tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, aliceLabel);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const readTx = runtime.edit();
    const blobCell = runtime.getCellFromLink(
      {
        space,
        id: `blob:${blobHash}`,
        type: "application/json",
        path: [],
      },
      undefined,
      readTx,
    );
    const bindingCell = runtime.getCellFromLink(
      {
        space,
        id: `cas-binding:${blobHash}`,
        type: "application/json",
        path: [],
      },
      undefined,
      readTx,
    );

    expect(blobCell.get()).toBeUndefined();
    expect(bindingCell.get()).toBeUndefined();
    await readTx.abort();
  });
});
