// Shallow (nonRecursive) conflict granularity, verified against a real loopback
// MemoryV2Server.
//
// A read of a container's SHAPE (a full `.get()` that only dereferences specific
// leaves, `Object.keys`, etc.) is recorded as nonRecursive. The engine honors
// that — matching how the scheduler already treats nonRecursive reads — so a
// shape read conflicts with key add/remove and whole-container writes, but NOT
// with a disjoint deep-value change it never read. A deep value the handler
// actually dereferences is still a recursive read and still conflicts.
//
// Harness: two real Runtimes, each with its own per-space replicas, loopback-
// connected to ONE shared in-process MemoryV2Server. Convergence is forced with
// explicit pull()/sync()/synced().

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("write-conflict-granularity");
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

  // Shared server: serve it without ever initializing the base class's private
  // `#server`, whose `close()` would close the shared server once per manager.
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

describe("write-conflict granularity: shallow (shape) reads", () => {
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

  async function seedRecord(cause: string, value: Record<string, unknown>) {
    const rec = rtA.getCell<Record<string, unknown>>(space, cause, undefined);
    const tx = rtA.edit();
    rec.withTx(tx).set(value);
    rtA.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await storageA.synced();
    return rec;
  }

  it("a leaf read + disjoint deep-value write MERGE (shape read is shallow)", async () => {
    const CAUSE = "shallow-disjoint";
    const recA = await seedRecord(CAUSE, { a: 1, b: 2 });

    // Peer rtB changes the deep value of EXISTING key `b` (a replace patch).
    const recB = rtB.getCell<Record<string, unknown>>(space, CAUSE, undefined);
    await recB.sync();
    await recB.pull();
    const peerTx = rtB.edit();
    recB.withTx(peerTx).key("b").set(99);
    rtB.prepareTxForCommit(peerTx);
    expect((await peerTx.commit()).error).toBeUndefined();
    await storageB.synced();

    // rtA reads only leaf `a` (the full .get() records the container as a SHAPE
    // read, plus a recursive read of `a`), then writes `a`. It never read `b`.
    const tx = rtA.edit();
    const v = recA.withTx(tx).get() as { a: number; b: number };
    recA.withTx(tx).key("a").set(v.a + 1);
    rtA.prepareTxForCommit(tx);
    // The shallow container read does not conflict with the disjoint deep-value
    // change to `b`, and the leaf reads are disjoint — so this MERGES.
    expect((await tx.commit()).error).toBeUndefined();
  });

  it("a key-set read still conflicts a concurrent key ADD", async () => {
    const CAUSE = "shallow-keyset";
    const recA = await seedRecord(CAUSE, { a: 1, b: 2 });

    // Peer ADDS a new key `d` — a key-set change.
    const recB = rtB.getCell<Record<string, unknown>>(space, CAUSE, undefined);
    await recB.sync();
    await recB.pull();
    const peerTx = rtB.edit();
    recB.withTx(peerTx).key("d").set(7);
    rtB.prepareTxForCommit(peerTx);
    expect((await peerTx.commit()).error).toBeUndefined();
    await storageB.synced();

    // rtA depends on the key SET (Object.keys) — a shallow read of the
    // container. A concurrent key-add changes the key set, so it MUST conflict.
    const tx = rtA.edit();
    const v = recA.withTx(tx).get() as Record<string, unknown>;
    const n = Object.keys(v).length;
    recA.withTx(tx).key("slot").set(n);
    rtA.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeDefined();
  });

  it("a deep-value read-modify-write of the SAME key still conflicts", async () => {
    const CAUSE = "shallow-rmw";
    const recA = await seedRecord(CAUSE, { a: 1, b: 2 });

    const recB = rtB.getCell<Record<string, unknown>>(space, CAUSE, undefined);
    await recB.sync();
    await recB.pull();
    const peerTx = rtB.edit();
    recB.withTx(peerTx).key("a").set(100);
    rtB.prepareTxForCommit(peerTx);
    expect((await peerTx.commit()).error).toBeUndefined();
    await storageB.synced();

    // rtA dereferences the deep value of `a` (a recursive leaf read) and writes
    // it back; a concurrent change to `a` must reject it.
    const tx = rtA.edit();
    const v = recA.withTx(tx).get() as { a: number };
    recA.withTx(tx).key("a").set(v.a + 1);
    rtA.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeDefined();
  });

  it("tier-1 whole-doc delete still conflicts a shape reader", async () => {
    const CAUSE = "shallow-tier1";
    const recA = await seedRecord(CAUSE, { a: 1, b: 2 });

    const recB = rtB.getCell<Record<string, unknown>>(space, CAUSE, undefined);
    await recB.sync();
    await recB.pull();
    const peerTx = rtB.edit();
    const upLink = recB.getAsNormalizedFullLink();
    (peerTx as unknown as {
      writeOrThrow: (a: unknown, v: unknown, o?: { delete?: boolean }) => void;
    }).writeOrThrow(
      {
        space: upLink.space,
        id: upLink.id,
        scope: upLink.scope,
        type: "application/json" as const,
        path: [] as string[],
      },
      undefined,
      { delete: true },
    );
    rtB.prepareTxForCommit(peerTx);
    await peerTx.commit();
    await storageB.synced();

    const tx = rtA.edit();
    const v = recA.withTx(tx).get() as Record<string, unknown>;
    void Object.keys(v).length;
    recA.withTx(tx).key("slot").set(1);
    rtA.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeDefined();
  });
});
