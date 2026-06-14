#!/usr/bin/env -S deno run --allow-read

import { parseShard, shardForFile, stableShardForName } from "./shard-utils.ts";
export { parseShard, stableShardForName };

// Explicit assignments balance the four browser-integration shards by
// wall-time. The heaviest end-to-end tests (~45-52s each) are spread one per
// shard so no single shard dominates. `all.test.ts` is the heaviest single
// file and gets its own shard. Approx test wall-times (excluding ~35s
// server/browser startup per shard) keep shards within ~100-115s of each other.
const FOUR_SHARD_ASSIGNMENTS: Record<string, number> = {
  "all.test.ts": 1, // ~heavy, runs alone

  "cfc-group-chat-demo.test.ts": 2, // ~52s
  "default-app.test.ts": 2, // ~47s
  "chat-note.test.ts": 2, // tiny
  "fetch-data.test.ts": 2, // tiny
  "instantiate-pattern.test.ts": 2, // ~1s

  "cfc-authorized-save.test.ts": 3, // ~25s
  "cfc-staged-publish.test.ts": 3, // ~24s
  "cfc-render-policy-demo.test.ts": 3, // ~17s
  "llm.test.ts": 3, // tiny
  "parking-coordinator-admin-view.test.ts": 3, // ~42s

  "nested-counter.test.ts": 4, // ~21s
  "counter.test.ts": 4, // ~21s
  "cfc-authorship-chat.test.ts": 4, // ~22s
  "chatbot.test.ts": 4, // tiny
  "cfc-spec-gallery.test.ts": 4, // ~45s
};

export function shardForPatternIntegrationFile(
  name: string,
  total: number,
): number {
  return shardForFile(name, total, FOUR_SHARD_ASSIGNMENTS);
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
