#!/usr/bin/env -S deno run --allow-read

import { parseShard } from "./shard-utils.ts";
export { parseShard };

// `all.test.ts` compiles and instantiates every authored pattern, so its cost
// grows with the pattern catalog. It runs in EVERY shard and splits its own
// pattern list by PATTERN_INTEGRATION_SHARD (see
// packages/patterns/integration/all.test.ts), spreading the compile work across
// shards instead of pinning it to one. It is therefore excluded from the
// per-file shard assignment below.
const ALL_PATTERNS_FILE = "all.test.ts";

// These long-running or deliberately high-contention integration tests have
// dedicated CI jobs so they can run in parallel with the regular four shards
// instead of making one shard the bottleneck.
export const INDEPENDENT_PATTERN_INTEGRATION_FILES = [
  "lunch-poll-contention.test.ts",
] as const;

const independentPatternIntegrationFiles = new Set<string>(
  INDEPENDENT_PATTERN_INTEGRATION_FILES,
);

// Explicit assignments balance the four browser-integration shards by
// wall-time, using observed CI per-file timings. The heaviest end-to-end tests
// are parking-coordinator (~43s), cfc-group-chat-demo-two-browsers (~41s),
// cfc-spec-gallery (~33s), cfc-group-chat-demo (~29s), and default-app (~26s);
// they are spread so no shard carries two of them. The two group-chat browser
// tests in particular go on different shards (they alone sum to ~70s). Each
// shard also runs its slice of `all.test.ts` (see above). These weights span
// ~100x, so a count-based split (hash or plain round-robin) cannot balance them;
// the table is what keeps the shards even. Files not listed here fall back to
// round-robin over the unlisted files.
const FOUR_SHARD_ASSIGNMENTS: Record<string, number> = {
  // shard 1
  "parking-coordinator-admin-view.test.ts": 1,
  "cfc-authorized-save.test.ts": 1,
  "nested-counter.test.ts": 1,
  "chat-note.test.ts": 1,
  "fetch-json.test.ts": 1,

  // shard 2
  "cfc-group-chat-demo-two-browsers.test.ts": 2,
  "cfc-staged-publish.test.ts": 2,
  "cfc-group-chat-demo-multi-runtime.test.ts": 2,
  "cfc-authorship-chat.test.ts": 2,

  // shard 3
  "cfc-spec-gallery.test.ts": 3,
  "shared-profile.test.ts": 3,
  "cfc-render-policy-demo.test.ts": 3,
  "counter.test.ts": 3,

  // shard 4
  "cfc-group-chat-demo.test.ts": 4,
  "default-app.test.ts": 4,
  "home-profile.test.ts": 4,
  "instantiate-pattern.test.ts": 4,
  "llm.test.ts": 4,
  "chatbot.test.ts": 4,
};

// Assign each end-to-end file (everything except `all.test.ts`) to a shard:
// the explicit table when running the canonical four-way split, else round-robin
// over the unlisted files so a newly added file still lands somewhere even.
export function assignPatternIntegrationShards(
  files: string[],
  total: number,
): Map<string, number> {
  const assignment = new Map<string, number>();
  let roundRobin = 0;
  for (
    const name of files.filter((name) =>
      name !== ALL_PATTERNS_FILE &&
      !independentPatternIntegrationFiles.has(name)
    ).sort()
  ) {
    const pinned = total === 4 ? FOUR_SHARD_ASSIGNMENTS[name] : undefined;
    assignment.set(name, pinned ?? (roundRobin++ % total) + 1);
  }
  return assignment;
}

// Select the files for one shard. `all.test.ts` is included in every shard (it
// shards its own pattern list internally); the remaining shard-managed files
// are assigned to exactly one shard each. Independently-run files are excluded
// here and covered by dedicated workflow jobs.
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

  if (files.includes(ALL_PATTERNS_FILE)) {
    selected.unshift(`./integration/${ALL_PATTERNS_FILE}`);
  }

  return selected;
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
