// Regression: a reactive EFFECT whose optimistic commit fails with a cross-replica
// ConflictError is recovered by reader-dirty re-triggering — WITHOUT consuming the
// reactive retry budget — exactly as a computation is.
//
// This pins #4210's (empirically established) scope. #4210 removes ConflictError
// from the reactive retry path on the premise `commit-conflict ⊆ reader-dirty`
// (established by #4220): the write that caused the conflict has already dirtied the
// action's still-subscribed reads, so the scheduler re-runs it with fresh state. The
// conflict-skip in watchReactiveActionCommit is intentionally NOT gated to
// computations — effects recover the same way (the cross-replica ConflictError's
// read-repair sync re-triggers the effect). A same-replica race is a
// StorageTransactionInconsistent, which keeps its bounded retry; only the
// cross-replica ConflictError reaches this path.
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
import { type StorageNotification } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";

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
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
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
    // Its first run reads the stale 1; its commit conflicts (server at 2); #4210
    // skips the retry, and reader-dirty (via read-repair) must re-run it against 2.
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
      "effect re-ran against the post-conflict value via reader-dirty",
    ).toBe(true);
    expect(resB.get(), "effect's recovered write reflects fresh state").toBe(
      20,
    );
    expect(runs, "effect re-ran (was not stranded by the skipped retry)")
      .toBeGreaterThanOrEqual(2);
  };

  it("recovers a plain effect via reader-dirty, not the retry budget", async () => {
    await exerciseEffectConflict("plain", {});
  });

  it("recovers a debounced effect (the conditionallyScheduledEffects path)", async () => {
    await exerciseEffectConflict("debounced", { debounce: 50 });
  });
});
