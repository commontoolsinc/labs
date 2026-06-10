#!/usr/bin/env -S deno run --allow-read

import { parseShard, shardForFile, stableShardForName } from "./shard-utils.ts";
export { parseShard, stableShardForName };

// Explicit assignments balance the four runner-test shards by wall-time.
// The heaviest files are spread across shards so no single shard dominates.
// Files not listed here fall through to a stable hash of their filename.
const FOUR_SHARD_ASSIGNMENTS: Record<string, number> = {
  "engine.test.ts": 1, // ~700k weight, heaviest — runs with hash-assigned small files

  "piece-helpers.test.ts": 2, // ~320k
  "memory-v2-watch-refresh-race.test.ts": 2, // ~95k
  "pattern-scope.test.ts": 2, // ~75k

  "json-utils.test.ts": 3, // ~210k
  "runner.test.ts": 3, // ~100k
  "wish.test.ts": 3, // ~95k
  "navigate-handler.test.ts": 3, // ~80k

  "reactive-dependencies.test.ts": 4, // ~180k
  "pattern-manager.test.ts": 4, // ~145k
  "data-updating.test.ts": 4, // ~80k
  "scheduler-ordering.test.ts": 4, // ~80k
};

export function shardForRunnerTestFile(
  name: string,
  total: number,
): number {
  return shardForFile(name, total, FOUR_SHARD_ASSIGNMENTS);
}

export function selectRunnerTestFiles(
  files: { name: string }[],
  shard: { index: number; total: number },
): string[] {
  return files
    .filter((file) =>
      shardForRunnerTestFile(file.name, shard.total) === shard.index
    )
    .map((file) => file.name)
    .sort();
}

async function listRunnerTests(): Promise<{ name: string }[]> {
  const testDir = new URL("../packages/runner/test/", import.meta.url);
  const files: { name: string }[] = [];

  for await (const entry of Deno.readDir(testDir)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      files.push({ name: entry.name });
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

if (import.meta.main) {
  const shard = parseShard(Deno.args[0] ?? "");
  const files = await listRunnerTests();
  const selected = selectRunnerTestFiles(files, shard)
    .map((name) => `./test/${name}`);

  if (selected.length === 0) {
    throw new Error(`No runner test files selected for ${Deno.args[0]}`);
  }

  console.log(selected.join("\n"));
}
