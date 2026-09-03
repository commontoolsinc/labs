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

// Measured case timings from the files that run in every job, arranged by their
// current shard selectors. Ordinary files are placed on top of these loads.
export const PATTERN_INTEGRATION_INITIAL_SHARD_LOADS = [
  109.8,
  50.4,
  176.8,
  45.5,
  78.0,
  54.5,
  47.0,
  71.4,
  65.8,
  85.3,
] as const;
export const PATTERN_INTEGRATION_SHARD_COUNT =
  PATTERN_INTEGRATION_INITIAL_SHARD_LOADS.length;

// Relative weights from the latest successful CI profile. Files absent from
// the profile receive a unit weight.
export const PATTERN_INTEGRATION_TEST_WEIGHTS: Readonly<
  Record<string, number>
> = {
  "cf-code-editor.test.ts": 40.7,
  "convergence-storm.test.ts": 30.0,
  "lunch-poll-vote.test.ts": 42.5,
  "parking-coordinator-admin-view.test.ts": 42.3,
  "home-profile.test.ts": 37.0,
  "cfc-group-chat-demo.test.ts": 21.8,
  "profile-embed.test.ts": 28.7,
  "home-profile-reload-durability.test.ts": 22.8,
  "default-app.test.ts": 30.9,
  "cfc-group-chat-demo-multi-runtime.test.ts": 14.5,
  "home-rehydration-churn.test.ts": 26.1,
  "cfc-group-chat-demo-two-browsers.test.ts": 32.8,
  "shared-profile.test.ts": 29.0,
  "cfc-authorized-save.test.ts": 10.0,
  "cfc-spec-gallery.test.ts": 30.4,
  "cfc-staged-publish.test.ts": 24.1,
  "cf-checkbox.test.ts": 10.8,
  "cfc-browser-helpers.test.ts": 13.1,
  "cellset-lww.test.ts": 16.0,
  "cfc-render-policy-demo.test.ts": 9.2,
  "topics-navigation.test.ts": 19.6,
  "cfc-authorship-chat.test.ts": 8.9,
  "cf-render.test.ts": 11.6,
  "sqlite-read-clearance-multi-runtime.test.ts": 8.6,
  "cellset-lww-lost-update.test.ts": 6.7,
  "note-append-link.test.ts": 5.4,
  "instantiate-pattern.test.ts": 6.6,
  "sqlite-db-owner-multi-runtime.test.ts": 7.9,
  "counter.test.ts": 7.0,
  "nested-counter.test.ts": 5.7,
  "time-capability-intrinsics.test.ts": 6.2,
  "cell-flip-shaping.test.ts": 1.2,
  "llm.test.ts": 0.3,
  "chat-note.test.ts": 0.3,
  "chatbot.test.ts": 0.4,
  "fetch-json.test.ts": 0.4,
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
