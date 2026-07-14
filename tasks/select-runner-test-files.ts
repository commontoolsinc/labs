#!/usr/bin/env -S deno run --allow-read

import { parseShard } from "./shard-utils.ts";
export { parseShard };

const FIVE_WAY_SHARD_ASSIGNMENTS: Readonly<Partial<Record<string, number>>> = {
  "engine-ses.test.ts": 1,
  "fabric-imports-engine.test.ts": 2,
  "json-utils.test.ts": 1,
};

// Runner test files are split across shards by round-robin over the sorted file
// list. The five-way CI split pins a few long-running files to named shards, so
// one bucket does not carry the slowest files together.
export function selectRunnerTestFiles(
  files: { name: string }[],
  shard: { index: number; total: number },
): string[] {
  return files
    .map((file) => file.name)
    .sort()
    .filter((name, i) => {
      const assignedShard = shard.total === 5
        ? FIVE_WAY_SHARD_ASSIGNMENTS[name]
        : undefined;
      return assignedShard === undefined
        ? i % shard.total === shard.index - 1
        : assignedShard === shard.index;
    });
}

export async function listRunnerTests(): Promise<{ name: string }[]> {
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
