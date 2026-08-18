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
// - the ISSUE-TIME memo key: a same-hash re-run mid-flight WAITS (no
//   re-issue into the in-flight effect's key — probe P4's mutant turns
//   exactly this pin red);
// - a SUPERSEDED completion writes nothing, leaves the successor's landed
//   resolution intact, and reports itself (`outbox.superseded`'s source);
// - the success RE-ARM never clobbers a landed `resolvedHash` (an
//   incidental warm-cache instantiation before the completion commits);
// - the OFF arm compiles from the action, exactly as today, and has no
//   memo cell — and its pre-existing createRef-on-proxy program-change
//   defect is pinned AS IT STANDS (an owed row; not fixed here).
//
// The re-instantiation on a PROGRAM change, the piece-creation hook, the
// client read-through end to end, recovery (memo reuse across park), the
// supersession journeys (A→B→A within A's compile; the superseded
// completion's release), fan-out at cardinality 2, and the §7 counters are
// pinned LIVE against a real SpaceServer + client in
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

/** A hold on one program's compile: the wrapped compileOrGetPattern
 * enters, reports `held`, and RESUMES the real compile once `release`
 * resolves; `afterCompiled` (optional) runs after the real compile
 * resolved and BEFORE the pattern is handed back to the effect — the
 * window between "cached in the process" and "the completion commit". */
type CompileHold = {
  program: ProgramInput;
  held: () => void;
  release: Promise<void>;
  afterCompiled?: () => Promise<void>;
};

/** A builtin instance over `runtime` whose compiles are COUNTED (the real
 * compileOrGetPattern is wrapped, never replaced — the instantiate branch
 * reads the genuine content cache). */
const armed = (
  runtime: Runtime,
  space: MemorySpace,
  name: string,
  options: { hold?: CompileHold } = {},
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
    const hold = options.hold;
    if (
      hold !== undefined &&
      JSON.stringify(input) === JSON.stringify(hold.program)
    ) {
      hold.held();
      return hold.release.then(async () => {
        const pattern = await real(input, targetSpace);
        await hold.afterCompiled?.();
        return pattern;
      });
    }
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
  /** Like `run`, but WITHOUT settling: the action runs and commits (the
   * effect flush runs inline at commit and its compile may be HELD), and
   * control returns while the effect is in flight — the mid-flight
   * journeys. */
  const issue = async (program: ProgramInput) => {
    await runtime.idle();
    const tx: IExtendedStorageTransaction = runtime.edit();
    inputs.withTx(tx).set(program);
    action(tx);
    const committed = await tx.commit();
    // The flush ran (its synchronous prefix started the compile — held or
    // not — and tracked the work); the work itself may still be in flight.
    await tx.postCommitEffectsSettled();
    return { error: committed.error };
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
    issue,
    /** The raw action, for a test that drives it inside its own tx. */
    action,
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

Deno.test("OW28 — the ISSUE-TIME memo key (the review's MINOR-E): an issued request writes `requestHash` at issue, so a same-hash re-run MID-FLIGHT waits — no re-issue, no second effect, the memo untouched (the guard whose failure mode is the supersession wedge)", async () => {
  const { runtime, storageManager, space } = await newOnRuntime(
    "compile and run issue-time key",
    { servingPosture: true },
  );
  try {
    let heldCount = 0;
    const release = Promise.withResolvers<void>();
    const node = armed(runtime, space, "issue-key", {
      hold: {
        program: PROGRAM_A,
        held: () => {
          heldCount++;
        },
        release: release.promise,
      },
    });
    assertEquals((await node.issue(PROGRAM_A)).error, undefined);
    assertEquals(heldCount, 1, "the effect entered the (held) compile");
    // The issue's OWN memo write, observed mid-flight — before any
    // completion could re-assert it: `requestHash` names the request,
    // nothing is resolved, the request is pending.
    assertEquals(node.memo()?.requestHash, hashOfProgram(PROGRAM_A));
    assertEquals(node.memo()?.resolvedHash, undefined);
    assertEquals(node.memo()?.compiledHash, undefined);
    assertEquals(node.outputs().pending.get(), true);

    // Same-hash re-runs mid-flight: `stored === hash` and issued → the
    // run WAITS for the re-arm — no re-issue (one launch, one hold), the
    // memo untouched. A corrupt or missing issue-time key (probe P4's
    // mutant) reads as a NEW request here and re-issues: a second effect
    // that dedupes against the first's key — the wedge shape.
    assertEquals((await node.issue(PROGRAM_A)).error, undefined);
    assertEquals((await node.issue(PROGRAM_A)).error, undefined);
    assertEquals(node.launchesOf(PROGRAM_A), 1, "no re-issue mid-flight");
    assertEquals(heldCount, 1);
    assertEquals(node.memo()?.requestHash, hashOfProgram(PROGRAM_A));
    assertEquals(node.memo()?.resolvedHash, undefined);
    assertEquals(node.outputs().pending.get(), true);

    // Release: the compile completes, re-arms; the next run instantiates.
    release.resolve();
    await runtime.settled();
    assertEquals(node.memo()?.compiledHash, hashOfProgram(PROGRAM_A));
    assertEquals(await node.rerun(PROGRAM_A), undefined);
    assertEquals(node.outputs().pending.get(), false);
    assertEquals(
      node.outputs().result.key("answer").get() as unknown as number,
      42,
    );
    assertEquals(node.launchesOf(PROGRAM_A), 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("OW28 — a SUPERSEDED completion (the review's MAJOR-A family): an effect whose request was superseded before it completed writes NOTHING — the successor's landed resolution stands (no wipe, no clobber) — and reports itself superseded; the successor's key and cells are its own", async () => {
  const events: Array<{ kind: string; id: string }> = [];
  const { runtime, storageManager, space } = await newOnRuntime(
    "compile and run superseded completion",
    { servingPosture: true },
  );
  runtime.effectMemoObserver = (event) => {
    events.push(event);
  };
  try {
    let heldCount = 0;
    const release = Promise.withResolvers<void>();
    const node = armed(runtime, space, "superseded", {
      hold: {
        program: PROGRAM_A,
        held: () => {
          heldCount++;
        },
        release: release.promise,
      },
    });
    const B = childProgram(7);
    // A issued, its compile held; B supersedes it and LANDS (compile,
    // re-arm, instantiate) while A's effect is still in flight.
    assertEquals((await node.issue(PROGRAM_A)).error, undefined);
    assertEquals(heldCount, 1);
    assertEquals((await node.issue(B)).error, undefined);
    // Settle B: its (real) compile completes and re-arms; the re-arm run
    // instantiates B. `settled()` waits for ALL tracked work — A's held
    // compile included — so release A first, and let it complete AFTER B
    // was issued: A's completion re-reads the current request (B) and
    // must write nothing.
    release.resolve();
    await runtime.settled();
    assertEquals(node.memo()?.requestHash, hashOfProgram(B));
    assertEquals(node.memo()?.compiledHash, hashOfProgram(B));
    assertEquals(await node.rerun(B), undefined);
    assertEquals(node.outputs().pending.get(), false);
    assertEquals(
      node.outputs().result.key("answer").get() as unknown as number,
      7,
    );
    assertEquals(node.memo()?.resolvedHash, hashOfProgram(B));
    // A's completion was SUPERSEDED: reported as such (the counter's
    // source), and B's landed resolution untouched by it. A re-issue of
    // the superseded program running a FRESH effect (its key released) is
    // pinned live in executor-compile-and-run.test.ts (a bare runtime has
    // no wave cycle to serialize a re-instantiated child's async body
    // against, so program changes are not chained here).
    assertEquals(
      events.filter((e) => e.kind === "superseded").map((e) => e.id),
      [`compileAndRun:${hashOfProgram(PROGRAM_A)}`],
    );
    assertEquals(node.launchesOf(PROGRAM_A), 1);
    assertEquals(node.launchesOf(B), 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("OW28 — the success RE-ARM must not clobber a LANDED resolution (the review's MINOR-D): an incidental re-run that instantiated off the warm cache before the completion committed keeps `resolvedHash`; the completion re-arms nothing and the next run memo-HITS instead of re-instantiating the running child", async () => {
  const { runtime, storageManager, space } = await newOnRuntime(
    "compile and run re-arm no clobber",
    { servingPosture: true },
  );
  try {
    const release = Promise.withResolvers<void>();
    // The interposition: after the real compile resolved (the process
    // cache is warm) and BEFORE the effect's completion commit, an
    // incidental re-run of the derivation instantiates from the cache and
    // RESOLVES the request.
    let incidentalRuns = 0;
    const node: ReturnType<typeof armed> = armed(
      runtime,
      space,
      "rearm-clobber",
      {
        hold: {
          program: PROGRAM_A,
          held: () => {},
          release: release.promise,
          afterCompiled: async () => {
            incidentalRuns++;
            const tx: IExtendedStorageTransaction = runtime.edit();
            node.inputs.withTx(tx).set(PROGRAM_A);
            // The derivation's own run: the sync cache hits → instantiate +
            // resolve, committed before the effect's completion.
            node.action(tx);
            assertEquals((await tx.commit()).error, undefined);
          },
        },
      },
    );
    let instantiations = 0;
    const realRun = runtime.run.bind(runtime);
    (runtime as unknown as { run: typeof runtime.run }).run = (
      ...args: Parameters<typeof runtime.run>
    ) => {
      instantiations++;
      return realRun(...args);
    };
    assertEquals((await node.issue(PROGRAM_A)).error, undefined);
    release.resolve();
    await runtime.settled();
    assertEquals(incidentalRuns, 1);
    // The incidental run instantiated (once) and RESOLVED; the completion
    // that followed must not have cleared that resolution.
    assertEquals(instantiations, 1);
    assertEquals(node.outputs().pending.get(), false);
    assertEquals(node.memo()?.resolvedHash, hashOfProgram(PROGRAM_A));
    assertEquals(node.memo()?.requestHash, hashOfProgram(PROGRAM_A));
    // The next run is a memo HIT: no second instantiation of the running
    // child (at eb6d1e4bb the completion's `set` dropped `resolvedHash`,
    // so this run re-instantiated — stop + run — once more).
    assertEquals(await node.rerun(PROGRAM_A), undefined);
    assertEquals(instantiations, 1, "no re-instantiation after the re-arm");
    assertEquals(node.outputs().pending.get(), false);
    assertEquals(
      node.outputs().result.key("answer").get() as unknown as number,
      42,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("OFF-arm DEFECT, pre-existing (the review's MINOR-C; owed — verification-coverage.md OW28's createRef row): a same-node PROGRAM CHANGE in a WARM process serves the PRIOR pattern — `compileOrGetPattern(proxy)` keys the content cache by `createRef` of the asSchema proxy, which is insensitive to nested `contents`. Pinned AS IT STANDS so the fix flips this test; not fixed here (OFF behavior is out of this PR's scope)", async () => {
  const identity = await Identity.fromPassphrase("compile and run off defect");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const node = armed(runtime, identity.did() as MemorySpace, "off-defect");
    const realCompiles: ProgramInput[] = [];
    const pm = runtime.patternManager as unknown as {
      compilePattern: (
        input: ProgramInput,
        options?: unknown,
      ) => Promise<unknown>;
    };
    const realCompile = pm.compilePattern.bind(pm);
    pm.compilePattern = (input, options) => {
      realCompiles.push(input);
      return realCompile(input, options);
    };
    const settledOff = async () => {
      // The OFF arm's compile promise floats (untracked): drain reactive
      // work and step the fake clock until `pending` clears.
      for (let i = 0; i < 500 && node.outputs().pending.get() !== false; i++) {
        await runtime.idle();
        await clock.tick(20);
      }
      await runtime.settled();
      await runtime.idle();
    };
    const B = childProgram(7);
    assertEquals((await node.run(PROGRAM_A)).error, undefined);
    await settledOff();
    assertEquals(
      node.outputs().result.key("answer").get() as unknown as number,
      42,
    );
    assertEquals(realCompiles.length, 1);

    // The program CHANGES on the same node, in the same (warm) process.
    assertEquals((await node.run(B)).error, undefined);
    await settledOff();
    assertEquals(node.outputs().pending.get(), false);
    // THE DEFECT: the child still serves the PRIOR program's value, and no
    // second real compile ran — the proxy's content-cache key collapsed
    // both programs onto one entry (`createRef({ src: proxy })` reads no
    // nested `contents`), so the change was handed program A's pattern.
    // The correct outcome is `answer === 7` and a second real compile;
    // when the owning layer (create-ref.ts / pattern-manager.ts —
    // normalize at the source) fixes this, flip these two assertions.
    assertEquals(
      node.outputs().result.key("answer").get() as unknown as number,
      42,
      "DEFECT pinned as it stands: the prior program's pattern is served",
    );
    assertEquals(
      realCompiles.length,
      1,
      "DEFECT pinned as it stands: no real compile of the changed program",
    );
    // The ON arm keys the cache by a PLAIN program (`plainProgramOf`) —
    // both the compile and the sync lookup — so it does not share this;
    // its program-change re-compile is pinned live in
    // executor-compile-and-run.test.ts (answer 42→7→99).
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
