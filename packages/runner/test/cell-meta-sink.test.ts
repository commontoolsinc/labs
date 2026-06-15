import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { Cancel } from "../src/cancel.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type MetaSinkCell = Cell<unknown> & {
  sinkMeta<T extends FabricValue = FabricValue>(
    metaField: "pattern",
    callback: (value: T | undefined) => Cancel | undefined | void,
  ): Cancel;
};

describe("Cell meta subscriptions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("re-runs when the patternIdentity meta field changes", async () => {
    const ref1 = { identity: "pattern-identity-1", symbol: "default" };
    const ref2 = { identity: "pattern-identity-2", symbol: "default" };

    const resultCell = runtime.getCell(
      space,
      "pattern-meta-subscription",
    ) as MetaSinkCell;

    const initialTx = runtime.edit();
    resultCell.withTx(initialTx).setMetaRaw("patternIdentity", ref1);
    await initialTx.commit();

    const seenIdentities: Array<string | undefined> = [];
    const cancel = resultCell.sinkMeta("patternIdentity", (value) => {
      seenIdentities.push(
        (value as { identity?: string } | undefined)?.identity,
      );
    });

    expect(seenIdentities).toEqual([ref1.identity]);

    const updateTx = runtime.edit();
    resultCell.withTx(updateTx).setMetaRaw("patternIdentity", ref2);
    await updateTx.commit();
    await runtime.idle();

    expect(seenIdentities).toEqual([ref1.identity, ref2.identity]);
    cancel();
  });
});
