#!/usr/bin/env -S deno run --allow-read

import { parseShard } from "./shard-utils.ts";
import { RUNNER_TEST_WEIGHTS } from "./test-timing-weights.ts";
import { assignWeightedShards } from "./weighted-shards.ts";
export { parseShard };

// Observed timings place expensive files first. Files absent from the profile
// receive a unit weight, so newly added tests remain covered and spread evenly.
export function selectRunnerTestFiles(
  files: { name: string }[],
  shard: { index: number; total: number },
  weights: Readonly<Record<string, number>> = RUNNER_TEST_WEIGHTS,
): string[] {
  const names = files.map((file) => file.name);
  const assignments = assignWeightedShards(
    names.map((name) => ({ name, weight: weights[name] ?? 1 })),
    shard.total,
  );
  return names
    .filter((name) => assignments.get(name) === shard.index)
    .sort();
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
