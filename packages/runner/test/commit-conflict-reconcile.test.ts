// Regression guard: a rejected commit must not leave a read staler than the
// server's confirmed head.
//
// Two real Runtimes share ONE in-process MemoryV2Server, each with its own
// per-space replicas (harness recipe from
// cell-write-conflict-granularity.test.ts). Convergence is forced explicitly, so
// replica B is left PROVABLY stale: after A advances the shared doc, B still
// views the old value — it received no subscription update (asserted on the line
// before B's own commit). B's commit-and-conflict round-trip then reconciles B's
// `confirmed` to the server head, so B's post-rejection read is fresh, not stale.
// This pins that reconciliation: if a future change let a rejected commit revert
// to a stale local `confirmed`, this test fails.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("read-repair-strand");
const space = signer.did();

// Two StorageManagers sharing ONE real server, each with its own replicas.
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

describe("read-repair: stale read after cross-replica conflict", () => {
  let server: MemoryV2Server.Server;
  let storageA: SharedServerStorageManager;
  let storageB: SharedServerStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageA = SharedServerStorageManager.connectTo(server, { as: signer });
    storageB = SharedServerStorageManager.connectTo(server, { as: signer });
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

  it("a rejected commit must not leave a read staler than the server head", async () => {
    const CAUSE = "strand-doc";

    // A seeds the doc at v0 and publishes it to the shared server.
    const docA = rtA.getCell<{ v: string }>(space, CAUSE, undefined);
    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v0" });
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit();
      expect(res.error, `seed v0: ${JSON.stringify(res.error)}`)
        .toBeUndefined();
      await storageA.synced();
    }

    // B converges to v0.
    const docB = rtB.getCell<{ v: string }>(space, CAUSE, undefined);
    await docB.sync();
    await docB.pull();
    expect(docB.get()).toEqual({ v: "v0" });

    // B opens a tx that READS the doc at v0 and stages a write (uncommitted).
    const txB = rtB.edit();
    docB.withTx(txB).get(); // record read at seq(v0)
    docB.withTx(txB).set({ v: "vB" });
    rtB.prepareTxForCommit(txB);

    // A advances the server to v1. B is deliberately NOT synced — it is now in
    // the window where its `confirmed` lags the server.
    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v1" });
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit();
      expect(res.error, `bump v1: ${JSON.stringify(res.error)}`)
        .toBeUndefined();
      await storageA.synced();
    }

    // B's `confirmed` is provably stale here: it still views v0, because the
    // subscription has not delivered A's v1 (no sync was forced on B).
    expect(docB.get(), "precondition: B is stale before its commit").toEqual({
      v: "v0",
    });

    // B commits its v0-based write — the server rejects it (stale read).
    const resB = await txB.commit();
    expect(resB.error, "B's commit should be rejected (conflict)")
      .toBeDefined();
    expect(
      (resB.error as { name?: string })?.name,
      "cross-replica conflict is a ConflictError",
    ).toBe("ConflictError");

    // INVARIANT under test: after the rejection, B's read must not be staler
    // than the server's confirmed head (v1). Pre-fix B reverts to its stale
    // local `confirmed` (v0); read-repair reconciles `confirmed` to the head.
    // Read with NO intervening await so a fire-and-forget sync cannot mask the
    // strand — the assertion sees B's post-commit `confirmed` directly.
    expect(docB.get()).toEqual({ v: "v1" });
  });
});
