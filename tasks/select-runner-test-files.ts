#!/usr/bin/env -S deno run --allow-read

import { parseShard } from "./shard-utils.ts";
export { parseShard };

// Runner test files are split across shards by round-robin over the sorted file
// list. There is no per-file weighting: a byte-size table used to live here, but
// file size does not track run time, so it balanced no better than plain
// round-robin. A time-weighted split would do better and can be added if the
// imbalance starts to matter on the critical path.
export function selectRunnerTestFiles(
  files: { name: string }[],
  shard: { index: number; total: number },
): string[] {
  return files
    .map((file) => file.name)
    .sort()
    .filter((_, i) => i % shard.total === shard.index - 1);
}

export async function listRunnerTests(): Promise<{ name: string }[]> {
  const testDir = new URL("../packages/runner/test/", import.meta.url);
  const files: { name: string }[] = [];

  // Recurse so test files in subdirectories (e.g. test/reactive-interpreter/*)
  // are sharded too. The non-recursive readDir used to silently drop every
  // nested test: CI ran green because dropped files simply never executed.
  // Names are stored as POSIX-relative paths from test/ (e.g.
  // "reactive-interpreter/partition.test.ts"); the CLI prefixes "./test/".
  async function walk(dir: URL, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        await walk(
          new URL(`${entry.name}/`, dir),
          `${prefix}${entry.name}/`,
        );
      } else if (entry.isFile && entry.name.endsWith(".test.ts")) {
        files.push({ name: `${prefix}${entry.name}` });
      }
    }
  }

  await walk(testDir, "");

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
