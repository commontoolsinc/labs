#!/usr/bin/env -S deno run --allow-read

import { parseShard } from "./shard-utils.ts";
export { parseShard };

// These files run in every shard and divide their own independent cases by
// PATTERN_INTEGRATION_SHARD. They are excluded from the per-file assignment
// below.
export const INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES = [
  "all.test.ts",
  "time-capability-full.test.ts",
  "time-capability.test.ts",
] as const;
const INTERNALLY_SHARDED_FILE_SET = new Set<string>(
  INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES,
);

// Explicit assignments balance the canonical four browser-integration shards
// using observed CI per-file timings. Files added after the latest profile fall
// back to round-robin over the unlisted files.
export const FOUR_SHARD_ASSIGNMENTS: Readonly<Record<string, number>> = {
  // shard 1
  "parking-coordinator-admin-view.test.ts": 1,
  "nested-counter.test.ts": 1,
  "chat-note.test.ts": 1,
  "fetch-json.test.ts": 1,
  "cell-flip-shaping.test.ts": 1,
  "cf-code-editor.test.ts": 1,
  "home-profile-reload-durability.test.ts": 1,
  "sqlite-db-owner-multi-runtime.test.ts": 1,
  "topics-diagnose-scripted.test.ts": 1,

  // shard 2
  "cfc-group-chat-demo-two-browsers.test.ts": 2,
  "cfc-staged-publish.test.ts": 2,
  "cfc-group-chat-demo-multi-runtime.test.ts": 2,
  "cfc-authorship-chat.test.ts": 2,
  "cellset-lww-lost-update.test.ts": 2,
  "cf-render.test.ts": 2,
  "home-rehydration-churn.test.ts": 2,
  "sqlite-read-clearance-multi-runtime.test.ts": 2,

  // shard 3
  "cfc-spec-gallery.test.ts": 3,
  "shared-profile.test.ts": 3,
  "cfc-render-policy-demo.test.ts": 3,
  "counter.test.ts": 3,
  "cellset-lww.test.ts": 3,
  "convergence-storm.test.ts": 3,
  "lunch-poll-vote.test.ts": 3,
  "profile-embed.test.ts": 3,
  "time-capability-intrinsics.test.ts": 3,

  // shard 4
  "cfc-authorized-save.test.ts": 4,
  "cfc-group-chat-demo.test.ts": 4,
  "default-app.test.ts": 4,
  "home-profile.test.ts": 4,
  "instantiate-pattern.test.ts": 4,
  "llm.test.ts": 4,
  "chatbot.test.ts": 4,
  "cf-checkbox.test.ts": 4,
  "group-chat-adoption-bench.test.ts": 4,
  "note-append-link.test.ts": 4,
};

// Assign each file without internal sharding to one shard: the explicit table
// when running the canonical four-way split, else round-robin over the unlisted
// files so a newly added file still lands somewhere even.
export function assignPatternIntegrationShards(
  files: string[],
  total: number,
): Map<string, number> {
  const assignment = new Map<string, number>();
  let roundRobin = 0;
  for (
    const name of files.filter((name) => !INTERNALLY_SHARDED_FILE_SET.has(name))
      .sort()
  ) {
    const pinned = total === 4 ? FOUR_SHARD_ASSIGNMENTS[name] : undefined;
    assignment.set(name, pinned ?? (roundRobin++ % total) + 1);
  }
  return assignment;
}

// Select the files for one shard. Internally sharded files are included in
// every shard; the remaining files are assigned to exactly one shard each.
export function selectPatternIntegrationFiles(
  files: string[],
  shard: { index: number; total: number },
): string[] {
  const selected: string[] = [];
  for (
    const [name, assigned] of assignPatternIntegrationShards(files, shard.total)
  ) {
    if (assigned === shard.index) selected.push(`./integration/${name}`);
  }

  const internallySharded = INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES
    .filter((name) => files.includes(name))
    .map((name) => `./integration/${name}`);

  return [...internallySharded, ...selected];
}

export async function listPatternIntegrationTests(): Promise<string[]> {
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
  const selected = selectPatternIntegrationFiles(files, shard);

  if (selected.length === 0) {
    throw new Error(
      `No pattern integration files selected for ${Deno.args[0]}`,
    );
  }

  console.log(selected.join("\n"));
}
