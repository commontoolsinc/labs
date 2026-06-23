// Time-of-check / time-of-use stale read across a LINK.
//
//   cellB = { isAdmin: true }
//   cellA = { isAdmin: <link -> cellB.isAdmin> }
//
// Two Runtime clients share ONE in-process MemoryV2Server (harness recipe from
// commit-conflict-reconcile.test.ts). Client 1 reads isAdmin=true; Client 2
// flips cellB.isAdmin=false on the server; Client 1 — in the window before its
// replica syncs — re-reads the linked value through cellA inside a tx and
// writes a grant based on it. That commit is rejected as a ConflictError.
//
// What makes this DISTINCT from commit-conflict-reconcile.test.ts (which shares
// this harness): the stale read is reached THROUGH A LINK, so the conflict is
// on the link *target* (cellB) — a different doc than the one the tx actually
// writes (cellC). This pins that a stale read enrolled via a link, not just a
// direct read of the written doc, is enough to reject the commit.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("linked-stale-read-strand");
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

describe("stale linked read across two clients", () => {
  let server: MemoryV2Server.Server;
  let storageA: SharedServerStorageManager;
  let storageB: SharedServerStorageManager;
  let rtA: Runtime; // Client 1
  let rtB: Runtime; // Client 2

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

  it("rejects Client 1's grant when its tx read a stale linked isAdmin", async () => {
    const A = "cellA";
    const B = "cellB";
    const C = "cellC";

    // --- Client 1 seeds cellB = { isAdmin: true } and links cellA.isAdmin to it.
    const cellB1 = rtA.getCell<{ isAdmin: boolean }>(space, B, undefined);
    const cellA1 = rtA.getCell<{ isAdmin: boolean }>(space, A, undefined);
    {
      const tx = rtA.edit();
      cellB1.withTx(tx).set({ isAdmin: true });
      cellA1.withTx(tx).key("isAdmin").setRawUntyped(
        cellB1.key("isAdmin").getAsLink(),
      );
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit();
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
      await storageA.synced();
    }

    // Client 1 reads the linked value -> { isAdmin: true }
    expect(cellA1.get()).toEqual({ isAdmin: true });

    // --- Client 2 converges, then flips cellB.isAdmin = false and publishes it.
    const cellB2 = rtB.getCell<{ isAdmin: boolean }>(space, B, undefined);
    await cellB2.sync();
    await cellB2.pull();
    expect(cellB2.get()).toEqual({ isAdmin: true });
    {
      const tx = rtB.edit();
      cellB2.withTx(tx).key("isAdmin").set(false);
      rtB.prepareTxForCommit(tx);
      const res = await tx.commit();
      expect(res.error, `flip: ${JSON.stringify(res.error)}`).toBeUndefined();
      await storageB.synced();
    }

    // --- Client 1, NOT synced, opens ONE transaction that both READS isAdmin
    // through the link in cellA and, on the strength of that read, writes the
    // grant to cellC. Because the read happens via `withTx(tx)`, the stale
    // `isAdmin` (the link target cellB) enters this tx's read-set.
    const cellC1 = rtA.getCell<string>(space, C, undefined);
    const tx = rtA.edit();
    const observedByClient1 = cellA1.withTx(tx).key("isAdmin").get();
    // Client 1 still read the stale `true` in the race window ...
    expect(observedByClient1, "Client 1's in-tx linked read").toBe(true);
    // Client 1 sets the field in C based on the information in A.
    cellC1.withTx(tx).set("User is allowed, because isAdmin = true");
    rtA.prepareTxForCommit(tx);
    const res = await tx.commit();

    // ... but now that read is part of the tx's read-set, so committing the
    // grant is REJECTED: the server's head for cellB.isAdmin has advanced past
    // the seq Client 1 read it at.
    expect(res.error, "stale-read commit should be rejected").toBeDefined();
    expect(
      (res.error as { name?: string })?.name,
      "stale read across the link is a ConflictError",
    ).toBe("ConflictError");

    // The grant write never lands.
    expect(cellC1.get(), "rejected grant must not persist").toBeUndefined();
  });
});
