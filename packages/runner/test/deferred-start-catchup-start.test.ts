import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";

// A commit-gated piece start whose transaction is REFUSED for a stale
// confirmed read. Under server-side execution that refusal is the expected
// shape of first hydration, not an exceptional one: the piece is materialized
// server-side, and the client's deferred start reads the piece's computed
// documents to base its transaction on exactly while the serving loop's
// derived commits are materializing them. Terminating there left the piece
// with no client-side context for the whole session — its install is rolled
// back by the error arm's cancel and nothing re-ran it — so every read that
// depended on it resolved to nothing while the store held every append
// (verification-coverage.md OW45 arm B; the run b04 catch).
//
// The RULED disposition (owner ack 2026-08-24) is CATCH-UP-AND-START: treat
// the refusal as "the server won the race", wait for the conflicting
// documents to arrive (the conflict's readiness gate + the named document's
// pull), then START the runner against the served documents through the
// ordinary load walk — COMMITTING NOTHING in the recovery arm. Explicitly
// not #6208's re-commit retry (census-proved non-convergent, closed), and
// not today's refuse-to-start. The arm is gated ON-only: under OFF a stale
// confirmed read on a deferred start means another CLIENT raced, and the
// cross-tab mutex semantics own that story — the OFF arm stays byte-for-byte
// today's terminal behavior, pinned below.
//
// These tests drive the runner through its public surface and refuse the
// START transaction at the transaction seam — the idiom this package already
// uses to isolate a commit-classification decision from every other moving
// part (edit-with-retry-classification.test.ts,
// compile-cache-writeback-conflict.test.ts). Refusing at the memory server
// instead cannot reach this path: a start whose setup already committed with
// its handler's transaction carries no operations of its own, so its commit
// never makes a server round trip at all, while the real first-hydration
// start (whose setup rides the start) does. The refusal object is the shape
// `toRejectedError` (storage/v2.ts) produces from the wire — the engine's own
// message text, plus the conflict descriptor it parses out of it — so the
// discriminator under test sees exactly what a real refusal presents.

const signer = await Identity.fromPassphrase("deferred start catch up");
const space = signer.did();

/**
 * Refuse the first `count` START transactions with `error`, and nothing
 * else. A start transaction is recognized by the runner handing it to
 * `startWithTx` — which happens before the commit — so this refuses exactly
 * the transaction under test and leaves every other commit of the run
 * (the setup, the scheduler's runs, the readiness pull) untouched.
 *
 * With `count` at MAX_SAFE_INTEGER the injector doubles as the NO-RECOMMIT
 * witness: any second commit of a start-marked transaction would be refused
 * and counted, so `refusals() === 1` after recovery proves the recovery arm
 * never re-committed a deferred start (#6208's retry shape).
 *
 * `refusalsReach(n)` resolves when the nth refusal has been delivered.
 * Awaiting a signal like this is what makes these tests deterministic
 * without a clock: an event that never happens lets the event loop quiesce,
 * and Deno fails the pending wait at once, naming the test
 * (docs/development/waiting-in-tests.md — the no-deadline signal idiom of
 * scheduler-event-receipts.test.ts).
 */
function refuseDeferredStartCommits(
  runtime: Runtime,
  error: { name: string; message: string },
  count = 1,
  /** Runs synchronously as the refusal is delivered — BEFORE the runner's
   * commit continuation observes it. That is the only way a test can place
   * an event inside the window between the refusal and the recovery's
   * scheduling. */
  onRefusal?: () => void,
): {
  refusalsReach(n: number): Promise<void>;
  refusals(): number;
  restore(): void;
} {
  const originalEdit = runtime.edit.bind(runtime);
  const runner = runtime.runner as unknown as {
    startWithTx: (...args: unknown[]) => () => void;
  };
  const originalStartWithTx = runner.startWithTx;
  const startTransactions = new WeakSet<object>();
  const waiters = new Map<number, ReturnType<typeof Promise.withResolvers>>();
  let refusals = 0;

  runner.startWithTx = (...args: unknown[]) => {
    startTransactions.add(args[0] as object);
    return Reflect.apply(originalStartWithTx, runtime.runner, args) as () =>
      void;
  };

  (runtime as unknown as { edit: typeof runtime.edit }).edit = ((
    ...args: Parameters<typeof runtime.edit>
  ) => {
    const tx = originalEdit(...args);
    const commit = tx.commit.bind(tx);
    (tx as unknown as { commit: typeof tx.commit }).commit = (() => {
      if (refusals >= count || !startTransactions.has(tx)) return commit();
      refusals++;
      onRefusal?.();
      for (const [at, waiter] of waiters) {
        if (at <= refusals) waiter.resolve(undefined);
      }
      // A refused commit applies nothing, so discard this attempt's writes
      // the way the rollback behind a server refusal does.
      tx.abort(error.message);
      return Promise.resolve({ error });
    }) as typeof tx.commit;
    return tx;
  }) as typeof runtime.edit;

  return {
    refusalsReach: (n: number) => {
      if (refusals >= n) return Promise.resolve();
      let waiter = waiters.get(n);
      if (waiter === undefined) {
        waiter = Promise.withResolvers();
        waiters.set(n, waiter);
      }
      return waiter.promise as Promise<void>;
    },
    refusals: () => refusals,
    restore: () => {
      (runtime as unknown as { edit: typeof runtime.edit }).edit = originalEdit;
      runner.startWithTx = originalStartWithTx;
    },
  };
}

/**
 * Await a signal the test itself resolves. Deliberately no deadline: a
 * signal that never arrives lets the event loop quiesce and Deno fails the
 * pending wait, naming the test — which is the RED these pins are watched
 * at. The label keeps that failure readable.
 */
async function waitForSignal(
  signal: Promise<void>,
  _label: string,
): Promise<void> {
  await signal;
}

/**
 * Watch the runner assemble the client-side piece context for one result:
 * how many context installs ran, and whether one ever ran while a previous
 * one was still registered — the double-install question a recovery raises.
 *
 * Hooked at `startCore` rather than `startWithTx`, because the two context
 * paths meet there: the deferred first attempt reaches it through
 * `startWithTx`, and the catch-up recovery reaches it through the ordinary
 * load walk (`doStart`), which never passes `startWithTx` at all.
 *
 * Deliberately passes `startCore`'s return value through UNCHANGED. The
 * runner compares that exact cancel against its registry to decide whether
 * an ownership still owns the registration, so a harness that wraps it
 * silently suppresses every teardown and would manufacture the very
 * concurrency it claims to measure. Liveness is read from the runner's own
 * registry instead.
 */
function observeContextInstalls(
  runtime: Runtime,
  matches: (cell: Cell<unknown>) => boolean,
  registered: () => boolean,
): {
  installs(): number;
  everConcurrent(): boolean;
  nth(n: number): Promise<void>;
  restore(): void;
} {
  const runner = runtime.runner as unknown as {
    startCore: (...args: unknown[]) => () => void;
  };
  const original = runner.startCore;
  const waiters = new Map<number, ReturnType<typeof Promise.withResolvers>>();
  let installs = 0;
  let everConcurrent = false;

  runner.startCore = (...args: unknown[]) => {
    if (matches(args[0] as Cell<unknown>)) {
      // Read BEFORE this install registers: a registration still standing
      // here belongs to a previous attempt that was never torn down.
      if (registered()) everConcurrent = true;
      installs++;
      for (const [at, waiter] of waiters) {
        if (at <= installs) waiter.resolve(undefined);
      }
    }
    return Reflect.apply(original, runtime.runner, args) as () => void;
  };

  return {
    installs: () => installs,
    everConcurrent: () => everConcurrent,
    nth: (n: number) => {
      if (installs >= n) return Promise.resolve();
      let waiter = waiters.get(n);
      if (waiter === undefined) {
        waiter = Promise.withResolvers();
        waiters.set(n, waiter);
      }
      return waiter.promise as Promise<void>;
    },
    restore: () => {
      runner.startCore = original;
    },
  };
}

/**
 * Count commits that reach the STORE's door from the moment `arm()` is
 * called: the replica's `commitNative` is the one gate every store-bound
 * commit passes (a transaction with no operations short-circuits before it,
 * and an overlay-diverted seal never reaches it). This is the "COMMITTING
 * NOTHING" witness for the recovery arm — after the refusal, the catch-up
 * start must put nothing through this door.
 */
function countStoreCommits(
  storageManager: ReturnType<typeof StorageManager.emulate>,
): { arm(): void; count(): number; restore(): void } {
  const replica = storageManager.open(space).replica as unknown as {
    commitNative: (...args: unknown[]) => unknown;
  };
  const original = replica.commitNative;
  let armed = false;
  let count = 0;
  replica.commitNative = function (...args: unknown[]) {
    if (armed) count++;
    return Reflect.apply(original, this, args);
  };
  return {
    arm: () => {
      armed = true;
    },
    count: () => count,
    restore: () => {
      replica.commitNative = original;
    },
  };
}

// The gated-start shape the navigate path mints: an immediate transaction
// that defers the runner's start until it commits.
function gatedTxOn(runtime: Runtime) {
  const tx = runtime.edit();
  tx.tx.immediate = true;
  (tx.tx as { deferRunnerStartUntilCommit?: boolean })
    .deferRunnerStartUntilCommit = true;
  return tx;
}

// A stale-confirmed-read refusal in the shape `toRejectedError` hands the
// runner: the engine's message plus the conflict descriptor parsed from it.
// It names a REAL document, so the readiness pull the recovery performs
// resolves against the store instead of a phantom id.
function staleConfirmedReadOf(cell: Cell<unknown>) {
  const id = cell.getAsNormalizedFullLink().id;
  return {
    name: "ConflictError",
    message: `stale confirmed read: ${id} at seq 0 conflicted with seq 10`,
    conflict: { space, the: "application/json", of: id },
  };
}

describe("a deferred start refused for a stale confirmed read, flag-ON", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  // The registration key the runner indexes cancels by.
  function key(cell: Cell<unknown>) {
    return entityKey(
      cell.getAsNormalizedFullLink(),
      runtime.scopeKeyIdentity,
    );
  }

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // EXPLICITLY flag-ON, with no serving posture: a flag-ON CLIENT — the
    // arm the OW45 arm-B defect was caught on (run b04) and the only arm
    // the catch-up recovery is gated to.
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("starts the piece from served state, re-committing nothing", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "started from served state after a stale confirmed read",
      undefined,
      tx,
    );
    // MAX-armed: a re-commit of ANY start transaction would be refused and
    // counted, so refusals() staying 1 is the no-recommit proof.
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
      Number.MAX_SAFE_INTEGER,
    );
    const storeCommits = countStoreCommits(storageManager);
    const installed = observeContextInstalls(
      runtime,
      (cell) => key(cell) === key(result),
      () => runtime.runner.cancels.has(key(result)),
    );
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        injector.refusalsReach(1),
        "the start's transaction being refused",
      );
      // From here on, everything that reaches the store's door is counted:
      // the recovery arm must put NOTHING through it.
      storeCommits.arm();

      await waitForSignal(
        installed.nth(2),
        "the catch-up recovery assembling the piece context",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      // The refusal really happened, exactly once — the recovery never
      // re-committed a start transaction…
      expect(injector.refusals()).toBe(1);
      // …the piece is RUNNING (the b04 death left no registration here)…
      expect(runtime.runner.cancels.has(key(result))).toBe(true);
      // …and the recovery arm committed NOTHING: not one commit reached
      // the store's door after the refusal.
      expect(storeCommits.count()).toBe(0);
      // Its dependent reads resolve (the client context serves them). The
      // pull-then-read is this harness's readable path for a derived value
      // — the CLEAN gated ON run reads the same way — and a pull is a
      // read, so the zero-commit count above already stands.
      await result.pull();
      expect(result.get()?.doubled).toBe(6);
    } finally {
      installed.restore();
      storeCommits.restore();
      injector.restore();
    }
  });

  it("holds at most one live piece context across refusal and recovery", async () => {
    // The recovery must not leave the refused attempt's client-side piece
    // context installed beside its own. Counted at the runner's own
    // registration index: an install adds this result's key, a teardown
    // removes it, and the two must alternate — never two live at once.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "one live context across refusal and recovery",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
    );
    const installed = observeContextInstalls(
      runtime,
      (cell) => key(cell) === key(result),
      () => runtime.runner.cancels.has(key(result)),
    );
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        installed.nth(2),
        "the catch-up recovery assembling the piece context",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      // Two context assemblies ran — the refused attempt's and the
      // recovery's — and at no point did two installs coexist.
      expect(installed.installs()).toBe(2);
      expect(installed.everConcurrent()).toBe(false);
      expect(runtime.runner.cancels.has(key(result))).toBe(true);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("abandons the recovery when the piece is stopped first", async () => {
    // The zombie case: the user navigated away, or the piece was disposed,
    // between the refusal and the recovery. The pending recovery is
    // registered under the result's key BEFORE its readiness gate is
    // awaited, so the stop tombstones it through the same path that
    // tombstones a pending first attempt — it must install nothing.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "stopped between the refusal and the recovery",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
    );
    const installed = observeContextInstalls(
      runtime,
      (cell) => key(cell) === key(result),
      () => runtime.runner.cancels.has(key(result)),
    );
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        injector.refusalsReach(1),
        "the start's transaction being refused",
      );
      runtime.runner.stop(result);

      // Settle whatever the recovery chain still has to do, then assert it
      // did nothing: the refused attempt's install is the only one there
      // ever was, nothing is registered, and no recovery is left pending
      // to fire into a piece the session has moved on from.
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      expect(installed.installs()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("schedules no recovery once the runtime has been torn down", async () => {
    // The teardown window the ownership token alone does not cover. The
    // recovery registers a FRESH token under the result's key — but
    // `stopAll()` cancels the tokens it can SEE and clears that map, so a
    // teardown landing before the refusal's continuation runs leaves
    // nothing to cancel a token minted after it. Without a lifecycle check
    // the recovery then installs a piece onto a runner that has been
    // explicitly torn down.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "torn down before the recovery was scheduled",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
      1,
      // Inside the window: the runner is torn down while the refusal is in
      // flight, so the teardown cannot see a token that does not exist yet.
      () => runtime.runner.stopAll(),
    );
    const installed = observeContextInstalls(
      runtime,
      (cell) => key(cell) === key(result),
      () => runtime.runner.cancels.has(key(result)),
    );
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      // The refused attempt is the only one that ever installed, and the
      // torn-down runner holds no registration for the piece.
      expect(injector.refusals()).toBe(1);
      expect(installed.installs()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("keeps every other refusal terminal, on the first attempt", async () => {
    // The discriminator. A refusal that does not name a stale confirmed read
    // describes no basis served documents repair, so the recovery must not
    // fire: one attempt, terminal, exactly as before this arm existed.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    for (
      const refusal of [
        // A CFC / speculative-basis style pre-storage refusal.
        {
          name: "StorageTransactionAborted",
          message: "CFC enforcement rejected commit: prepared digest changed",
        },
        // A deterministic server-side commit-rule refusal.
        {
          name: "RowLabelCommitError",
          message: "row label rule refused the commit",
        },
        // The OTHER ConflictError shape: this session's own earlier commit is
        // unresolved, which served documents do not settle.
        {
          name: "ConflictError",
          message: "pending dependency not resolved: 7",
        },
      ]
    ) {
      const tx = gatedTxOn(runtime);
      const result = runtime.getCell<{ doubled?: number }>(
        space,
        `terminal on ${refusal.name}: ${refusal.message}`,
        undefined,
        tx,
      );
      const injector = refuseDeferredStartCommits(
        runtime,
        refusal,
        Number.MAX_SAFE_INTEGER,
      );
      const installed = observeContextInstalls(
        runtime,
        (cell) => key(cell) === key(result),
        () => runtime.runner.cancels.has(key(result)),
      );
      try {
        runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
        expect((await tx.commit()).error).toBeUndefined();

        await waitForSignal(
          injector.refusalsReach(1),
          `the start's transaction being refused with ${refusal.name}`,
        );
        await runtime.runner.idleDeferredStartCatchUps();
        await runtime.idle();

        expect(injector.refusals()).toBe(1);
        expect(installed.installs()).toBe(1);
        expect(runtime.runner.cancels.has(key(result))).toBe(false);
      } finally {
        installed.restore();
        injector.restore();
      }
    }
  });

  it("mints no speculative consequence on the recovery", async () => {
    // serving-loop.md §3d's sanction stamps the DEFERRED START transaction
    // as a speculative consequence when one exists; the recovery arm mints
    // no start transaction at all (the load walk's own instantiation
    // transaction keeps its sanctioned bookkeeping stamp, exactly as a
    // reload's does), so not one event-handler seal may appear.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "a recovery that mints no consequence",
      undefined,
      tx,
    );
    const overlay = runtime.speculationOverlay;
    expect(overlay).toBeDefined();
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
    );
    const installed = observeContextInstalls(
      runtime,
      (cell) => key(cell) === key(result),
      () => runtime.runner.cancels.has(key(result)),
    );
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        installed.nth(2),
        "the catch-up recovery assembling the piece context",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      // The recovery ran and the piece is running — and not one
      // event-handler seal was minted along the way.
      expect(injector.refusals()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(true);
      expect(overlay!.eventEchoSealCount).toBe(0);
    } finally {
      installed.restore();
      injector.restore();
    }
  });
});

describe("a deferred start refused for a stale confirmed read, flag-OFF", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  function key(cell: Cell<unknown>) {
    return entityKey(
      cell.getAsNormalizedFullLink(),
      runtime.scopeKeyIdentity,
    );
  }

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // The first-party default: no server-execution flag. Under OFF a stale
    // confirmed read on a deferred start means another CLIENT raced, and
    // the cross-tab mutex semantics own that story — the refusal stays
    // terminal, byte-for-byte today's behavior.
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("stays terminal: one attempt, no recovery, no registration", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "terminal under OFF",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
      Number.MAX_SAFE_INTEGER,
    );
    const installed = observeContextInstalls(
      runtime,
      (cell) => key(cell) === key(result),
      () => runtime.runner.cancels.has(key(result)),
    );
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        injector.refusalsReach(1),
        "the start's transaction being refused",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      expect(injector.refusals()).toBe(1);
      expect(installed.installs()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      installed.restore();
      injector.restore();
    }
  });
});
