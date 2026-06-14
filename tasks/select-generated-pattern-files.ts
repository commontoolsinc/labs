#!/usr/bin/env -S deno run --allow-read

type Shard = {
  index: number;
  total: number;
};

export function parseShard(raw: string): Shard {
  const match = raw.match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/);
  if (!match) {
    throw new Error(`Expected shard argument like 1/4, got: ${raw}`);
  }

  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index > total) {
    throw new Error(`Shard index ${index} exceeds total shard count ${total}`);
  }

  return { index, total };
}

export function selectGeneratedPatternFiles(
  names: string[],
  shard: Shard,
): string[] {
  return [...names]
    .sort()
    .filter((_, index) => index % shard.total === shard.index - 1);
}

async function listGeneratedPatternTests(): Promise<string[]> {
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
