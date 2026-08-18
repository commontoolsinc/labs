import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { compileAndRun } from "../src/builtins/compile-and-run.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

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

// ---------------------------------------------------------------------------
// Server-execution v2 stage C (OW28): compile-and-run SERVED as an outbox
// effect. These pins run the builtin's action + its post-commit effect
// INLINE over a bare runtime — no SpaceServer — with REAL compiles (so
// the process content cache the instantiate branch reads is genuinely
// populated). The full route through a live SpaceServer + client (the
// piece-creation flow end to end, recovery, counters, unstamped=0) is in
// executor-compile-and-run.test.ts. What is pinned here:
//
// - a WAVE-STAMPED serving run compiles the program via the OUTBOX EFFECT
//   (not client-side, not from the action), RE-ARMS (`compiledHash`), then
//   INSTANTIATES the child in a later run from the process cache
//   (`pending=false`, the request memoized, the child's value served); a
//   re-evaluation MEMO-HITS instead of re-compiling;
// - a flag-ON CLIENT (non-serving) NEVER compiles and writes nothing
//   speculatively — it reads through to the served cells (speculation.md
//   §2);
// - a failing compile lands an ERROR-SHAPED result, keyed — no infinite
//   pending, and no re-fire on re-evaluation (input-driven retry, T14);
// - the OFF arm compiles from the action, exactly as today, and has no
//   memo cell.
//
// The re-instantiation on a PROGRAM change, the piece-creation hook, the
// client read-through end to end, recovery (memo reuse across park), and
// the §7 counters are pinned LIVE against a real SpaceServer + client in
// executor-compile-and-run.test.ts (a bare runtime has no wave cycle to
// serialize a re-instantiated child's async body against).
// ---------------------------------------------------------------------------

type ProgramInput = {
  main: string;
  files: Array<{ name: string; contents: string }>;
};

const childProgram = (answer: number): ProgramInput => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<Record<string, never>, { answer: number }>(",
      `  () => ({ answer: ${answer} }),`,
      ");",
    ].join("\n"),
  }],
});
const PROGRAM_A = childProgram(42);
const BROKEN: ProgramInput = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: "this is not valid (((" }],
};
const hashOfProgram = (program: ProgramInput) => hashOf(program).toString();

/** A builtin instance over `runtime` whose compiles are COUNTED (the real
 * compileOrGetPattern is wrapped, never replaced — the instantiate branch
 * reads the genuine content cache). */
const armed = (
  runtime: Runtime,
  space: MemorySpace,
  name: string,
) => {
  const launched: ProgramInput[] = [];
  const pm = runtime.patternManager as unknown as {
    compileOrGetPattern: (
      input: ProgramInput | string,
      space?: string,
    ) => Promise<unknown>;
  };
  const real = pm.compileOrGetPattern.bind(pm);
  pm.compileOrGetPattern = (input, targetSpace) => {
    launched.push(input as ProgramInput);
    return real(input, targetSpace);
  };
  const inputs = runtime.getCell<ProgramInput>(
    space,
    `${name}-inputs`,
    undefined,
  );
  const parent = runtime.getCell(space, `${name}-parent`, undefined);
  let outputs:
    | {
      pending: Cell<boolean>;
      result: Cell<any>;
      error: Cell<string | undefined>;
      errors: Cell<unknown>;
    }
    | undefined;
  const cause = { test: name };
  const action = compileAndRun(
    inputs as never,
    (_tx, result) => {
      outputs = result;
    },
    () => {},
    cause,
    parent,
    runtime,
  );
  /** Run the action inside a fresh transaction, commit it (on this bare
   * runtime the commit runs the effect flush inline), and settle so the
   * compile + its re-arm complete. The SERVED/CLIENT posture is the
   * RUNTIME's (`servingPosture`), not a per-tx stamp: on the real serving
   * runtime every scheduler run is wave-stamped by the SpaceServer, and an
   * unstamped one refuses loudly at the seal (the E2E pins
   * `unstampedSealRefusals === 0`). */
  const run = async (program: ProgramInput) => {
    await runtime.idle();
    await runtime.storageManager.synced();
    const tx: IExtendedStorageTransaction = runtime.edit();
    inputs.withTx(tx).set(program);
    action(tx);
    const launchesAtAction = launched.length;
    const committed = await tx.commit();
    await runtime.settled();
    return { launchesAtAction, error: committed.error };
  };
  /** Re-run the action (the loop's re-arm re-run) to reach the instantiate
   * branch after the compile effect cached the pattern. Settles first so
   * the prior run's instantiated child body has landed (a bare runtime has
   * no wave cycle to serialize against; a real SpaceServer does). */
  const rerun = async (program: ProgramInput) => {
    const { error } = await run(program);
    return error;
  };
  /** Seed the DURABLE state of a request issued but never resolved (a
   * process that crashed/parked mid-compile): `pending=true` +
   * `internal={requestHash}` committed, with NO `resolvedHash` and an
   * empty compile cache. A FRESH closure over this store must RE-FIRE the
   * compile — not falsely memo-hit on the init-clobbered `pending`. */
  const seedMidFlight = async (program: ProgramInput) => {
    const h = hashOfProgram(program);
    const tx: IExtendedStorageTransaction = runtime.edit();
    runtime.getCell<boolean>(
      space,
      { compile: { pending: cause } },
      undefined,
      tx,
    ).set(true);
    runtime.getCell(space, { compile: { internal: cause } }, undefined, tx)
      .set({ requestHash: h });
    inputs.withTx(tx).set(program);
    await tx.commit();
  };
  return {
    inputs,
    seedMidFlight,
    launches: () => launched.length,
    launchesOf: (program: ProgramInput) =>
      launched.filter((p) => JSON.stringify(p) === JSON.stringify(program))
        .length,
    run,
    rerun,
    outputs: () => outputs!,
    memo: () =>
      runtime.getCell<
        | { requestHash?: string; compiledHash?: string; resolvedHash?: string }
        | undefined
      >(
        space,
        { compile: { internal: cause } },
        undefined,
      ).get(),
  };
};

const newOnRuntime = async (
  passphrase: string,
  extra: {
    servingPosture?: boolean;
    pieceCreatedCallback?: (piece: Cell<any>) => void;
  } = {},
) => {
  const identity = await Identity.fromPassphrase(passphrase);
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { serverExecution: true },
    ...(extra.servingPosture ? { servingPosture: true } : {}),
    ...(extra.pieceCreatedCallback
      ? { pieceCreatedCallback: extra.pieceCreatedCallback }
      : {}),
  });
  return { runtime, storageManager, space: identity.did() as MemorySpace };
};

Deno.test("OW28 — a served run compiles via the OUTBOX EFFECT (not from the action), re-arms, then instantiates the child in a later run; a re-evaluation MEMO-HITS instead of re-compiling", async () => {
  const hits: string[] = [];
  const { runtime, storageManager, space } = await newOnRuntime(
    "compile and run served instantiate",
    { servingPosture: true },
  );
  runtime.effectMemoObserver = (event) => {
    if (event.kind === "hit") hits.push(event.id);
  };
  try {
    const node = armed(runtime, space, "served");

    // First run: the compile is an EFFECT (0 launches at action time); the
    // effect compiles once and RE-ARMS the derivation (`compiledHash`);
    // `pending` stays issued (the instantiation is the re-arm run below).
    const first = await node.run(PROGRAM_A);
    assertEquals(first.error, undefined);
    assertEquals(first.launchesAtAction, 0, "the action launches no compile");
    assertEquals(node.launchesOf(PROGRAM_A), 1, "the effect compiled once");
    assertEquals(node.outputs().pending.get(), true);
    assertEquals(node.memo()?.requestHash, hashOfProgram(PROGRAM_A));
    assertEquals(node.memo()?.compiledHash, hashOfProgram(PROGRAM_A));

    // The re-arm run: the cached pattern instantiates the child in-run
    // (`pending=false`, the request memoized, the child's value served).
    assertEquals(await node.rerun(PROGRAM_A), undefined);
    assertEquals(node.outputs().pending.get(), false);
    assertEquals(node.outputs().error.get(), undefined);
    assertEquals(
      node.outputs().result.key("isHidden").get() as unknown as boolean,
      true,
    );
    assertEquals(
      node.outputs().result.key("answer").get() as unknown as number,
      42,
    );
    assertEquals(node.memo()?.requestHash, hashOfProgram(PROGRAM_A));

    // A re-evaluation of the landed request: the §4 hit — no re-compile,
    // the hit reported. (Re-instantiation on a PROGRAM change, recovery,
    // and the full lifecycle are pinned live in
    // executor-compile-and-run.test.ts against a real SpaceServer.)
    assertEquals(await node.rerun(PROGRAM_A), undefined);
    assertEquals(node.launchesOf(PROGRAM_A), 1);
    assertEquals(
      hits.includes(`compileAndRun:${hashOfProgram(PROGRAM_A)}`),
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("OW28 — recovery mid-flight: a durable `pending` request that NEVER resolved (crash/park between issue and completion) RE-FIRES the compile instead of wedging as a false memo-hit", async () => {
  const { runtime, storageManager, space } = await newOnRuntime(
    "compile and run mid-flight recovery",
    { servingPosture: true },
  );
  try {
    const node = armed(runtime, space, "recov");
    // The "dead process" left `pending=true` + an ISSUED memo (no
    // resolvedHash) durably, and the compile cache is empty (fresh
    // process). The hit rule keys on `resolvedHash`, so this is NOT a hit
    // even though the cell-init reads `pending=false`.
    await node.seedMidFlight(PROGRAM_A);
    assertEquals(node.memo()?.requestHash, hashOfProgram(PROGRAM_A));
    assertEquals(node.memo()?.resolvedHash, undefined);

    // The fresh closure re-fires the compile (the §6 re-miss) rather than
    // reading through an empty result forever.
    const first = await node.run(PROGRAM_A);
    assertEquals(first.error, undefined);
    assertEquals(node.launchesOf(PROGRAM_A), 1, "the compile re-fired");
    // Re-arm run instantiates and RESOLVES.
    assertEquals(await node.rerun(PROGRAM_A), undefined);
    assertEquals(node.outputs().pending.get(), false);
    assertEquals(
      node.outputs().result.key("answer").get() as unknown as number,
      42,
    );
    assertEquals(node.memo()?.resolvedHash, hashOfProgram(PROGRAM_A));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("OW28 — compile-cache EVICTION between the effect's re-arm and the instantiate run RE-FIRES the compile instead of wedging (the re-arm landed, the process cache lost the entry)", async () => {
  const { runtime, storageManager, space } = await newOnRuntime(
    "compile and run cache eviction",
    { servingPosture: true },
  );
  try {
    const node = armed(runtime, space, "evict");
    // Issue: the effect compiles, caches, and RE-ARMS (compiledHash).
    assertEquals((await node.run(PROGRAM_A)).error, undefined);
    assertEquals(node.launchesOf(PROGRAM_A), 1);
    assertEquals(node.memo()?.compiledHash, hashOfProgram(PROGRAM_A));
    assertEquals(node.outputs().pending.get(), true);

    // The FIFO content cache evicts the entry before the re-arm run reaches
    // the instantiate branch (white-box: the >1000-distinct-programs window
    // compressed to a delete).
    const cache = (runtime.patternManager as unknown as {
      compiledByContent: Map<string, unknown>;
    }).compiledByContent;
    assertEquals(cache.size >= 1, true);
    cache.clear();

    // The re-arm run finds no cached pattern for a request whose re-arm
    // LANDED: it re-fires (a second real compile), re-arms, and the next
    // run instantiates — never a wedge on `pending=true`.
    assertEquals(await node.rerun(PROGRAM_A), undefined);
    assertEquals(node.launchesOf(PROGRAM_A), 2, "re-fired after eviction");
    assertEquals(await node.rerun(PROGRAM_A), undefined);
    assertEquals(node.outputs().pending.get(), false);
    assertEquals(
      node.outputs().result.key("answer").get() as unknown as number,
      42,
    );
    assertEquals(node.memo()?.resolvedHash, hashOfProgram(PROGRAM_A));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("OW28 — a flag-ON CLIENT (non-serving) never compiles and writes nothing speculatively: it reads through to the served cells", async () => {
  const { runtime, storageManager, space } = await newOnRuntime(
    "compile and run client read-through",
  );
  try {
    const node = armed(runtime, space, "client");
    const { launchesAtAction, error } = await node.run(PROGRAM_A);
    assertEquals(error, undefined);
    assertEquals(launchesAtAction, 0);
    assertEquals(node.launches(), 0, "the client must never compile");
    // Read-through: no speculative pending write, no result, no memo issue —
    // the cells reflect the (empty) served state.
    assertEquals(node.outputs().pending.get(), false);
    assertEquals(node.outputs().result.get(), undefined);
    assertEquals(node.memo(), undefined);

    // The SYNCHRONOUS outcomes too (the review's MINOR-2): the client
    // decides nothing for invalid inputs or a missing main — the SERVER
    // lands those as committed cells the hit rule reads through. No
    // error/memo/pending write from the client, ever.
    assertEquals(
      (await node.run({
        main: "/missing.tsx",
        files: [{ name: "/other.tsx", contents: "export default 1;" }],
      })).error,
      undefined,
    );
    assertEquals(node.outputs().error.get(), undefined);
    assertEquals(node.outputs().pending.get(), false);
    assertEquals(node.memo(), undefined);
    assertEquals((await node.run({ main: "", files: [] })).error, undefined);
    assertEquals(node.outputs().error.get(), undefined);
    assertEquals(node.memo(), undefined);
    assertEquals(node.launches(), 0);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("OW28 — a failing compile lands an ERROR-SHAPED result, keyed: pending clears, no re-fire on re-evaluation (no timer), the retry is input-driven", async () => {
  const { runtime, storageManager, space } = await newOnRuntime(
    "compile and run served failure",
    { servingPosture: true },
  );
  try {
    const node = armed(runtime, space, "fail");
    assertEquals((await node.run(BROKEN)).error, undefined);
    // The compile failed in the effect: an error-shaped result, keyed.
    assertEquals(node.outputs().pending.get(), false, "no infinite pending");
    const hasError = node.outputs().error.get() !== undefined ||
      node.outputs().errors.get() !== undefined;
    assertEquals(hasError, true);
    assertEquals(node.outputs().result.get(), undefined);
    assertEquals(node.memo()?.requestHash, hashOfProgram(BROKEN));
    const compilesAfterFail = node.launchesOf(BROKEN);

    // Re-evaluations of the same failing program: the §4 hit — no re-fire
    // (the T14 posture, retries never timer-driven). The input-driven
    // retry to SUCCESS is pinned live in executor-compile-and-run.test.ts.
    for (let i = 0; i < 3; i++) {
      assertEquals(await node.rerun(BROKEN), undefined);
    }
    assertEquals(node.launchesOf(BROKEN), compilesAfterFail);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("OW28 — the OFF arm is unaffected: the compile launches from the action, and there is no memo cell", async () => {
  const identity = await Identity.fromPassphrase("compile and run off");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const node = armed(runtime, identity.did() as MemorySpace, "off");
    const { launchesAtAction } = await node.run(PROGRAM_A);
    assertEquals(
      launchesAtAction,
      1,
      "the OFF arm launches the compile from the action, as today",
    );
    // No memo cell exists in the OFF arm.
    assertEquals(node.memo(), undefined);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
