import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// F6c (docs/specs/scheduler-v2/per-doc-rehydration.md): a resumed piece with
// map rows must re-attach the per-element child runs AND rehydrate their
// persisted scheduler state — each child persists under its OWN pieceId (its
// result doc), and the boot's space-wide snapshot listing feeds every
// descendant's registration. Pre-fix this failed two ways: a dirty coordinator
// re-ran every row fresh (their clean snapshots sat unused), and a clean
// coordinator never ran at all, stranding the rows unregistered (dead
// per-element reactivity).
//
// Two managers with their OWN replicas loopback-connected to one in-process
// server (same shape as resume-argument-link-target-presync.test.ts), so
// session 1 can be FULLY disposed before session 2 resumes — a shared
// emulate manager would leave session 1's registered actions servicing
// writes and mask the stranded-rows failure mode.

const signer = await Identity.fromPassphrase(
  "reload rehydration map children",
);
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

function rehydrationCounts() {
  const b = getLoggerCountsBreakdown().scheduler ?? {};
  const get = (k: string) =>
    (b as Record<string, { total?: number }>)[k]?.total ?? 0;
  return {
    ok: get("rehydrate/ok"),
    fallbackRun: get("rehydrate/fallback-run/no-match"),
  };
}

// Per-element op runs are the module-hash-stamped lift actions; the map
// coordinator (`raw:map:*`) and test sinks are not.
function opRuns(trace: readonly { actionId: string }[]): string[] {
  return trace.map((e) => e.actionId).filter((id) =>
    id.startsWith("cf:module/")
  );
}

describe("reload rehydration: map per-element children", () => {
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

  it("resumed map rows rehydrate instead of re-running, and stay live", async () => {
    // Session 1: create + settle, then dispose ENTIRELY.
    const rt1 = newRuntime(managerA);
    const tx1 = rt1.edit();
    const itemsCell1 = rt1.getCell(space, "map-items", ITEMS_SCHEMA, tx1);
    itemsCell1.withTx(tx1).set([{ v: 1 }, { v: 2 }, { v: 3 }]);
    const compiled = await rt1.patternManager.compilePattern(PROGRAM, {
      space,
      tx: tx1,
    });
    const resultCell1 = rt1.getCell(space, "map-result", undefined, tx1);
    // deno-lint-ignore no-explicit-any
    const r1 = rt1.run(
      tx1,
      compiled as any,
      { items: itemsCell1 },
      resultCell1,
    );
    rt1.prepareTxForCommit(tx1);
    const commit1 = await tx1.commit();
    expect(commit1.error).toBeUndefined();
    const cancelSink1 = r1.sink(() => {});
    await rt1.idle();
    expect(await r1.key("vs").pull()).toEqual([2, 4, 6]);
    cancelSink1();
    await rt1.patternManager.flushCompileCacheWrites();
    await rt1.storageManager.synced();
    await rt1.idle();
    await rt1.storageManager.synced();

    // Each per-element child persisted under its OWN pieceId: the store holds
    // more piece buckets than just the root's.
    {
      const provider = managerA.open(space);
      const page = await provider.listSchedulerActionSnapshots!({
        ownerSpace: space,
        limit: 1000,
      });
      const pieceIds = new Set(
        page.snapshots.map((s) =>
          (s.observation as { pieceId?: string }).pieceId
        ),
      );
      const root = r1.getAsNormalizedFullLink();
      expect(pieceIds.has(`${root.scope}:${root.id}`)).toBe(true);
      // 3 per-element pieces beyond the root (one per mapped row).
      expect(pieceIds.size).toBeGreaterThanOrEqual(4);
    }

    const resultLink = r1.getAsNormalizedFullLink();
    await rt1.dispose();

    getLogger("scheduler").resetCounts();

    // Session 2 (cold replicas, session 1 fully gone): resume.
    const rt2 = newRuntime(managerB);
    try {
      rt2.scheduler.setActionRunTraceEnabled(true);
      const resultCell2 = rt2.getCellFromLink(resultLink);
      await resultCell2.sync();
      const started = await rt2.start(resultCell2);
      expect(started).toBeTruthy();
      const cancelSink2 = resultCell2.key("vs").sink(() => {});
      await rt2.idle();
      await rt2.storageManager.synced();
      await rt2.idle();

      // The per-element ops rehydrated from their own piece buckets: none of
      // them re-ran during the resume (the coordinator's reconcile may run —
      // it is declared resumeMode "always-run" to re-attach the rows — but
      // the row computations must not).
      const resumeTrace = rt2.scheduler.getActionRunTrace();
      expect(opRuns(resumeTrace)).toEqual([]);
      const counts = rehydrationCounts();
      expect(counts.ok).toBeGreaterThanOrEqual(3);
      expect(counts.fallbackRun).toBe(0);

      expect(await resultCell2.key("vs").pull()).toEqual([2, 4, 6]);

      // LIVENESS (guards the stranded-rows mode): a post-resume write to one
      // element's field re-derives exactly that row.
      const beforeWrite = rt2.scheduler.getActionRunTrace().length;
      const itemsCell2 = rt2.getCell(space, "map-items", ITEMS_SCHEMA);
      await itemsCell2.sync();
      const tx2 = rt2.edit();
      itemsCell2.withTx(tx2).key(0).key("v").set(10);
      await tx2.commit();
      await rt2.idle();
      const writeTrace = rt2.scheduler.getActionRunTrace().slice(beforeWrite);
      expect(opRuns(writeTrace).length).toBe(1);
      expect(await resultCell2.key("vs").pull()).toEqual([20, 4, 6]);

      // A structural append reconciles and runs only the NEW row.
      const beforeAppend = rt2.scheduler.getActionRunTrace().length;
      const tx3 = rt2.edit();
      itemsCell2.withTx(tx3).push({ v: 5 });
      await tx3.commit();
      await rt2.idle();
      const appendTrace = rt2.scheduler.getActionRunTrace().slice(beforeAppend);
      expect(opRuns(appendTrace).length).toBe(1);
      expect(resultCell2.key("vs").getAsQueryResult()).toEqual([20, 4, 6, 10]);
      cancelSink2();
    } finally {
      await rt2.dispose();
    }
  });
});
