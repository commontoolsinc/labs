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

export const PATTERN_INTEGRATION_SHARD_COUNT = 8;

// The assignment includes the measured work from the files that run in
// every job. Its measured files leave shard 1 with only internally sharded
// work.
export const PATTERN_INTEGRATION_SHARD_ASSIGNMENTS: Readonly<
  Record<string, number>
> = {
  // shard 2
  "cf-code-editor.test.ts": 2,
  "cfc-authorship-chat.test.ts": 2,
  "cfc-group-chat-demo-multi-runtime.test.ts": 2,
  "cfc-spec-gallery.test.ts": 2,
  "chat-note.test.ts": 2,
  "llm.test.ts": 2,

  // shard 3
  "cf-checkbox.test.ts": 3,
  "cfc-authorized-save.test.ts": 3,
  "cfc-group-chat-demo-two-browsers.test.ts": 3,
  "chatbot.test.ts": 3,
  "convergence-storm.test.ts": 3,
  "fetch-json.test.ts": 3,
  "group-chat-adoption-bench.test.ts": 3,

  // shard 4
  "cell-flip-shaping.test.ts": 4,
  "default-app.test.ts": 4,
  "shared-profile.test.ts": 4,
  "sqlite-db-owner-multi-runtime.test.ts": 4,
  "topics-navigation.test.ts": 4,

  // shard 5
  "cfc-group-chat-demo.test.ts": 5,
  "cfc-render-policy-demo.test.ts": 5,
  "instantiate-pattern.test.ts": 5,
  "lunch-poll-vote.test.ts": 5,
  "sqlite-read-clearance-multi-runtime.test.ts": 5,

  // shard 6
  "cellset-lww.test.ts": 6,
  "cfc-browser-helpers.test.ts": 6,
  "cfc-staged-publish.test.ts": 6,
  "nested-counter.test.ts": 6,
  "record-module-chrome.test.ts": 6,

  // shard 7
  "cf-render.test.ts": 7,
  "counter.test.ts": 7,
  "home-profile.test.ts": 7,
  "parking-coordinator-admin-view.test.ts": 7,
  "time-capability-intrinsics.test.ts": 7,

  // shard 8
  "cellset-lww-lost-update.test.ts": 8,
  "home-profile-reload-durability.test.ts": 8,
  "home-rehydration-churn.test.ts": 8,
  "note-append-link.test.ts": 8,
  "profile-embed.test.ts": 8,
};

// Assign each file without internal sharding to one shard. Unlisted files use
// round-robin assignment.
export function assignPatternIntegrationShards(
  files: string[],
  total: number,
): Map<string, number> {
  if (total !== PATTERN_INTEGRATION_SHARD_COUNT) {
    throw new Error(
      `Pattern integration assignments require ${PATTERN_INTEGRATION_SHARD_COUNT} shards, got ${total}`,
    );
  }
  const assignment = new Map<string, number>();
  let roundRobin = 0;
  for (
    const name of files.filter((name) => !INTERNALLY_SHARDED_FILE_SET.has(name))
      .sort()
  ) {
    const pinned = PATTERN_INTEGRATION_SHARD_ASSIGNMENTS[name];
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
