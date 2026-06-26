import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { compileAndRun } from "../src/builtins/compile-and-run.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

Deno.test("compileAndRun initializes outputs and handles invalid programs", async () => {
  const identity = await Identity.fromPassphrase("compile and run coverage");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = identity.did();
  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const inputs = runtime.getCell<any>(
      space,
      "compile-and-run-inputs",
      undefined,
      tx,
    );
    const parent = runtime.getCell(
      space,
      "compile-and-run-parent",
      undefined,
      tx,
    );
    const cancels: Array<() => void> = [];
    let outputs: any;
    let sendResultCount = 0;
    const action = compileAndRun(
      inputs,
      (_tx, result) => {
        sendResultCount++;
        outputs = result;
      },
      (cancel) => cancels.push(cancel),
      { test: "compile-and-run" },
      parent,
      runtime,
    );

    inputs.set({ files: [], main: "" });
    action(tx);

    assertEquals(cancels.length, 1);
    assertEquals(sendResultCount, 1);
    assertEquals(outputs.pending.withTx(tx).get(), false);
    assertEquals(outputs.result.withTx(tx).get(), undefined);
    assertEquals(outputs.error.withTx(tx).get(), undefined);
    assertEquals(outputs.errors.withTx(tx).get(), undefined);

    action(tx);
    assertEquals(sendResultCount, 1);

    inputs.set({
      main: "/missing.tsx",
      files: [{ name: "/other.tsx", contents: "export default 1;" }],
    });
    action(tx);

    assertEquals(outputs.pending.withTx(tx).get(), false);
    assertEquals(
      outputs.error.withTx(tx).get(),
      '"/missing.tsx" not found in files',
    );

    await tx.commit();
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
