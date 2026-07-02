/**
 * B3 — writer-side integration gap (root-caused in the convergence
 * investigation; see docs/plans/2026-06-30-profile-loading-investigation.md
 * and PR #4457).
 *
 * The durable/server merge of concurrent appends already works (covered by
 * array-push-mergeable.test.ts, which asserts on `readDurable(server)` via a
 * FRESH session). This test covers the gap that suite does not: the CLIENT
 * REPLICA of the writer that interleaved its own append does not integrate the
 * peer's append — even after an explicit sync + pull.
 *
 * Mechanism (two interacting sites in storage/v2.ts):
 *   - confirmPending promotes the interleaving writer's `record.confirmed` to
 *     its own commit's (high) applied.seq, with a value reconstructed by
 *     replaying its pending append onto its own base = its own appends only;
 *   - applySessionSync then skips the peer's authoritative revision because
 *     `upsert.seq < record.confirmed.seq` ("never move the confirmed base
 *     backwards") — the self-promoted seq shadows the peer's earlier append.
 *
 * A fresh reader (no local pendings) converges fine — so this is specifically
 * the writer's own replica, matching the multiplayer symptom where the losing
 * writer's tab shows only its own messages.
 *
 * INTENTIONALLY RED until B3 is fixed.
 *
 * No toolshed/browser (in-process shared memory server + two client replicas).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// Two of these on one shared server model two real sessions (as in
// array-push-mergeable.test.ts): data written by one reaches the other only
// through an explicit per-space server query/subscription.
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
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const signer = await Identity.fromPassphrase("array-append-client-convergence");
const space = signer.did();
const CAUSE = "client-convergence-list";
// deno-lint-ignore no-explicit-any
const stringListSchema = { type: "array", items: { type: "string" } } as any;

async function readDurable(server: MemoryV2Server.Server): Promise<string[]> {
  const storage = SharedServerStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema);
    await cell.sync();
    await cell.pull();
    return (cell.get() ?? []) as string[];
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("array append — writer-side client convergence (B3)", () => {
  let server: MemoryV2Server.Server;
  let storage1: SharedServerStorageManager;
  let storage2: SharedServerStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    storage1 = SharedServerStorageManager.connectTo(server, { as: signer });
    storage2 = SharedServerStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  it("the interleaving writer's replica integrates the peer's concurrent append", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      // Seed ["seed"], durable; both replicas load it at the same basis.
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toEqual(["seed"]);

      // Session 1 appends "A" (lands at a lower server seq).
      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit();
      await rt1.storageManager.synced();

      // Session 2 appends "B" WITHOUT having observed "A" — its own append
      // confirms and advances its confirmed.seq past "A"'s seq.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).push("B");
      await txB.commit();
      await rt2.storageManager.synced();

      // Sanity: the server merged all three (delivery works).
      expect([...await readDurable(server)].sort()).toEqual(["A", "B", "seed"]);

      // Give session 2 every chance to converge: explicit sync + pull, twice.
      for (let i = 0; i < 2; i++) {
        await cell2.sync();
        await cell2.pull();
        await rt2.storageManager.synced();
      }

      // The interleaving writer must now see the peer's append. B3: it does
      // not — its replica holds only ["seed", "B"], missing "A".
      const seenByWriter = [...(cell2.get() ?? [])].sort();
      expect(seenByWriter).toEqual(["A", "B", "seed"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
