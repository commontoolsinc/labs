#!/usr/bin/env -S deno run --allow-read

type Shard = {
  index: number;
  total: number;
};

type RunnerTestFile = {
  name: string;
  size: number;
  weight?: number;
};

const RUNNER_TEST_WEIGHT_OVERRIDES: Record<string, number> = {
  // This file is much slower than its byte size suggests because it compiles
  // and evaluates many SES modules. Keep it as a heavy shard anchor.
  "engine.test.ts": 700_000,
  // These files are small-to-medium on disk but dominate CI wall time. Keep
  // them separated so one runner shard does not become the long pole.
  "piece-helpers.test.ts": 320_000,
  "json-utils.test.ts": 210_000,
  "reactive-dependencies.test.ts": 180_000,
  "pattern-manager.test.ts": 145_000,
  "runner.test.ts": 100_000,
  "memory-v2-watch-refresh-race.test.ts": 95_000,
  "wish.test.ts": 95_000,
  "data-updating.test.ts": 80_000,
  "navigate-handler.test.ts": 80_000,
  "scheduler-ordering.test.ts": 80_000,
  "pattern-scope.test.ts": 75_000,
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

export function selectRunnerTestFiles(
  files: RunnerTestFile[],
  shard: Shard,
): string[] {
  const buckets = Array.from({ length: shard.total }, () => ({
    weight: 0,
    names: [] as string[],
  }));

  for (
    const file of [...files].sort((a, b) =>
      runnerTestWeight(b) - runnerTestWeight(a) ||
      a.name.localeCompare(b.name)
    )
  ) {
    const bucket = buckets.reduce((smallest, candidate) =>
      candidate.weight < smallest.weight ? candidate : smallest
    );
    bucket.weight += runnerTestWeight(file);
    bucket.names.push(file.name);
  }

  return buckets[shard.index - 1].names.sort();
}

function runnerTestWeight(file: RunnerTestFile): number {
  return file.weight ?? RUNNER_TEST_WEIGHT_OVERRIDES[file.name] ?? file.size;
}

async function listRunnerTests(): Promise<RunnerTestFile[]> {
  const testDir = new URL("../packages/runner/test/", import.meta.url);
  const files: RunnerTestFile[] = [];

  for await (const entry of Deno.readDir(testDir)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      const info = await Deno.stat(new URL(entry.name, testDir));
      files.push({ name: entry.name, size: info.size });
    }
  }

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
