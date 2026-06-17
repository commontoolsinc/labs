// Conflict-detection granularity for cell writes, verified against a real
// loopback MemoryV2Server.
//
// A blind cell write (`cell.key(k).set(v)` with no prior read of the slot) is a
// PURE PRODUCER: its write-machinery reads — link resolution of the target plus
// the diff read of the slot being written — are not recorded as conflict
// dependencies. So two writes to DIFFERENT keys of one document merge instead of
// colliding. A GENUINE read (a `.get()` evaluated before the set) still takes a
// dependency, so read-modify-write of the same key still conflicts, and tier-1
// whole-doc set/delete still conflicts any genuine reader.
//
// Harness: two real Runtimes, each with its own per-space replicas, loopback-
// connected to ONE shared in-process MemoryV2Server. Convergence is forced with
// explicit pull()/sync()/synced() — never a bare get() on an un-pulled local
// projection.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

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

// The native commit operations the runtime will SEND for `space`, after
// prepareTxForCommit. Used to pin the lowering contract (keyed sub-path writes
// lower to `op:patch`).
function captureCommitOps(
  tx: IExtendedStorageTransaction,
  sp: MemorySpace,
): Array<{ op: string }> {
  const inner =
    (tx as unknown as { tx: { getNativeCommit?: (s: MemorySpace) => unknown } })
      .tx;
  const native = inner.getNativeCommit?.(sp) as
    | { operations?: Array<Record<string, unknown>> }
    | undefined;
  return (native?.operations ?? []).map((o) => ({ op: String(o.op) }));
}

describe("write-conflict granularity: blind writes are pure producers", () => {
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

  // Seed a shared open-schema Record from rtA and sync it to the server.
  async function seedRecord(cause: string, value: Record<string, unknown>) {
    const rec = rtA.getCell<Record<string, unknown>>(space, cause, undefined);
    const tx = rtA.edit();
    rec.withTx(tx).set(value);
    rtA.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await storageA.synced();
    return rec;
  }

  // Authoritative server state, read via a FRESH runtime/replica (no prior
  // local projection to be stale).
  async function serverTruth(cause: string): Promise<unknown> {
    const storageC = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    const rtC = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageC,
    });
    try {
      const recC = rtC.getCell<Record<string, unknown>>(
        space,
        cause,
        undefined,
      );
      await recC.sync();
      await recC.pull();
      return recC.get();
    } finally {
      await rtC.dispose();
      await storageC.close();
    }
  }

  it("two blind adds of DIFFERENT keys merge (no spurious conflict)", async () => {
    const CAUSE = "blind-add-merge";
    const recA = await seedRecord(CAUSE, { a: 1, b: 2 });

    // Peer rtB blind-adds key `p`, commits first.
    const recB = rtB.getCell<Record<string, unknown>>(space, CAUSE, undefined);
    await recB.sync();
    await recB.pull();
    const peerTx = rtB.edit();
    recB.withTx(peerTx).key("p").set(10);
    rtB.prepareTxForCommit(peerTx);
    const peerOps = captureCommitOps(peerTx, space);
    expect((await peerTx.commit()).error).toBeUndefined();
    await storageB.synced();

    // rtA blind-adds a DIFFERENT key `q` against a baseline that has NOT seen p.
    const tx = rtA.edit();
    recA.withTx(tx).key("q").set(20);
    rtA.prepareTxForCommit(tx);
    const ops = captureCommitOps(tx, space);
    const res = await tx.commit();
    await storageA.synced();

    // Lowering contract: a keyed sub-path write is a `patch`, not a whole-doc set.
    expect(peerOps.every((o) => o.op === "patch")).toBe(true);
    expect(ops.every((o) => o.op === "patch")).toBe(true);
    // The win: the disjoint blind add is NOT spuriously rejected.
    expect(res.error).toBeUndefined();
    // Both writes are present in authoritative server state.
    expect(await serverTruth(CAUSE)).toEqual({ a: 1, b: 2, p: 10, q: 20 });
  });

  it("read-modify-write of the SAME key still conflicts (no lost update)", async () => {
    const CAUSE = "rmw-same-key";
    const recA = await seedRecord(CAUSE, { a: 1, b: 2 });

    const recB = rtB.getCell<Record<string, unknown>>(space, CAUSE, undefined);
    await recB.sync();
    await recB.pull();
    const peerTx = rtB.edit();
    recB.withTx(peerTx).key("a").set(100);
    rtB.prepareTxForCommit(peerTx);
    expect((await peerTx.commit()).error).toBeUndefined();
    await storageB.synced();

    // rtA does a GENUINE read of `a` (via .get(), before the set), then writes
    // `a` based on it — a read-modify-write. The genuine read is a real
    // dependency, so the concurrent change to `a` must reject it.
    const tx = rtA.edit();
    const v = recA.withTx(tx).get() as { a: number };
    recA.withTx(tx).key("a").set(v.a + 1);
    rtA.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeDefined();
  });

  it("tier-1 whole-doc delete still conflicts a genuine reader", async () => {
    const CAUSE = "tier1-delete";
    const recA = await seedRecord(CAUSE, { a: 1, b: 2 });

    // Peer rtB deletes the whole doc at the root (a tier-1, path-blind op).
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

    // rtA does a genuine read (enumerates the doc) then writes — the tier-1
    // delete is path-blind and must reject any genuine confirmed read.
    const tx = rtA.edit();
    const v = recA.withTx(tx).get() as Record<string, unknown>;
    void Object.keys(v).length;
    recA.withTx(tx).key("slot").set(1);
    rtA.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeDefined();
  });
});
