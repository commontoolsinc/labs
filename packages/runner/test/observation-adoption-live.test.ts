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

const VALUE_SCHEMA: JSONSchema = { type: "number" };

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  const doubled = computed(() => value * 2);",
      "  return { doubled };",
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

// The skip contract covers the module-hash-stamped source computation. Raw
// scheduler coordination or test-sink actions are deliberately ignored.
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
      const valueCell1 = rt1.getCell(space, "adopt-value", VALUE_SCHEMA, tx1);
      valueCell1.withTx(tx1).set(1);
      const compiled = await rt1.patternManager.compilePattern(PROGRAM, {
        space,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell(space, "adopt-result", undefined, tx1);
      const r1 = rt1.run(
        tx1,
        // deno-lint-ignore no-explicit-any
        compiled as any,
        { value: valueCell1 },
        resultCell1,
      );
      rt1.prepareTxForCommit(tx1);
      expect((await tx1.commit()).error).toBeUndefined();
      const cancelSink1 = r1.sink(() => {});
      await rt1.idle();
      expect(await r1.key("doubled").pull()).toBe(2);
      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      await rt1.idle();
      await rt1.storageManager.synced();
      const persisted = await managerA.open(space)
        .listSchedulerActionSnapshots!({ ownerSpace: space, limit: 1000 });
      expect(persisted.snapshots).toHaveLength(1);
      expect(persisted.snapshots[0].executionContextKey).toBe("space");
      expect(
        (persisted.snapshots[0].observation as {
          completeActionScopeSummary?: unknown;
        }).completeActionScopeSummary,
      ).toBeDefined();

      // Runtime B joins the SAME live piece (its boot rehydrates from A's
      // persisted observations — the reload case of the same mechanism).
      const resultLink = r1.getAsNormalizedFullLink();
      const resultCell2 = rt2.getCellFromLink(resultLink);
      await resultCell2.sync();
      expect(await rt2.start(resultCell2)).toBeTruthy();
      const cancelSink2 = resultCell2.key("doubled").sink(() => {});
      await rt2.idle();
      await rt2.storageManager.synced();
      await rt2.idle();
      expect(resultCell2.key("doubled").getAsQueryResult()).toBe(2);

      // LIVE SKIP: runtime A writes the input; A's source-backed computation
      // runs and commits; B receives the writes + observations via the
      // subscription push and converges WITHOUT running any computation.
      rt2.scheduler.setActionRunTraceEnabled(true);
      const adoptedBefore = adoptOkCount();
      const tx2 = rt1.edit();
      valueCell1.withTx(tx2).set(10);
      expect((await tx2.commit()).error).toBeUndefined();
      await rt1.idle();
      await rt1.storageManager.synced();

      await waitForLocalValue(
        rt2,
        () => resultCell2.key("doubled").getAsQueryResult(),
        20,
      );
      const liveTrace = rt2.scheduler.getActionRunTrace();
      expect(opRuns(liveTrace)).toEqual([]);
      expect(adoptOkCount()).toBeGreaterThan(adoptedBefore);

      // Repeat with the same dependency shape. The later observation must ride
      // the later semantic commit's sync window rather than retaining the first
      // run's already-consumed delivery slot.
      const beforeRepeated = rt2.scheduler.getActionRunTrace().length;
      const adoptedBeforeRepeated = adoptOkCount();
      const txRepeated = rt1.edit();
      valueCell1.withTx(txRepeated).set(11);
      expect((await txRepeated.commit()).error).toBeUndefined();
      await rt1.idle();
      await rt1.storageManager.synced();
      await waitForLocalValue(
        rt2,
        () => resultCell2.key("doubled").getAsQueryResult(),
        22,
      );
      expect(
        opRuns(
          rt2.scheduler.getActionRunTrace().slice(beforeRepeated),
        ),
      ).toEqual([]);
      expect(adoptOkCount()).toBeGreaterThan(adoptedBeforeRepeated);

      // LOCAL REACTIVITY PRESERVED: a B-local write runs B's own lift
      // (adoption must not deaden the receiving scheduler). A still converges;
      // its push window may run or adopt depending on observation ordering.
      const valueCell2 = rt2.getCell(space, "adopt-value", VALUE_SCHEMA);
      await valueCell2.sync();
      const beforeLocal = rt2.scheduler.getActionRunTrace().length;
      const tx3 = rt2.edit();
      valueCell2.withTx(tx3).set(7);
      expect((await tx3.commit()).error).toBeUndefined();
      await rt2.idle();
      await rt2.storageManager.synced();
      expect(
        opRuns(rt2.scheduler.getActionRunTrace().slice(beforeLocal)).length,
      ).toBeGreaterThan(0);
      await waitForLocalValue(
        rt2,
        () => resultCell2.key("doubled").getAsQueryResult(),
        14,
      );

      await waitForLocalValue(
        rt1,
        () => r1.key("doubled").getAsQueryResult(),
        14,
      );

      cancelSink1();
      cancelSink2();
    } finally {
      await rt1.dispose();
      await rt2.dispose();
    }
  });
});
