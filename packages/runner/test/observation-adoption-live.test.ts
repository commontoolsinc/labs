import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// Incremental observation adoption
// (docs/specs/scheduler-v2/incremental-observation-adoption.md): two LIVE
// runtimes on one in-process server. When runtime A's action runs commit,
// their observations ride the subscription push, and runtime B ADOPTS them
// for its own registered equivalent actions instead of re-running — B's
// derived values update with zero per-element op runs (the expensive user
// computations; see opRuns below for why coordinators may still reconcile).
// A B-local write still runs B's actions (adoption must not deaden local
// reactivity), and A adopts B's observations symmetrically.

const signer = await Identity.fromPassphrase("observation adoption live");
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
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const ITEMS_SCHEMA: JSONSchema = {
  type: "array",
  items: { type: "object", properties: { v: { type: "number" } } },
};

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { v: number }[] }>(({ items }) => {",
      "  return { vs: items.map((item) => item.v * 2) };",
      "});",
    ].join("\n"),
  }],
};

function newRuntime(storageManager: SharedServerStorageManager) {
  return new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { persistentSchedulerState: true },
  });
}

function adoptOkCount(): number {
  const b = getLoggerCountsBreakdown().scheduler ?? {};
  return (b as Record<string, { total?: number }>)["adopt/ok"]?.total ?? 0;
}

// The skip contract covers the module-hash-stamped user computations (the
// per-element ops — the expensive cascade). Collection coordinators
// (`raw:map:*`) may still reconcile: a cascade's observations ride commits
// that can straddle push-window boundaries, and a receiver whose coordinator
// was dirtied by an earlier window legitimately dispatches before the
// laggard observation arrives — the benign race of the design's §3; the
// redundant run is a value-identical no-op.
function opRuns(
  trace: readonly { actionId: string }[],
): string[] {
  return trace.map((e) => e.actionId).filter((id) =>
    id.startsWith("cf:module/")
  );
}

// The subscription push is timer-batched server-side (5ms default) and the
// integrate lands asynchronously; poll the receiving replica (plain local
// reads — pull() would fetch out-of-band and mask a missing push).
async function waitForLocalValue(
  runtime: Runtime,
  read: () => unknown,
  expected: unknown,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await runtime.idle();
    if (JSON.stringify(read()) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(read()).toEqual(expected);
}

describe("incremental observation adoption (live)", () => {
  let server: MemoryV2Server.Server;
  let managerA: SharedServerStorageManager;
  let managerB: SharedServerStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = SharedServerStorageManager.connectTo(server, { as: signer });
    managerB = SharedServerStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await managerA?.close();
    await managerB?.close();
    await server?.close();
  });

  it("a receiver adopts the writer's runs instead of re-running", async () => {
    // Runtime A creates and settles the piece.
    const rt1 = newRuntime(managerA);
    const rt2 = newRuntime(managerB);
    try {
      const tx1 = rt1.edit();
      const itemsCell1 = rt1.getCell(space, "adopt-items", ITEMS_SCHEMA, tx1);
      itemsCell1.withTx(tx1).set([{ v: 1 }, { v: 2 }, { v: 3 }]);
      const compiled = await rt1.patternManager.compilePattern(PROGRAM, {
        space,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell(space, "adopt-result", undefined, tx1);
      const r1 = rt1.run(
        tx1,
        // deno-lint-ignore no-explicit-any
        compiled as any,
        { items: itemsCell1 },
        resultCell1,
      );
      rt1.prepareTxForCommit(tx1);
      expect((await tx1.commit()).error).toBeUndefined();
      const cancelSink1 = r1.sink(() => {});
      await rt1.idle();
      expect(await r1.key("vs").pull()).toEqual([2, 4, 6]);
      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      await rt1.idle();
      await rt1.storageManager.synced();

      // Runtime B joins the SAME live piece (its boot rehydrates from A's
      // persisted observations — the reload case of the same mechanism).
      const resultLink = r1.getAsNormalizedFullLink();
      const resultCell2 = rt2.getCellFromLink(resultLink);
      await resultCell2.sync();
      expect(await rt2.start(resultCell2)).toBeTruthy();
      const cancelSink2 = resultCell2.key("vs").sink(() => {});
      await rt2.idle();
      await rt2.storageManager.synced();
      await rt2.idle();
      expect(resultCell2.key("vs").getAsQueryResult()).toEqual([2, 4, 6]);

      // LIVE SKIP: runtime A writes one element's field; A's cascade runs
      // and commits; B receives the writes + observations via the
      // subscription push and converges WITHOUT running any computation.
      rt2.scheduler.setActionRunTraceEnabled(true);
      const adoptedBefore = adoptOkCount();
      const tx2 = rt1.edit();
      itemsCell1.withTx(tx2).key(0).key("v").set(10);
      expect((await tx2.commit()).error).toBeUndefined();
      await rt1.idle();
      await rt1.storageManager.synced();

      await waitForLocalValue(
        rt2,
        () => resultCell2.key("vs").getAsQueryResult(),
        [20, 4, 6],
      );
      const liveTrace = rt2.scheduler.getActionRunTrace();
      expect(opRuns(liveTrace)).toEqual([]);
      expect(adoptOkCount()).toBeGreaterThan(adoptedBefore);

      // LOCAL REACTIVITY PRESERVED: a B-local write runs B's own lift
      // (adoption must not deaden the receiving scheduler), and A adopts
      // B's runs symmetrically.
      rt1.scheduler.setActionRunTraceEnabled(true);
      const itemsCell2 = rt2.getCell(space, "adopt-items", ITEMS_SCHEMA);
      await itemsCell2.sync();
      const beforeLocal = rt2.scheduler.getActionRunTrace().length;
      const tx3 = rt2.edit();
      itemsCell2.withTx(tx3).key(1).key("v").set(7);
      expect((await tx3.commit()).error).toBeUndefined();
      await rt2.idle();
      await rt2.storageManager.synced();
      expect(
        opRuns(rt2.scheduler.getActionRunTrace().slice(beforeLocal)).length,
      ).toBeGreaterThan(0);
      await waitForLocalValue(
        rt2,
        () => resultCell2.key("vs").getAsQueryResult(),
        [20, 14, 6],
      );

      await waitForLocalValue(
        rt1,
        () => r1.key("vs").getAsQueryResult(),
        [20, 14, 6],
      );
      expect(opRuns(rt1.scheduler.getActionRunTrace())).toEqual([]);

      cancelSink1();
      cancelSink2();
    } finally {
      await rt1.dispose();
      await rt2.dispose();
    }
  });
});
