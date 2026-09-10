import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { aggregate } from "../src/builtins/aggregate.ts";
import { useCancelGroup } from "../src/cancel.ts";
import { isRawBuiltinResult } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";

describe("aggregate lifecycle", () => {
  it("repairs an aborted initial reconcile and publishes later membership changes", async () => {
    const signer = await Identity.fromPassphrase("aggregate setup repair");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const [cancel, addCancel] = useCancelGroup();
    try {
      const setup = runtime.edit();
      const inputs = runtime.getCell<{
        list: number[];
        operation: "sum";
      }>(signer.did(), "inputs", undefined, setup);
      inputs.set({ list: [1, 2, 3], operation: "sum" });
      const parent = runtime.getCell(signer.did(), "parent", undefined, setup);
      parent.set({});
      const output = runtime.getCell<unknown>(signer.did(), "output");
      await setup.commit();
      const builtin = aggregate(
        inputs.withTx(),
        (tx, result) => output.withTx(tx).set(result),
        addCancel,
        undefined,
        parent.withTx(),
        runtime,
        output.getAsNormalizedFullLink(),
      );
      if (!isRawBuiltinResult(builtin)) throw new Error("Expected coordinator");
      const aborted = runtime.edit();
      await builtin.action(aborted);
      aborted.abort();

      const retry = runtime.edit();
      await builtin.action(retry);
      runtime.prepareTxForCommit(retry);
      await retry.commit();
      addCancel(output.sink(() => {}));
      await runtime.idle();
      expect(await output.pull()).toBe(6);

      const replace = runtime.edit();
      inputs.withTx(replace).key("list").set([10, 20]);
      await replace.commit();
      const reconcile = runtime.edit();
      await builtin.action(reconcile);
      runtime.prepareTxForCommit(reconcile);
      await reconcile.commit();
      await runtime.idle();
      expect(await output.pull()).toBe(30);

      const invalid = runtime.edit();
      inputs.withTx(invalid).key("list").asSchema(true).set("not an array");
      await expect(builtin.action(invalid)).rejects.toThrow(
        "requires an array",
      );
      invalid.abort();
      expect(await output.pull()).toBe(30);
    } finally {
      cancel();
      await storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not publish a resumed coordinator cancelled during input synchronization", async () => {
    const signer = await Identity.fromPassphrase("aggregate cancelled resume");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const [cancel, addCancel] = useCancelGroup();
    const tx = runtime.edit();
    try {
      const inputs = runtime.getCell<{
        list: number[];
        operation: "sum";
      }>(signer.did(), "inputs", undefined, tx);
      inputs.set({ list: [1, 2, 3], operation: "sum" });
      const parent = runtime.getCell(signer.did(), "parent", undefined, tx);
      parent.set({});
      let published = false;
      const builtin = aggregate(
        inputs,
        () => {
          published = true;
        },
        addCancel,
        undefined,
        parent,
        runtime,
        parent.getAsNormalizedFullLink(),
        true,
      );
      if (!isRawBuiltinResult(builtin)) throw new Error("Expected coordinator");
      const pending = builtin.action(tx);
      cancel();
      await pending;
      expect(published).toBe(false);
    } finally {
      cancel();
      tx.abort();
      await storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
