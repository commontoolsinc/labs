import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type JSONSchema, NAME } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";

// Reload regression guard for persistent scheduler state: a pattern resumed
// from a synced state (runtime B sharing runtime A's storage) should rehydrate
// its persisted observations rather than re-run them.
//
// IMPORTANT harness note: do NOT call `runtimeA.dispose()` before runtime B —
// `Runtime.dispose()` calls `storageManager.close()`, which tears down the
// storage shared with B (B would then see zero persisted snapshots). Quiesce A
// with `A.scheduler.dispose()` and keep the StorageManager open; flush the
// batched scheduler observations with `await A.storageManager.synced()`.

const signer = await Identity.fromPassphrase("reload rehydration guard");
const space = signer.did();

function matchingSchema(index: number): JSONSchema {
  return {
    type: "object",
    title: `note ${index}`,
    description: "This schema matches #notebook.",
    properties: { [NAME]: { type: "string" }, body: { type: "string" } },
  };
}

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, computed, wish } from 'commonfabric';",
      "export default pattern(() => {",
      "  const w = wish({ query: '#notebook', scope: ['.'], headless: true });",
      "  const candidates = computed(() =>",
      "    Array.isArray((w as any).candidates) ? (w as any).candidates : []);",
      "  const count = computed(() => (candidates as any).length);",
      "  return { result: w, count };",
      "});",
    ].join("\n"),
  }],
};

function setupMentionables(
  runtime: Runtime,
  tx: ReturnType<Runtime["edit"]>,
  count: number,
) {
  const spaceCell = runtime.getCell(space, space, undefined, tx).withTx(tx);
  const defaultPatternCell = runtime.getCell(
    space,
    "rg-default-pattern",
    undefined,
    tx,
  );
  const backlinksIndexCell = runtime.getCell(
    space,
    "rg-backlinks-index",
    undefined,
    tx,
  );
  const mentionables = Array.from({ length: count }, (_, index) => {
    const cell = runtime.getCell(
      space,
      `rg-mentionable-${index}`,
      matchingSchema(index),
      tx,
    );
    cell.set({ [NAME]: "notebook", body: `body-${index}` });
    return cell;
  });
  backlinksIndexCell.set({ mentionable: mentionables });
  defaultPatternCell.set({ backlinksIndex: backlinksIndexCell });
  spaceCell.key("defaultPattern").set(defaultPatternCell);
}

function newRuntime(storageManager: ReturnType<typeof StorageManager.emulate>) {
  return new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { persistentSchedulerState: true },
  });
}

function rehydrationCounts() {
  const b = getLoggerCountsBreakdown().scheduler ?? {};
  const get = (k: string) =>
    (b as Record<string, { total?: number }>)[k]
      ?.total ?? 0;
  return {
    ok: get("rehydrate/ok"),
    missNoSnapshot: get("rehydrate/miss/no-snapshot"),
  };
}

Deno.test("reload: resumed pattern rehydrates persisted observations", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const COUNT = 5;

  // CREATE (runtime A). Keep its storage open for B.
  const runtimeA = newRuntime(storageManager);
  const compiledA = await runtimeA.patternManager.compilePattern(PROGRAM);
  const tx0 = runtimeA.edit();
  setupMentionables(runtimeA, tx0, COUNT);
  const resultCellA = runtimeA.getCell(space, "rg-result", undefined, tx0);
  const handleA = runtimeA.run(tx0, compiledA, {}, resultCellA);
  await tx0.commit();
  for (let k = 0; k < 6; k++) {
    await handleA.pull();
    await runtimeA.idle();
  }
  await runtimeA.storageManager.synced();
  expect(resultCellA.key("count").getAsQueryResult()).toBe(COUNT);
  runtimeA.scheduler.dispose();

  // Reset counters so the reading reflects only the reload runtime.
  getLogger("scheduler").resetCounts();

  // RELOAD (runtime B, same storage).
  const runtimeB = newRuntime(storageManager);
  try {
    await runtimeB.patternManager.compilePattern(PROGRAM);
    const resultCellB = runtimeB.getCell(space, "rg-result", undefined);
    const provider = runtimeB.storageManager.open(space);
    const listSnapshots = provider.listSchedulerActionSnapshots?.bind(
      provider,
    );
    expect(listSnapshots).toBeDefined();
    const snapshotQueries: unknown[] = [];
    provider.listSchedulerActionSnapshots = (query) => {
      snapshotQueries.push(query);
      return listSnapshots!(query);
    };

    await runtimeB.start(resultCellB);
    await runtimeB.idle();

    expect(resultCellB.key("count").getAsQueryResult()).toBe(COUNT);
    // Per-doc rehydration: ONE space-wide listing per resumed boot (no
    // pieceId filter — descendants consume their own buckets from the same
    // listing). See docs/specs/scheduler-v2/per-doc-rehydration.md §3.1.
    expect(snapshotQueries).toEqual([{
      ownerSpace: space,
      processGeneration: 0,
    }]);
  } finally {
    await runtimeB.dispose();
  }

  const reload = rehydrationCounts();
  expect(reload.ok).toBeGreaterThan(0);
  expect(reload.missNoSnapshot).toBe(0);
});

// F6e: a transient snapshot-listing failure during resume must degrade to
// "run fresh", not hard-fail start(). Pre-PR, rehydration failures were
// swallowed; the resume chain now has no try/catch around the listing.
Deno.test("reload: transient snapshot listing failure degrades to resume-fresh", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const COUNT = 5;

  // CREATE (runtime A). Keep its storage open for B.
  const runtimeA = newRuntime(storageManager);
  const compiledA = await runtimeA.patternManager.compilePattern(PROGRAM);
  const tx0 = runtimeA.edit();
  setupMentionables(runtimeA, tx0, COUNT);
  const resultCellA = runtimeA.getCell(space, "rg-result", undefined, tx0);
  const handleA = runtimeA.run(tx0, compiledA, {}, resultCellA);
  await tx0.commit();
  for (let k = 0; k < 6; k++) {
    await handleA.pull();
    await runtimeA.idle();
  }
  await runtimeA.storageManager.synced();
  expect(resultCellA.key("count").getAsQueryResult()).toBe(COUNT);
  runtimeA.scheduler.dispose();

  // RELOAD (runtime B, same storage) with a listing that throws.
  const runtimeB = newRuntime(storageManager);
  try {
    await runtimeB.patternManager.compilePattern(PROGRAM);
    const resultCellB = runtimeB.getCell(space, "rg-result", undefined);
    const provider = runtimeB.storageManager.open(space);
    provider.listSchedulerActionSnapshots = () => {
      throw new Error("transient snapshot listing failure");
    };

    // start() must not reject on the transient listing failure — it resumes
    // fresh and the piece still runs to the correct count.
    await runtimeB.start(resultCellB);
    await runtimeB.idle();

    expect(resultCellB.key("count").getAsQueryResult()).toBe(COUNT);
  } finally {
    await runtimeB.dispose();
  }
});
