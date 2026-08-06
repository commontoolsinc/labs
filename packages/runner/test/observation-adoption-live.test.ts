import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// Incremental observation adoption
// (docs/specs/scheduler-v2/incremental-observation-adoption.md): two LIVE
// runtimes on one in-process server. With the transformer completeness
// certificate deleted (docs/specs/server-side-execution/serving-loop.md §3b),
// every persisted observation row is owned by its writer's exact session —
// adoption C6's fail-closed arm. Nothing ships to another session, so a
// receiving runtime converges by RUNNING its own computations, and a B-local
// write keeps running B's actions as before.

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
// integrate lands asynchronously, so a receiving replica reaches the value
// after the sending runtime has already settled. The waits below therefore sink
// on the receiver's own cell through `waitForCellValue`, which reads it locally
// with get(); pull() would fetch out-of-band and mask a missing push.

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

  it("certificate-less rows stay session-owned; a receiver re-runs", async () => {
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
      // Without a completeness certificate the server never creates a shared
      // space/user row: the run's row is owned by the writer's exact session.
      expect(persisted.snapshots[0].executionContextKey).toMatch(/^session:/);

      // Runtime B joins the SAME live piece. A's rows are owned by A's exact
      // session, so B's boot listing returns nothing and B runs fresh.
      const resultLink = r1.getAsNormalizedFullLink();
      const resultCell2 = rt2.getCellFromLink(resultLink);
      await resultCell2.sync();
      expect(await rt2.start(resultCell2)).toBeTruthy();
      const cancelSink2 = resultCell2.key("doubled").sink(() => {});
      await rt2.idle();
      await rt2.storageManager.synced();
      await rt2.idle();
      expect(resultCell2.key("doubled").getAsQueryResult()).toBe(2);

      // FAIL-CLOSED: runtime A writes the input; A's source-backed computation
      // runs and commits; B receives the doc writes via the subscription push
      // but no adoptable row (A's row is session-owned), so B converges by
      // running its own computation.
      rt2.scheduler.setActionRunTraceEnabled(true);
      const adoptedBefore = adoptOkCount();
      const tx2 = rt1.edit();
      valueCell1.withTx(tx2).set(10);
      expect((await tx2.commit()).error).toBeUndefined();
      await rt1.idle();
      await rt1.storageManager.synced();

      expect(
        await waitForCellValue<number>(
          rt2,
          resultCell2.key("doubled"),
          (v) => v === 20,
        ),
      ).toBe(20);
      const liveTrace = rt2.scheduler.getActionRunTrace();
      expect(opRuns(liveTrace).length).toBeGreaterThan(0);
      expect(adoptOkCount()).toBe(adoptedBefore);

      // LOCAL REACTIVITY: a B-local write runs B's own lift, as before.
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
      expect(
        await waitForCellValue<number>(
          rt2,
          resultCell2.key("doubled"),
          (v) => v === 14,
        ),
      ).toBe(14);

      expect(
        await waitForCellValue<number>(
          rt1,
          r1.key("doubled"),
          (v) => v === 14,
        ),
      ).toBe(14);

      cancelSink1();
      cancelSink2();
    } finally {
      await rt1.dispose();
      await rt2.dispose();
    }
  });
});
