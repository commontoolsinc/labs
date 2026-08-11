#!/usr/bin/env -S deno run --allow-read

import { parseShard } from "./shard-utils.ts";
import { assignWeightedShards } from "./weighted-shards.ts";
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

// Measured work from the files that run in every job and divide their cases by
// shard. Ordinary files are placed on top of these existing loads.
export const PATTERN_INTEGRATION_INITIAL_SHARD_LOADS = [
  218.0,
  93.7,
  55.2,
  57.1,
  114.2,
  45.8,
  92.8,
  119.8,
] as const;
export const PATTERN_INTEGRATION_SHARD_COUNT =
  PATTERN_INTEGRATION_INITIAL_SHARD_LOADS.length;

// Relative weights from the latest successful CI profile. Files absent from
// the profile receive a unit weight.
export const PATTERN_INTEGRATION_TEST_WEIGHTS: Readonly<
  Record<string, number>
> = {
  "record-module-chrome.test.ts": 49.7,
  "cf-code-editor.test.ts": 42.2,
  "convergence-storm.test.ts": 38.2,
  "lunch-poll-vote.test.ts": 35.7,
  "parking-coordinator-admin-view.test.ts": 34.1,
  "home-profile.test.ts": 31.3,
  "cfc-group-chat-demo.test.ts": 30.2,
  "profile-embed.test.ts": 30.1,
  "home-profile-reload-durability.test.ts": 29.0,
  "default-app.test.ts": 28.1,
  "cfc-group-chat-demo-multi-runtime.test.ts": 25.2,
  "home-rehydration-churn.test.ts": 24.7,
  "cfc-group-chat-demo-two-browsers.test.ts": 22.8,
  "shared-profile.test.ts": 22.2,
  "cfc-authorized-save.test.ts": 21.6,
  "cfc-spec-gallery.test.ts": 21.6,
  "cfc-staged-publish.test.ts": 21.0,
  "cf-checkbox.test.ts": 20.8,
  "cfc-browser-helpers.test.ts": 20.7,
  "cellset-lww.test.ts": 19.3,
  "cfc-render-policy-demo.test.ts": 19.0,
  "topics-navigation.test.ts": 18.7,
  "cfc-authorship-chat.test.ts": 18.6,
  "cf-render.test.ts": 16.6,
  "sqlite-read-clearance-multi-runtime.test.ts": 8.8,
  "cellset-lww-lost-update.test.ts": 8.5,
  "note-append-link.test.ts": 7.7,
  "instantiate-pattern.test.ts": 6.9,
  "sqlite-db-owner-multi-runtime.test.ts": 6.7,
  "counter.test.ts": 6.7,
  "nested-counter.test.ts": 6.5,
  "time-capability-intrinsics.test.ts": 5.9,
  "cell-flip-shaping.test.ts": 1.6,
  "llm.test.ts": 0.4,
  "chat-note.test.ts": 0.4,
  "chatbot.test.ts": 0.4,
  "fetch-json.test.ts": 0.3,
  "group-chat-adoption-bench.test.ts": 0.1,
};
// Files at or above this measured duration occupy distinct shards.
export const PATTERN_INTEGRATION_DISTINCT_WEIGHT_MINIMUM = 31;

// Assign each file without internal sharding to one weighted shard.
export function assignPatternIntegrationShards(
  files: string[],
  total: number,
): Map<string, number> {
  if (total !== PATTERN_INTEGRATION_SHARD_COUNT) {
    throw new Error(
      `Pattern integration assignments require ${PATTERN_INTEGRATION_SHARD_COUNT} shards, got ${total}`,
    );
  }
  const ordinaryFiles = files.filter((name) =>
    !INTERNALLY_SHARDED_FILE_SET.has(name)
  );
  return assignWeightedShards(
    ordinaryFiles.map((name) => {
      const weight = PATTERN_INTEGRATION_TEST_WEIGHTS[name] ?? 1;
      return {
        name,
        weight,
        group: weight >= PATTERN_INTEGRATION_DISTINCT_WEIGHT_MINIMUM
          ? "expensive"
          : undefined,
      };
    }),
    total,
    PATTERN_INTEGRATION_INITIAL_SHARD_LOADS,
  );
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
