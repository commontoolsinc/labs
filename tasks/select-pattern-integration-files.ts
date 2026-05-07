#!/usr/bin/env -S deno run --allow-read

type Shard = {
  index: number;
  total: number;
};

const FOUR_SHARD_ASSIGNMENTS: Record<string, number> = {
  "all.test.ts": 1,

  "cfc-spec-gallery.test.ts": 2,
  "default-app.test.ts": 2,
  "chat-note.test.ts": 2,
  "fetch-data.test.ts": 2,
  "instantiate-pattern.test.ts": 2,

  "cfc-authorized-save.test.ts": 3,
  "cfc-staged-publish.test.ts": 3,
  "cfc-render-policy-demo.test.ts": 3,
  "llm.test.ts": 3,

  "nested-counter.test.ts": 4,
  "counter.test.ts": 4,
  "cfc-authorship-chat.test.ts": 4,
  "chatbot.test.ts": 4,
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

export function stableShardForName(name: string, total: number): number {
  let hash = 2166136261;
  for (const char of name) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % total + 1;
}

export function shardForPatternIntegrationFile(
  name: string,
  total: number,
): number {
  if (total === 4 && FOUR_SHARD_ASSIGNMENTS[name]) {
    return FOUR_SHARD_ASSIGNMENTS[name];
  }
  return stableShardForName(name, total);
}

async function listPatternIntegrationTests(): Promise<string[]> {
  const integrationDir = new URL(
    "../packages/patterns/integration/",
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
  const files = await listPatternIntegrationTests();
  const selected = files
    .filter((name) =>
      shardForPatternIntegrationFile(name, shard.total) === shard.index
    )
    .map((name) => `./integration/${name}`);

  if (selected.length === 0) {
    throw new Error(
      `No pattern integration files selected for ${Deno.args[0]}`,
    );
  }

  console.log(selected.join("\n"));
}
