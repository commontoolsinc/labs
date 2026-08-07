import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { compileAndRun } from "../src/builtins/compile-and-run.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
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

// Server-execution v2 Phase 2's compile gate (the builtin's flag-ON
// posture, stated truthfully): compilation is an EFFECTFUL step whose
// launch is a floating promise the overlay destination cannot
// intercept, so the gate lives in the builtin and suppresses fresh
// compiles for EVERY flag-ON non-wave run — client derivation runs,
// F10 handler runs, imperative flows alike. Until the serving port
// lands (stage G's out-of-scope note; the serving side refuses the
// writebacks), fresh compile-and-run is INERT in the ON arm everywhere:
// memo'd results still read through, `pending` renders the ordinary
// loading state. A WAVE-STAMPED run passes the gate (the seam the
// serving port will drive), and the OFF arm is untouched.
Deno.test("compileAndRun's Phase-2 gate: flag-ON non-wave runs launch NO fresh compile (pending stands), a wave-stamped run passes, and the OFF arm is unaffected", async () => {
  const identity = await Identity.fromPassphrase("compile and run gate");
  const space = identity.did();

  const PROGRAM_A = {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: "export default 1;" }],
  };
  const PROGRAM_B = {
    main: "/other.tsx",
    files: [{ name: "/other.tsx", contents: "export default 2;" }],
  };

  /** One builtin instance over `runtime`, with the compile launch
   * DETECTED (never performed): the stub never resolves, so no
   * writeback races teardown — the launch COUNT is the observable. */
  const armed = (
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    name: string,
    program: { main: string; files: Array<{ name: string; contents: string }> },
  ) => {
    let launches = 0;
    (runtime.patternManager as unknown as {
      compileOrGetPattern: () => Promise<unknown>;
    }).compileOrGetPattern = () => {
      launches += 1;
      return new Promise<never>(() => {});
    };
    const inputs = runtime.getCell<{
      main: string;
      files: Array<{ name: string; contents: string }>;
    }>(space, `${name}-inputs`, undefined, tx);
    const parent = runtime.getCell(space, `${name}-parent`, undefined, tx);
    let outputs: any;
    const action = compileAndRun(
      inputs as never,
      (_tx, result) => {
        outputs = result;
      },
      () => {},
      { test: name },
      parent,
      runtime,
    );
    inputs.set(program);
    action(tx);
    return {
      launches: () => launches,
      pending: () => outputs.pending.withTx(tx).get(),
    };
  };

  // ON arm, NON-wave run (the client posture — derivation, F10
  // handler, imperative flows all reach the builtin unstamped): the
  // gate suppresses the fresh compile; pending stays the ordinary
  // loading state.
  {
    const storageManager = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    try {
      const tx: IExtendedStorageTransaction = runtime.edit();
      const nonWave = armed(runtime, tx, "gate-on-non-wave", PROGRAM_A);
      assertEquals(
        nonWave.launches(),
        0,
        "the flag-ON non-wave run must not launch a fresh compile",
      );
      assertEquals(nonWave.pending(), true);

      // ON arm, WAVE-STAMPED run (the serving seam): the gate passes.
      const waveTx: IExtendedStorageTransaction = runtime.edit();
      stampWaveRunContext(waveTx, {
        actionId: "test/compile-gate-wave",
        kind: "derivation",
      });
      const wave = armed(runtime, waveTx, "gate-on-wave", PROGRAM_B);
      assertEquals(
        wave.launches(),
        1,
        "a wave-stamped run must pass the gate (the serving port's seam)",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  }

  // OFF arm: unaffected — the compile launches exactly as today.
  {
    const storageManager = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx: IExtendedStorageTransaction = runtime.edit();
      const off = armed(runtime, tx, "gate-off", PROGRAM_A);
      assertEquals(
        off.launches(),
        1,
        "the OFF arm must launch the fresh compile exactly as today",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  }
});
