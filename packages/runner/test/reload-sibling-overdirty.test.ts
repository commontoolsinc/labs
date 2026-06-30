import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";

// CT-1623 reload re-run regression guard: sibling-field over-dirty.
//
// A pattern whose computeds write SIBLING fields of the same result cell
// (doubled, plusOne, label) used to persist the up-chain computeds with a
// spurious server-side `directDirtySeq`, so on reload they rehydrated-as-dirty
// and RE-RAN even though their inputs were unchanged.
//
// Root cause (packages/memory/v2/engine.ts): when a computed FIRST writes its
// output field, the JSON patch is an `add`, and `touchedPathsForPatch` emits the
// PARENT container path (e.g. `["value"]`) in addition to the leaf
// (`["value","plusOne"]`). The server-side scheduler reader index matches that
// parent write against EVERY sibling reader by path prefix — with no per-field
// value comparison (unlike the in-memory `determineTriggeredActions`, which
// deep-equals) — so unchanged siblings are persisted dirty and re-run on reload.
// The fix makes the scheduler write-address extraction use leaf-only paths
// (`schedulerTouchedLeafPathsForPatch`); the leaf already matches whole-object /
// shape readers via `schedulerPathsOverlap`, so the parent path was redundant
// and only caused the spurious sibling dirtying.
//
// This guard asserts the chained computeds persist CLEAN (no directDirtySeq) and
// rehydrate without misses on reload. Before the fix the first two persisted
// with directDirtySeq set. Harness note (see reload-rehydration.test.ts): keep
// runtime A's StorageManager open for B; quiesce A with scheduler.dispose().

const signer = await Identity.fromPassphrase("reload sibling overdirty guard");
const space = signer.did();

// dbl -> plusOne -> label, all writing sibling fields of the one result cell.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, computed, lift } from 'commonfabric';",
      "const dbl = lift((n: number) => n * 2);",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  const doubled = dbl(value);",
      "  const plusOne = computed(() => (doubled as any) + 1);",
      "  const label = computed(() => 'v=' + (plusOne as any));",
      "  return { doubled, plusOne, label };",
      "});",
    ].join("\n"),
  }],
};

function newRuntime(sm: ReturnType<typeof StorageManager.emulate>) {
  return new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm,
    experimental: { persistentSchedulerState: true },
  });
}

async function mainTsxSnapshots(runtime: Runtime) {
  const provider = runtime.storageManager.open(space) as {
    listSchedulerActionSnapshots?: (
      q: Record<string, unknown>,
    ) => Promise<{
      snapshots: {
        directDirtySeq?: number;
        staleSeq?: number;
        observation: { actionId?: string };
      }[];
    }>;
  };
  const res = await provider.listSchedulerActionSnapshots!({
    ownerSpace: space,
    limit: 1000,
  });
  // Action ids are content-addressed (`cf:module/<hash>:<symbol>`) and path-free
  // — the source path now lives only in the debug `.src`/`location`. This
  // isolated runtime persists only this pattern's computeds, so the module
  // prefix selects exactly them.
  return res.snapshots.filter((s) =>
    (s.observation.actionId ?? "").startsWith("cf:module/")
  );
}

function rehydrationCounts() {
  const b = getLoggerCountsBreakdown().scheduler ?? {};
  const get = (k: string) =>
    (b as Record<string, { total?: number }>)[k]?.total ?? 0;
  return {
    ok: get("rehydrate/ok"),
    missNoSnapshot: get("rehydrate/miss/no-snapshot"),
  };
}

Deno.test("reload: sibling-field computeds persist clean and do not re-run", async () => {
  const storageManager = StorageManager.emulate({ as: signer });

  // CREATE (runtime A).
  const runtimeA = newRuntime(storageManager);
  const compiledA = await runtimeA.patternManager.compilePattern(PROGRAM);
  const tx0 = runtimeA.edit();
  const resultCellA = runtimeA.getCell<any>(space, "so-result", undefined, tx0);
  const handleA = runtimeA.run(tx0, compiledA, { value: 5 }, resultCellA);
  await tx0.commit();
  for (let k = 0; k < 8; k++) {
    await handleA.pull();
    await runtimeA.idle();
  }
  await runtimeA.storageManager.synced();
  expect(resultCellA.getAsQueryResult()).toEqual({
    doubled: 10,
    plusOne: 11,
    label: "v=11",
  });

  // All three computeds persisted; NONE should carry a spurious dirty/stale seq.
  // (Before the fix, dbl + plusOne persisted with directDirtySeq set.)
  const snaps = await mainTsxSnapshots(runtimeA);
  expect(snaps.length).toBe(3);
  for (const s of snaps) {
    expect(s.directDirtySeq).toBeUndefined();
    expect(s.staleSeq).toBeUndefined();
  }

  runtimeA.scheduler.dispose();
  getLogger("scheduler").resetCounts();

  // RELOAD (runtime B, same storage). The computeds rehydrate; none miss.
  const runtimeB = newRuntime(storageManager);
  try {
    const compiledB = await runtimeB.patternManager.compilePattern(PROGRAM);
    const tx = runtimeB.edit();
    const resultCellB = runtimeB.getCell<any>(
      space,
      "so-result",
      undefined,
      tx,
    );
    const handleB = runtimeB.run(tx, compiledB, { value: 5 }, resultCellB);
    await tx.commit();
    for (let k = 0; k < 8; k++) {
      await handleB.pull();
      await runtimeB.idle();
    }
    expect(resultCellB.getAsQueryResult()).toEqual({
      doubled: 10,
      plusOne: 11,
      label: "v=11",
    });
  } finally {
    await runtimeB.dispose();
  }

  const reload = rehydrationCounts();
  expect(reload.ok).toBeGreaterThan(0);
  expect(reload.missNoSnapshot).toBe(0);
});
