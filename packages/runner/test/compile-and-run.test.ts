import { assertEquals, assertStrictEquals } from "@std/assert";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  compileAndRun,
  compileAndRunResult,
} from "../src/builtins/compile-and-run.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  DataUnavailable,
  type FabricError,
} from "@commonfabric/data-model/fabric-instances";
import { CompilerError } from "@commonfabric/js-compiler/errors";

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timeout waiting for ${description}`);
}

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
    assertEquals(
      outputs.result.withTx(tx).resolveAsCell().getRaw(),
      DataUnavailable.schemaMismatch(),
    );
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
    const missingResult = outputs.result.withTx(tx).resolveAsCell()
      .getRaw();
    assertEquals(missingResult.reason, "error");
    assertEquals(
      missingResult.error.message,
      '"/missing.tsx" not found in files',
    );
    assertEquals(
      (missingResult.error as FabricError).getExtra("diagnostics"),
      [],
    );

    await tx.commit();
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("compileAndRun publishes pending and structured compile errors", async () => {
  const identity = await Identity.fromPassphrase("compile error availability");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const compile = Promise.withResolvers<never>();
  const compileStub = stub(
    runtime.patternManager,
    "compileOrGetPattern",
    () => compile.promise,
  );
  const space = identity.did();
  const tx = runtime.edit();

  try {
    const inputs = runtime.getCell<any>(space, "compile-error-inputs");
    const parent = runtime.getCell(space, "compile-error-parent");
    let outputs: any;
    const action = compileAndRun(
      inputs,
      (_tx, result) => outputs = result,
      () => {},
      { test: "compile-error" },
      parent,
      runtime,
    );

    inputs.withTx(tx).set({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: "invalid source" }],
    });
    action(tx);

    assertEquals(outputs.pending.withTx(tx).get(), true);
    assertStrictEquals(
      outputs.result.withTx(tx).resolveAsCell().getRaw(),
      DataUnavailable.pending(),
    );
    await tx.commit();

    compile.reject(
      new CompilerError([{
        diagnostic: {
          category: 1,
          code: 1000,
          file: undefined,
          start: undefined,
          length: undefined,
          messageText: "invalid source",
        },
      }]),
    );
    await waitFor(
      () => outputs.pending.get() === false,
      "compile error publication",
    );

    const unavailable = outputs.result.resolveAsCell().getRaw();
    assertEquals(unavailable.reason, "error");
    assertEquals(unavailable.error.message, "[ERROR] invalid source");
    assertEquals(
      (unavailable.error as FabricError).getExtra("diagnostics"),
      [{
        line: 1,
        column: 1,
        message: "invalid source",
        type: "ERROR",
        file: undefined,
      }],
    );
    assertEquals(outputs.errors.get(), [{
      line: 1,
      column: 1,
      message: "invalid source",
      type: "ERROR",
      file: undefined,
    }]);
  } finally {
    compileStub.restore();
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("compileAndRun propagates unavailable inputs without compiling", async () => {
  const identity = await Identity.fromPassphrase("compile input availability");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const compileStub = stub(
    runtime.patternManager,
    "compileOrGetPattern",
    () => {
      throw new Error("compiler must not run");
    },
  );
  const space = identity.did();
  const tx = runtime.edit();

  try {
    const inputs = runtime.getCell<any>(space, "unavailable-compile-inputs");
    const parent = runtime.getCell(space, "unavailable-compile-parent");
    let outputs: any;
    const action = compileAndRun(
      inputs,
      (_tx, result) => outputs = result,
      () => {},
      { test: "unavailable-input" },
      parent,
      runtime,
    );
    const pending = DataUnavailable.pending();

    inputs.withTx(tx).set({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: "export default 1" }],
      input: pending,
    });
    action(tx);

    assertStrictEquals(
      outputs.result.withTx(tx).resolveAsCell().getRaw(),
      pending,
    );
    assertEquals(outputs.pending.withTx(tx).get(), true);
    assertEquals(compileStub.calls.length, 0);
    await tx.commit();
  } finally {
    compileStub.restore();
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("compileAndRun ignores a superseded compile failure", async () => {
  const identity = await Identity.fromPassphrase("compile supersession");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const first = Promise.withResolvers<never>();
  const second = Promise.withResolvers<never>();
  let compileCalls = 0;
  const compileStub = stub(
    runtime.patternManager,
    "compileOrGetPattern",
    () => ++compileCalls === 1 ? first.promise : second.promise,
  );
  const space = identity.did();

  try {
    const inputs = runtime.getCell<any>(space, "superseded-compile-inputs");
    const parent = runtime.getCell(space, "superseded-compile-parent");
    let outputs: any;
    const action = compileAndRun(
      inputs,
      (_tx, result) => outputs = result,
      () => {},
      { test: "superseded-compile" },
      parent,
      runtime,
    );

    const firstTx = runtime.edit();
    inputs.withTx(firstTx).set({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: "first" }],
    });
    action(firstTx);
    await firstTx.commit();

    const secondTx = runtime.edit();
    inputs.withTx(secondTx).set({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: "second" }],
    });
    action(secondTx);
    await secondTx.commit();

    first.reject(new Error("stale failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertStrictEquals(
      outputs.result.resolveAsCell().getRaw(),
      DataUnavailable.pending(),
    );
    assertEquals(outputs.pending.get(), true);

    second.reject(new Error("current failure"));
    await waitFor(
      () => outputs.pending.get() === false,
      "current compile failure",
    );
    assertEquals(outputs.result.resolveAsCell().getRaw().reason, "error");
    assertEquals(
      outputs.result.resolveAsCell().getRaw().error.message.startsWith(
        "current failure",
      ),
      true,
    );
  } finally {
    compileStub.restore();
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("compileAndRunResult exposes the result cell and keeps both refs", async () => {
  const identity = await Identity.fromPassphrase("direct compiled result");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = identity.did();
  const tx = runtime.edit();

  try {
    // Both refs must remain resolvable: persisted graphs use compileAndRun,
    // while newly transformed graphs use compileAndRunResult.
    runtime.moduleRegistry.getModule("compileAndRun");
    runtime.moduleRegistry.getModule("compileAndRunResult");

    const inputs = runtime.getCell<any>(space, "direct-compile-inputs");
    const parent = runtime.getCell(space, "direct-compile-parent");
    let result: any;
    const action = compileAndRunResult(
      inputs,
      (_tx, value) => result = value,
      () => {},
      { test: "direct-result" },
      parent,
      runtime,
    );

    inputs.withTx(tx).set({ files: [], main: "" });
    action(tx);

    assertEquals(typeof result?.resolveAsCell, "function");
    assertStrictEquals(
      result.withTx(tx).resolveAsCell().getRaw(),
      DataUnavailable.schemaMismatch(),
    );
    await tx.commit();
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("compileAndRunResult preserves the live compiled result", async () => {
  const identity = await Identity.fromPassphrase("live direct compiled result");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = identity.did();
  const tx = runtime.edit();

  try {
    const inputs = runtime.getCell<any>(space, "live-compile-inputs");
    const parent = runtime.getCell(space, "live-compile-parent");
    let result: any;
    const action = compileAndRunResult(
      inputs,
      (_tx, value) => result = value,
      () => {},
      { test: "live-direct-result" },
      parent,
      runtime,
    );

    inputs.withTx(tx).set({
      main: "/main.ts",
      files: [{
        name: "/main.ts",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ value: number }>(({ value }) => ({ value }));",
        ].join("\n"),
      }],
      input: { value: 7 },
    });
    action(tx);
    assertStrictEquals(
      result.withTx(tx).resolveAsCell().getRaw(),
      DataUnavailable.pending(),
    );
    await tx.commit();

    await waitFor(
      () => result.key("value").get() === 7,
      "live compiled result",
    );
    assertEquals(result.key("value").get(), 7);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
