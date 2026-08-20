import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// `pullOpenSpacesToHead()` is the client half of the multi-runtime settle
// barrier: it issues an unconditional `graph.query` round trip on every open
// space connection, so subscription fan-out the server has already sent has
// been received and applied before it resolves. The server holds fan-out
// manually here, so a second replica is provably stale until the write is
// published; the barrier is then what carries the published write into it.
//
// The deterministic cross-realm ordering guarantee this exploits (a WebSocket
// delivers a connection's frames in order) is exercised end to end by the
// packages/patterns multi-runtime integration suite, over real worker realms
// and a real socket. This test pins the method's functional contract.

const signer = await Identity.fromPassphrase("storage-pull-open-spaces");
const space = signer.did();

const stringListSchema = {
  type: "array",
  items: { type: "string" },
  // deno-lint-ignore no-explicit-any
} as any;

describe("StorageManager.pullOpenSpacesToHead", () => {
  let server: MemoryV2Server.Server;
  let storage1: EmulatedStorageManager;
  let storage2: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage1 = EmulatedStorageManager.connectTo(server, { as: signer });
    storage2 = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  it("carries a peer's published write into a watching replica", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      // rt2 watches the cell, so the server has a subscriber to fan out to.
      const cell2 = rt2.getCell<string[]>(
        space,
        "shared-list",
        stringListSchema,
      );
      await cell2.sync();

      // rt1 commits a write. The commit reaches the server, but fan-out is held
      // (manual mode), so rt2 stays stale even after settling itself.
      const tx = rt1.edit();
      rt1.getCell<string[]>(space, "shared-list", stringListSchema, tx)
        .set(["A"]);
      await tx.commit({ resolveAt: "verdict" });
      await storage1.synced();
      await rt2.idle();
      expect(cell2.get()).toBeUndefined();

      // Publish the fan-out, then converge rt2 through the barrier alone.
      await server.idle();
      await storage2.pullOpenSpacesToHead();
      await rt2.idle();
      expect(cell2.get()).toEqual(["A"]);
    } finally {
      await rt1.dispose();
      await rt2.dispose();
    }
  });
});
