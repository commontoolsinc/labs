// Regression: a reactive EFFECT whose optimistic commit fails with a cross-replica
// ConflictError recovers and re-runs against fresh state — WITHOUT consuming the
// reactive retry budget — exactly as a computation is.
//
// ConflictError is kept out of the reactive retry budget (a conflict is a wait for
// catch-up, not a failure). Recovery is guaranteed by the catch-up re-queue in
// watchReactiveActionCommit: re-arm the subscription, wait for the conflict's
// `readyToRetry`, then re-run. The cross-replica ConflictError's read-repair sync
// re-triggering the effect via reader-dirty is a redundant fast path. The
// off-budget conflict-skip is intentionally NOT gated to computations — effects
// take the same path. A same-replica race is a StorageTransactionInconsistent,
// which keeps its bounded retry; only the cross-replica ConflictError reaches this
// path.
//
// Coverage gap this fills: compute-conflict-recovery.test.ts asserts the reader-dirty
// PREDICATE for computations; commit-conflict-reconcile.test.ts exercises read-repair
// on a MANUAL tx. Neither drives a scheduler-managed EFFECT commit through a real
// conflict and back to recovery.
//
// Harness: two Runtimes share ONE server, each with its own replicas (recipe from
// commit-conflict-reconcile.test.ts). The writer (A) advances the shared doc; the
// replica under test (B) is left provably stale, so B's effect deterministically
// reads the stale value and its commit conflicts.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import type {
  IStorageNotification,
  StorageNotification,
} from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("effect-conflict-recovery");
const space = signer.did();

class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }
  private sharedServer!: MemoryV2Server.Server;
  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }

  // When set, forward storage notifications to subscribers with their `changes`
  // emptied, so they raise no reader-dirty — a deterministic stand-in for a
  // "dataless catch-up" (a conflict whose catch-up carries no diff). Off by
  // default: a transparent passthrough that leaves the other tests unaffected.
  suppressReaderDirty = false;
  override subscribe(subscription: IStorageNotification): void {
    super.subscribe({
      next: (n: StorageNotification) =>
        this.suppressReaderDirty && "changes" in n
          ? subscription.next(
            { ...n, changes: [] } as unknown as StorageNotification,
          )
          : subscription.next(n),
    });
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const waitFor = async (
  predicate: () => boolean,
  timeout = 2000,
): Promise<boolean> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
};

describe("effect commit-conflict recovery (no retry budget)", () => {
  let server: MemoryV2Server.Server;
  let storageA: SharedServerStorageManager;
  let storageB: SharedServerStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;
  let conflicts: Error[];

  beforeEach(() => {
    conflicts = [];
    server = newSharedServer();
    storageA = SharedServerStorageManager.connectTo(server, { as: signer });
    storageB = SharedServerStorageManager.connectTo(server, { as: signer });
    storageB.subscribe({
      next: (notification: StorageNotification) => {
        if (
          notification.type === "revert" &&
          notification.reason.name === "ConflictError"
        ) {
          conflicts.push(notification.reason);
        }
        return undefined;
      },
    });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  const exerciseEffectConflict = async (
    tag: string,
    extraOptions: { debounce?: number },
  ): Promise<void> => {
    const srcKey = `${tag}-src`;
    const resKey = `${tag}-res`;

    // A seeds source=1 and result=0, publishes to the shared server.
    const srcA = rtA.getCell<number>(space, srcKey, undefined);
    const resA = rtA.getCell<number>(space, resKey, undefined);
    {
      const tx = rtA.edit();
      srcA.withTx(tx).set(1);
      resA.withTx(tx).set(0);
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit();
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
      await storageA.synced();
    }

    // B converges to source=1, result=0.
    const srcB = rtB.getCell<number>(space, srcKey, undefined);
    const resB = rtB.getCell<number>(space, resKey, undefined);
    await srcB.sync();
    await resB.sync();
    await srcB.pull();
    await resB.pull();
    expect(srcB.get(), "B converged to source=1").toBe(1);

    // A advances source to 2. B is deliberately NOT synced — it stays stale at 1.
    {
      const tx = rtA.edit();
      srcA.withTx(tx).set(2);
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit();
      expect(res.error, `bump: ${JSON.stringify(res.error)}`).toBeUndefined();
      await storageA.synced();
    }
    expect(srcB.get(), "B is provably stale (still 1) before the effect runs")
      .toBe(1);

    // Subscribe an effect on B that reads source and writes source*10 into result.
    // Its first run reads the stale 1; its commit conflicts (server at 2); the
    // conflict is skipped from the retry budget, and the catch-up re-queue (with
    // read-repair / reader-dirty as a fast path) re-runs it against 2.
    const seen: number[] = [];
    let runs = 0;
    const effect: Action = (actionTx) => {
      runs++;
      const value = srcB.withTx(actionTx).get();
      seen.push(value);
      resB.withTx(actionTx).send(value * 10);
    };
    rtB.scheduler.subscribe(effect, {
      reads: [toMemorySpaceAddress(srcB.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(resB.getAsNormalizedFullLink())],
    }, { isEffect: true, ...extraOptions });

    await rtB.idle();
    expect(seen[0], "effect first ran against the stale value").toBe(1);

    const recovered = await waitFor(() => seen.includes(2));
    await rtB.idle();

    expect(
      conflicts.length,
      "the effect's optimistic commit hit a real ConflictError",
    ).toBeGreaterThanOrEqual(1);
    expect(
      recovered,
      "effect re-ran against the post-conflict value after catch-up",
    ).toBe(true);
    expect(resB.get(), "effect's recovered write reflects fresh state").toBe(
      20,
    );
    expect(runs, "effect re-ran (was not stranded by the skipped retry)")
      .toBeGreaterThanOrEqual(2);
  };

  it("recovers a plain effect off the retry budget (not stranded)", async () => {
    await exerciseEffectConflict("plain", {});
  });

  it("recovers a debounced effect (the conditionallyScheduledEffects path)", async () => {
    await exerciseEffectConflict("debounced", { debounce: 50 });
  });

  // Deterministic regression for the #4210/#4343 strand: a reactive action whose
  // commit conflicts must re-evaluate even when the conflict's catch-up delivers
  // NO reader-dirty (the "already-delivered write" case). The real strand is a
  // timing window that doesn't reproduce deterministically — on a normal conflict
  // the read-repair force-notifies, so reader-dirty fires and the action
  // self-recovers even without a re-queue. `suppressReaderDirty` stands in for the
  // dataless catch-up: the real ConflictError still flows via the commit promise
  // and the repaired value still lands in confirmed storage, so recovery is left
  // ONLY to the re-queue. Passes with #4343's re-queue; strands (fails) with a
  // no-requeue handler (the #4210 / #4349-ordinary behavior).
  it("recovers only via the re-queue when the catch-up is dataless", async () => {
    const srcKey = "strand-src";
    const resKey = "strand-res";

    // A seeds source=1, result=0.
    const srcA = rtA.getCell<number>(space, srcKey, undefined);
    const resA = rtA.getCell<number>(space, resKey, undefined);
    {
      const tx = rtA.edit();
      srcA.withTx(tx).set(1);
      resA.withTx(tx).set(0);
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit();
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
      await storageA.synced();
    }

    // B converges to source=1.
    const srcB = rtB.getCell<number>(space, srcKey, undefined);
    const resB = rtB.getCell<number>(space, resKey, undefined);
    await srcB.sync();
    await resB.sync();
    await srcB.pull();
    await resB.pull();
    expect(srcB.get(), "B converged to source=1").toBe(1);

    // A advances source to 2; B is left stale at 1.
    {
      const tx = rtA.edit();
      srcA.withTx(tx).set(2);
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit();
      expect(res.error, `bump: ${JSON.stringify(res.error)}`).toBeUndefined();
      await storageA.synced();
    }
    expect(srcB.get(), "B provably stale (still 1)").toBe(1);

    // From here the scheduler sees no reader-dirty: the catch-up is dataless, so
    // recovery can come ONLY from the re-queue.
    storageB.suppressReaderDirty = true;

    const seen: number[] = [];
    let runs = 0;
    const effect: Action = (actionTx) => {
      runs++;
      const value = srcB.withTx(actionTx).get();
      seen.push(value);
      resB.withTx(actionTx).send(value * 10);
    };
    rtB.scheduler.subscribe(effect, {
      reads: [toMemorySpaceAddress(srcB.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(resB.getAsNormalizedFullLink())],
    }, { isEffect: true });

    await rtB.idle();
    expect(seen[0], "first run read the stale value").toBe(1);

    // On a no-requeue handler the action is stranded here (no reader-dirty, no
    // re-queue); with #4343's re-queue it re-runs against the caught-up state.
    const recovered = await waitFor(() => runs >= 2 && resB.get() === 20);
    await rtB.idle();

    expect(
      conflicts.length,
      "the commit hit a real ConflictError",
    ).toBeGreaterThanOrEqual(1);
    expect(
      recovered,
      "action re-ran via the re-queue despite the dataless catch-up",
    ).toBe(true);
    expect(runs, "action re-ran (not stranded)").toBeGreaterThanOrEqual(2);
    expect(resB.get(), "recovered, committed value reflects fresh state").toBe(
      20,
    );
  });
});
