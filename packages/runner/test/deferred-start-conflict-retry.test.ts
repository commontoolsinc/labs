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
// back by the error arm's cancel and nothing re-attempted it — so every read
// that depended on it resolved to nothing while the store held every append
// (verification-coverage.md OW45 arm B; the run b04 catch).
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
//
// The injector refuses only transactions the runner hands to `startWithTx`,
// so the setup commit, the scheduler's own runs, and the readiness pull all
// proceed normally and the refusal lands on the start alone.

const signer = await Identity.fromPassphrase("deferred start conflict retry");
const space = signer.did();

/**
 * Refuse the first `count` START transactions with `error`, and nothing
 * else. A start transaction is recognized by the runner handing it to
 * `startWithTx` — which happens before the commit — so this refuses exactly
 * the transaction under test and leaves every other commit of the run
 * (the setup, the scheduler's runs, the readiness pull) untouched.
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
 * Watch the runner install the client-side piece context for one result:
 * how many installs ran, and whether one ever ran while a previous one was
 * still registered — the double-install question a re-attempt raises.
 *
 * Deliberately passes `startWithTx`'s return value through UNCHANGED. The
 * runner compares that exact cancel against its registry to decide whether
 * an ownership still owns the registration (`createDeferredStartOwnership`),
 * so a harness that wraps it silently suppresses every teardown and would
 * manufacture the very concurrency it claims to measure. Liveness is read
 * from the runner's own registry instead.
 */
function observeInstalls(
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
    startWithTx: (...args: unknown[]) => () => void;
  };
  const original = runner.startWithTx;
  const waiters = new Map<number, ReturnType<typeof Promise.withResolvers>>();
  let installs = 0;
  let everConcurrent = false;

  runner.startWithTx = (...args: unknown[]) => {
    if (matches(args[1] as Cell<unknown>)) {
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
      runner.startWithTx = original;
    },
  };
}

describe("a commit-gated start refused for a stale confirmed read", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  // The registration key the runner indexes cancels by.
  function key(cell: Cell<unknown>) {
    return entityKey(
      cell.getAsNormalizedFullLink(),
      runtime.scopeKeyIdentity,
    );
  }

  // The gated-start shape the navigate path mints: an immediate transaction
  // that defers the runner's start until it commits.
  function gatedTx() {
    const tx = runtime.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    return tx;
  }

  // A stale-confirmed-read refusal in the shape `toRejectedError` hands the
  // runner: the engine's message plus the conflict descriptor parsed from
  // it. It names a REAL document, so the readiness pull the retry performs
  // resolves against the store instead of a phantom id.
  function staleConfirmedReadOf(cell: Cell<unknown>) {
    const id = cell.getAsNormalizedFullLink().id;
    return {
      name: "ConflictError",
      message: `stale confirmed read: ${id} at seq 0 conflicted with seq 10`,
      conflict: { space, the: "application/json", of: id },
    };
  }

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("re-attempts the start and leaves the piece running", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTx();
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "started after a stale confirmed read",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
    );
    const installed = observeInstalls(
      runtime,
      (cell) => key(cell) === key(result),
      () => runtime.runner.cancels.has(key(result)),
    );
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        installed.nth(2),
        "the start's re-attempt installing the piece",
      );
      await runtime.runner.idleDeferredStartRetries();
      await runtime.idle();

      // The refusal really happened, and the piece is running anyway.
      expect(injector.refusals()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(true);
      await result.pull();
      expect(result.get()?.doubled).toBe(6);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("installs the piece exactly once across the refusal and its re-attempt", async () => {
    // The re-attempt must not leave the refused attempt's client-side piece
    // context installed beside its own. Counted at the runner's own
    // registration index: an install adds this result's key, a teardown
    // removes it, and the two must alternate — never two live at once.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTx();
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "installed once across a re-attempt",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
    );
    const installed = observeInstalls(
      runtime,
      (cell) => key(cell) === key(result),
      () => runtime.runner.cancels.has(key(result)),
    );
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        installed.nth(2),
        "the start's re-attempt installing the piece",
      );
      await runtime.runner.idleDeferredStartRetries();
      await runtime.idle();

      // Two attempts ran — and at no point did two installs coexist.
      expect(installed.installs()).toBe(2);
      expect(installed.everConcurrent()).toBe(false);
      expect(runtime.runner.cancels.has(key(result))).toBe(true);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("stops re-attempting when the piece is stopped before the re-attempt fires", async () => {
    // The zombie case: the user navigated away, or the piece was disposed,
    // between the refusal and the re-attempt. The pending re-attempt is
    // registered under the result's key BEFORE its readiness gate is
    // awaited, so the stop tombstones it through the same path that
    // tombstones a pending first attempt — it must install nothing.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTx();
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "stopped between the refusal and the re-attempt",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
    );
    const installed = observeInstalls(
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

      // Settle whatever the re-attempt chain still has to do, then assert it
      // did nothing: the refused attempt's install is the only one there
      // ever was, nothing is registered, and no re-attempt is left pending
      // to fire into a piece the session has moved on from.
      await runtime.runner.idleDeferredStartRetries();
      await runtime.idle();

      expect(installed.installs()).toBe(1);
      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      installed.restore();
      injector.restore();
    }
  });

  it("keeps every other refusal terminal, on the first attempt", async () => {
    // The discriminator. A refusal that does not name a stale confirmed read
    // describes no basis a fresh read repairs, so re-running recomputes the
    // same refusal: one attempt, exactly as before this retry existed.
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
        // unresolved, which a re-read does not settle.
        {
          name: "ConflictError",
          message: "pending dependency not resolved: 7",
        },
      ]
    ) {
      const tx = gatedTx();
      const result = runtime.getCell<{ doubled?: number }>(
        space,
        `terminal on ${refusal.name}: ${refusal.message}`,
        undefined,
        tx,
      );
      // Refuse EVERY transaction once armed, so a re-attempt would be seen
      // as a second refusal rather than passing through.
      const injector = refuseDeferredStartCommits(
        runtime,
        refusal,
        Number.MAX_SAFE_INTEGER,
      );
      try {
        runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
        expect((await tx.commit()).error).toBeUndefined();

        await waitForSignal(
          injector.refusalsReach(1),
          `the start's transaction being refused with ${refusal.name}`,
        );
        await runtime.runner.idleDeferredStartRetries();
        await runtime.idle();

        expect(injector.refusals()).toBe(1);
        expect(runtime.runner.cancels.has(key(result))).toBe(false);
      } finally {
        injector.restore();
      }
    }
  });

  it("gives up after a bounded number of re-attempts", async () => {
    // A basis still stale after the bound is not the birth race any more,
    // and continuing would install and tear down a piece context per
    // attempt. One attempt plus DEFERRED_START_CONFLICT_RETRIES re-attempts,
    // then the terminal arm.
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Piece = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = gatedTx();
    const result = runtime.getCell<{ doubled?: number }>(
      space,
      "exhausts its re-attempts",
      undefined,
      tx,
    );
    const injector = refuseDeferredStartCommits(
      runtime,
      staleConfirmedReadOf(result),
      Number.MAX_SAFE_INTEGER,
    );
    try {
      runtime.run(tx, Piece, { value: 3 }, result.withTx(tx));
      expect((await tx.commit()).error).toBeUndefined();

      await waitForSignal(
        injector.refusalsReach(3),
        "the start exhausting its re-attempts",
      );
      await runtime.runner.idleDeferredStartRetries();
      await runtime.idle();

      // The first attempt plus exactly two re-attempts.
      expect(injector.refusals()).toBe(3);
      expect(runtime.runner.cancels.has(key(result))).toBe(false);
    } finally {
      injector.restore();
    }
  });
});
