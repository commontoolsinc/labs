import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "./support/trusted-builder.ts";
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

  it("lets a stop during the refusal's round trip WIN: no revival", async () => {
    // The widest async window in the flow: the deferred start INSTALLS its
    // context before startTx.commit() is issued, so a user can navigate in
    // and away while the refusal is still in flight. The stop tears the
    // context down and — because the install's ownership unregistered at
    // markInstalled — leaves no pending token for the stop to cancel, and
    // it bumps no epoch. The recovery must NOT override that stop: it
    // recovers only an attempt whose install is STILL THE CURRENT
    // REGISTRATION when the refusal lands. A revived piece here would be a
    // permanent leak — its parent already released it, and nothing ever
    // releases it again (review F1; the reviewer's probe watched exactly
    // this revival).
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "stopped while the refusal was in flight",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
      1,
      // Inside the round trip: the stop lands as the refusal is delivered,
      // BEFORE the error arm's continuation observes it. Unlike stopAll,
      // a plain stop bumps no lifecycle epoch — this is the window only
      // the install-still-current check can cover.
      () => runtime.runner.stop(result),
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

      // The stopped attempt's install is the only assembly there ever was,
      // and the explicitly stopped piece stays stopped.
      expect(injector.refusals()).toBe(1);
      expect(installed.installs()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("keeps the parent's cancel handle potent across the recovery", async () => {
    // The parent of a deferred start holds ONE handle — the Cancel that
    // runWithStartOwnership returned — registered in its cancel group and
    // its lineage piece-stop. The old error arm SPENT that handle's token
    // (ownership.cancel) before scheduling the recovery under a fresh one,
    // so a parent teardown after the refusal could no longer reach the
    // recovered run (review F1's second face; Cubic's P1). The recovery
    // must ride the SAME token the parent holds: cancelling it during the
    // wait tombstones the recovery, and cancelling it after the walk stops
    // the recovered run.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const harness = runtime.runner.accessForTestingOnly;
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "parent cancel reaches the recovered run",
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
      const { cancelDeferredStart } = harness.runWithStartOwnership(
        tx,
        trustExecutable(runtime, Piece),
        { value: 3 },
        result.withTx(tx),
      );
      expect(cancelDeferredStart).toBeDefined();
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        installed.nth(2),
        "the catch-up recovery assembling the piece context",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();
      expect(runtime.runner.cancels.has(key(result))).toBe(true);

      // The parent tears down through the one handle it has ever held.
      cancelDeferredStart!();
      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("never binds the parent's token to a COMPETING start's registration", async () => {
    // Cubic's P1 on the in-claim hand-off, confirmed in code: the
    // recovery's own entry stop EMPTIES the registry, so a fresh
    // competing start (a second navigate's public start()) can install
    // during the walk's real awaits WITHOUT any stop — no generation
    // bump, nothing for the claim's checks to see. The walk's mid-resume
    // re-check then reports "already started" as success for a
    // registration THIS attempt never created, and an identity-blind
    // hand-off would bind the parent's token to the competitor's run —
    // whose lifecycle the parent does not own: a later parent cancel
    // would tear down the user's independent navigate (the token's
    // registry-guarded stop is authoritative and bypasses the
    // independent-start shield that releaseChild honors). The hand-off
    // must be EXACT: only the registration the walk's own attempt
    // created, still current.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const harness = runtime.runner.accessForTestingOnly;
    // Replaced by assignment below, which only a TypeScript-private member
    // allows, so it is reached the old way.
    const stubbed = runtime.runner as unknown as {
      syncCellsForRunningPattern(...args: unknown[]): Promise<unknown>;
    };
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "a competing start claims the piece mid-walk",
      undefined,
      tx,
    );
    // The refusal carries a readiness gate that runs AFTER the recovery's
    // entry (whose teardown re-arms the local-assembly shortcuts) and
    // BEFORE the walk: clearing the shortcuts there forces the walk onto
    // the RESUME path, whose dependency-sync await is the real-world
    // interleaving window (a cold resume looks exactly like this).
    const refusal = {
      ...staleConfirmedReadOf(result),
      readyToRetry: () => {
        harness.locallyStoppedResults.delete(key(result));
        harness.locallyPreparedResults.delete(key(result));
        return Promise.resolve();
      },
    };
    const injector = refuseDeferredStartCommits(runtime, refusal);
    // The competitor: a second, independent public start of the same
    // result (the navigate landing flow), fired inside the recovery
    // walk's dependency-sync await.
    const originalSync = stubbed.syncCellsForRunningPattern;
    let competitorRan = false;
    stubbed.syncCellsForRunningPattern = async function (...args: unknown[]) {
      if (
        !competitorRan &&
        key(args[0] as Cell<unknown>) === key(result)
      ) {
        competitorRan = true;
        // The entry-stop cleared these too late for the injector hook
        // above to matter to the competitor; make the competitor's own
        // walk take whatever path it finds — it installs either way.
        await runtime.runner.start(result);
      }
      return Reflect.apply(originalSync, runtime.runner, args);
    };
    try {
      const { cancelDeferredStart } = harness.runWithStartOwnership(
        tx,
        trustExecutable(runtime, Piece),
        { value: 3 },
        result.withTx(tx),
      );
      expect(cancelDeferredStart).toBeDefined();
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        injector.refusalsReach(1),
        "the start's transaction being refused",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      // The competitor ran and owns the piece.
      expect(competitorRan).toBe(true);
      expect(runtime.runner.cancels.has(key(result))).toBe(true);

      // The parent's handle must NOT reach the competitor's run: its
      // token was never bound to a registration this attempt did not
      // create, so this cancel is a tombstone, and the user's
      // independently started piece keeps running.
      cancelDeferredStart!();
      expect(runtime.runner.cancels.has(key(result))).toBe(true);
    } finally {
      stubbed.syncCellsForRunningPattern = originalSync;
      injector.restore();
    }
  });

  it("lets a parent cancel landing MID-WALK stop the recovered run", async () => {
    // The delta review's D1, watched red at the pre-fix head (the
    // reviewer's probe: `registered-after-parent-cancel: true`). The
    // parent's handle fires DURING the recovery's walk — after the
    // readiness wait resolved, before the walk's install lands. The
    // token's cancel is a ONE-SHOT `stopped` latch: fired against the
    // STALE install of the refused attempt it is a registry-guarded
    // no-op that BURNS the latch, and the hand-off's later
    // markInstalled(current) then returns at the latch WITHOUT stopping
    // the freshly recovered run — a leaked live piece with every parent
    // handle spent, the F1 leak one window later. The recovery must
    // leave no registration behind this ordering.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const harness = runtime.runner.accessForTestingOnly;
    // Replaced by assignment below, which only a TypeScript-private member
    // allows, so it is reached the old way.
    const stubbed = runtime.runner as unknown as {
      startCore: (...args: unknown[]) => () => void;
    };
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "parent cancel mid-walk stops the recovery",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
    );
    // Fire the parent's handle synchronously INSIDE the recovery's context
    // assembly — the widest point of the walk window.
    let parentCancel: (() => void) | undefined;
    let assemblies = 0;
    const originalStartCore = stubbed.startCore;
    stubbed.startCore = (...args: unknown[]) => {
      if (key(args[0] as Cell<unknown>) === key(result)) {
        assemblies++;
        if (assemblies === 2) parentCancel?.();
      }
      return Reflect.apply(originalStartCore, runtime.runner, args) as () =>
        void;
    };
    try {
      const { cancelDeferredStart } = harness.runWithStartOwnership(
        tx,
        trustExecutable(runtime, Piece),
        { value: 3 },
        result.withTx(tx),
      );
      expect(cancelDeferredStart).toBeDefined();
      parentCancel = cancelDeferredStart;
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        injector.refusalsReach(1),
        "the start's transaction being refused",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      // Both assemblies ran (the refused attempt's and the recovery's),
      // the mid-walk cancel landed, and NOTHING stays registered: the
      // recovered run was stopped, not leaked.
      expect(assemblies).toBe(2);
      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      stubbed.startCore = originalStartCore;
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

  it("awaits the wire's readyToRetry gate before walking", async () => {
    // The readiness fidelity pin (Cubic P2 / review F12): the wire attaches
    // `readyToRetry` = the session catch-up to a real refusal, and the
    // recovery must actually AWAIT it — walking before the conflicting
    // documents arrived would re-read the same pre-birth absence. The
    // injected refusal carries a gate the test holds: the walk must not
    // assemble while it is held, and must assemble once released.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "recovery held on the readiness gate",
      undefined,
      tx,
    );
    const gate = Promise.withResolvers<void>();
    let gateAwaited = 0;
    const refusal = {
      ...staleConfirmedReadOf(result),
      readyToRetry: () => {
        gateAwaited++;
        return gate.promise;
      },
    };
    const injector = refuseDeferredStartCommits(runtime, refusal);
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
      await runtime.idle();

      // The gate is held: the refused install was torn down and NOTHING
      // has re-assembled — the recovery is waiting on the wire.
      expect(gateAwaited).toBe(1);
      expect(installed.installs()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(false);

      gate.resolve();
      await waitForSignal(
        installed.nth(2),
        "the catch-up recovery assembling after the gate released",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      expect(installed.installs()).toBe(2);
      expect(runtime.runner.cancels.has(key(result))).toBe(true);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("recovers the engine's sibling staleness shape: stale pending read", async () => {
    // The engine emits TWO staleness messages, both meaning "a document this
    // basis read has advanced; a catch-up and fresh read is what converges":
    // `stale confirmed read` (validateConfirmedReads, engine.ts) and
    // `stale pending read` (resolvePendingReads — a read through the
    // session's own accepted layers whose underlying doc advanced; reachable
    // in the same first-hydration race whenever the serving side's commit
    // advances a pending-read target while the confirmed reads pass). Both
    // recover; leaving the pending sibling terminal would keep the b04 death
    // alive under that message (review F4).
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "recovered from a stale pending read",
      undefined,
      tx,
    );
    const id = result.getAsNormalizedFullLink().id;
    const injector = refuseDeferredStartCommits(
      runtime,
      {
        name: "ConflictError",
        message: `stale pending read: ${id} via localSeq 5 conflicted ` +
          "with seq 10",
      },
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
        installed.nth(2),
        "the catch-up recovery assembling the piece context",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      expect(injector.refusals()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(true);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("keeps every other refusal terminal, on the first attempt", async () => {
    // The discriminator. A refusal that does not name a stale read basis
    // describes nothing served documents repair, so the recovery must not
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
        // The commit-precondition shape: the committed data's own
        // precondition (create-only / value-hash) failed on its merits —
        // re-running double-handles, never converges.
        {
          name: "ConflictError",
          message: "entity-value-hash precondition target changed: of:x",
        },
        // A client-fabricated withdrawal that EMBEDS the staleness phrase
        // (makeLocalRejection mints ConflictError from verbatim messages;
        // wave withdrawals wrap inner errors). Classification is anchored
        // to the message HEAD, so an embedded phrase must not trigger the
        // recovery — a withdrawal is not a stale basis (review note F5).
        {
          name: "ConflictError",
          message: "seal failed: inner refusal was: stale confirmed read: " +
            "of:x at seq 0 conflicted with seq 9",
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

  it("contains a recovery whose walk throws: loud, settled, no zombie", async () => {
    // The recovery's failure arm. A load walk can genuinely fail (the r06/r09
    // gate runs' stranded shape rides a pattern-load failure downstream), and
    // the arc's rule for a piece with no client context is LOUD, never
    // silent: the rejection must be contained (an unhandled rejection fails
    // this test on its own), the catch-up chain must settle (the idle hook
    // returns), and no registration or pending recovery may linger.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTxOn(runtime);
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "a recovery whose walk throws",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
    );
    // Fail the SECOND context assembly (the recovery's) at the same seam the
    // install observer hooks: the first attempt wires normally and is torn
    // down by the refusal; the recovery's walk then dies synchronously.
    const runner = runtime.runner as unknown as {
      startCore: (...args: unknown[]) => () => void;
    };
    const originalStartCore = runner.startCore;
    let assemblies = 0;
    runner.startCore = (...args: unknown[]) => {
      const cell = args[0] as Cell<unknown>;
      if (key(cell) === key(result)) {
        assemblies++;
        if (assemblies >= 2) {
          throw new Error("injected: the recovery walk's assembly failed");
        }
      }
      return Reflect.apply(originalStartCore, runtime.runner, args) as () =>
        void;
    };
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        injector.refusalsReach(1),
        "the start's transaction being refused",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      // Both assemblies were attempted, the failure was contained, and the
      // runner holds neither a registration nor a pending recovery.
      expect(assemblies).toBe(2);
      expect(injector.refusals()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      runner.startCore = originalStartCore;
      injector.restore();
    }
  });

  it("routes the cross-space arm's refusal to the recovery; without served state it fails loud and contained", async () => {
    // The SIBLING deferred start (runPatternAfterSuccessfulCommit — the
    // navigateTo receipt shape) meets the identical first-hydration race and
    // shares the recovery. Driven directly at the private seam, the idiom
    // child-run-ownership.test.ts established for exactly this method. One
    // deliberate difference from the primary arm, pinned here as the
    // DISCLOSED design-check caveat: this arm's SETUP rides the deferred
    // transaction itself, so its recovery depends on the server's own
    // create having landed. In this single-runtime harness nothing served
    // the result, so the recovery must fail LOUD and contained — the chain
    // settles, no registration remains, no unhandled rejection escapes
    // (which would fail this test on its own) — never the silent terminal
    // death of the old arm.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const harness = runtime.runner.accessForTestingOnly;
    // Replaced by assignment below, which only a TypeScript-private member
    // allows, so it is reached the old way.
    const stubbed = runtime.runner as unknown as {
      catchUpAndStartOnStaleRead(...args: unknown[]): boolean;
    };
    const tx = runtime.edit();
    const receipt = runtime.getCell<Record<string, unknown>>(
      space,
      "a cross-space deferred start refused for a stale confirmed read",
      undefined,
      tx,
    );
    // THIS pin refuses at the STORE DOOR (replica.commitNative), not at
    // the tx seam: the cross-space arm's startTx carries the SETUP (this
    // arm's defining difference), so runWithStartOwnership attached a
    // failure-compensation commit callback to it — and the tx-seam
    // injector's abort() settles that callback with an ABORT-shaped
    // error, which releases the install BEFORE the error arm (an injector
    // artifact: a real wire refusal settles the callbacks with the
    // ConflictError itself, whose compensation exception keeps the
    // install). Because this startTx carries operations, it genuinely
    // reaches the store door — the primary arm's op-less startTx cannot —
    // so here the refusal can ride the REAL commit machinery end to end.
    const error = staleConfirmedReadOf(receipt);
    const runnerForMark = runtime.runner as unknown as {
      startWithTx: (...args: unknown[]) => (() => void) | undefined;
    };
    const originalStartWithTx = runnerForMark.startWithTx;
    const startTransactions = new WeakSet<object>();
    runnerForMark.startWithTx = (...args: unknown[]) => {
      startTransactions.add(
        (args[0] as { tx?: object }).tx ?? (args[0] as object),
      );
      return Reflect.apply(originalStartWithTx, runtime.runner, args) as
        | (() => void)
        | undefined;
    };
    const replica = storageManager.open(space).replica as unknown as {
      commitNative: (...args: unknown[]) => unknown;
    };
    const originalCommitNative = replica.commitNative;
    const refusalWaiter = Promise.withResolvers<void>();
    let refusals = 0;
    replica.commitNative = function (...args: unknown[]) {
      const candidate = args[1] as { tx?: object } | object;
      const inner = (candidate as { tx?: object }).tx ?? candidate;
      if (
        startTransactions.has(candidate as object) ||
        startTransactions.has(inner as object)
      ) {
        refusals++;
        refusalWaiter.resolve();
        return Promise.resolve({ error });
      }
      return Reflect.apply(originalCommitNative, this, args);
    };
    // The ROUTING witness (review F13 / Cubic P2): the old terminal path
    // also produces one refusal, no registration, and a settled idle, so
    // those observables alone cannot tell recovery from terminal death.
    // Instrument the recovery entry point for this receipt: the pin
    // demands the error arm actually ROUTED here and the recovery was
    // SCHEDULED — deleting the call site from
    // runPatternAfterSuccessfulCommit reds this, where it used to pass.
    const originalEntry = stubbed.catchUpAndStartOnStaleRead;
    let routed = 0;
    let scheduled = 0;
    stubbed.catchUpAndStartOnStaleRead = function (...args: unknown[]) {
      const took = Reflect.apply(
        originalEntry,
        runtime.runner,
        args,
      ) as boolean;
      if (key(args[1] as Cell<unknown>) === key(receipt)) {
        routed++;
        if (took) scheduled++;
      }
      return took;
    };
    try {
      harness.runPatternAfterSuccessfulCommit(
        tx,
        receipt,
        trustExecutable(runtime, Piece),
        { value: 3 },
        false,
        false,
      );
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        refusalWaiter.promise,
        "the cross-space start's transaction being refused at the store",
      );
      await runtime.runner.idleDeferredStartCatchUps();
      await runtime.idle();

      // The refusal ROUTED into the recovery and the recovery was
      // scheduled — the discriminating assertions…
      expect(routed).toBe(1);
      expect(scheduled).toBe(1);
      // …and exactly one refusal (the recovery never re-committed a start
      // transaction — its walk failed before any second commit), the
      // failed recovery leaving nothing behind.
      expect(refusals).toBe(1);
      expect(runtime.runner.cancels.has(key(receipt))).toBe(false);
    } finally {
      stubbed.catchUpAndStartOnStaleRead = originalEntry;
      replica.commitNative = originalCommitNative;
      runnerForMark.startWithTx = originalStartWithTx;
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
