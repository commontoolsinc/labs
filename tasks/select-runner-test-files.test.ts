import { assertEquals } from "@std/assert";
import {
  listRunnerTests,
  selectRunnerTestFiles,
} from "./select-runner-test-files.ts";
import { parseShard } from "./shard-utils.ts";

const TOTAL_SHARDS = 5;

Deno.test("parseShard parses shard notation", () => {
  assertEquals(parseShard("2/5"), { index: 2, total: 5 });
});

Deno.test("parseShard rejects invalid shard notation", () => {
  try {
    parseShard("6/5");
    throw new Error("expected parseShard to throw");
  } catch (error) {
    assertEquals(
      (error as Error).message,
      "Shard index 6 exceeds total shard count 5",
    );
  }
});

Deno.test("runner test round-robin keeps shard counts even", () => {
  const files = Array.from({ length: 30 }, (_, i) => ({
    name: `t${String(i).padStart(2, "0")}.test.ts`,
  }));
  const counts = [1, 2, 3, 4, 5].map((index) =>
    selectRunnerTestFiles(files, { index, total: TOTAL_SHARDS }).length
  );
  assertEquals(
    Math.max(...counts) - Math.min(...counts) <= 1,
    true,
    `${counts}`,
  );
});

Deno.test("every real runner test file is covered exactly once across shards", async () => {
  // Read the actual runner test directory so a file that silently falls out of
  // every shard fails here — CI itself would run green, because a dropped file
  // is simply never executed.
  const files = await listRunnerTests();
  const names = files.map((file) => file.name);

  // Guard against the test passing vacuously if the listing breaks.
  assertEquals(names.length > 0, true, "expected runner test files to exist");

  const shardOf = new Map<string, number[]>();
  for (let index = 1; index <= TOTAL_SHARDS; index++) {
    for (
      const name of selectRunnerTestFiles(files, { index, total: TOTAL_SHARDS })
    ) {
      const shards = shardOf.get(name) ?? [];
      shards.push(index);
      shardOf.set(name, shards);
    }
  }

  for (const name of names) {
    const shards = shardOf.get(name) ?? [];
    assertEquals(
      shards.length,
      1,
      `${name} should run in exactly one shard, got ${JSON.stringify(shards)}`,
    );
  }

  // No phantom files: everything selected corresponds to a real file.
  for (const name of shardOf.keys()) {
    assertEquals(
      names.includes(name),
      true,
      `selected ${name} is not a real runner test file`,
    );
  }
});
