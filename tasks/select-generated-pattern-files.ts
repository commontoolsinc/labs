#!/usr/bin/env -S deno run --allow-read

import { parseShard, type Shard } from "./shard-utils.ts";
export { parseShard };

export function selectGeneratedPatternFiles(
  names: string[],
  shard: Shard,
): string[] {
  return [...names]
    .sort()
    .filter((_, index) => index % shard.total === shard.index - 1);
}

export async function listGeneratedPatternTests(): Promise<string[]> {
  const integrationDir = new URL(
    "../packages/generated-patterns/integration/patterns/",
    import.meta.url,
  );
  const files: string[] = [];

  for await (const entry of Deno.readDir(integrationDir)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      files.push(entry.name);
    }
  }

  files.sort();
  return files;
}

if (import.meta.main) {
  const shard = parseShard(Deno.args[0] ?? "");
  const files = await listGeneratedPatternTests();
  const selected = selectGeneratedPatternFiles(files, shard)
    .map((name) => `./integration/patterns/${name}`);

  if (selected.length === 0) {
    throw new Error(
      `No generated pattern files selected for ${Deno.args[0]}`,
    );
  }

  console.log(selected.join("\n"));
}
