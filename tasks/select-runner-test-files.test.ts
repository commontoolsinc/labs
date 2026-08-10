import { assertEquals } from "@std/assert";
import {
  listRunnerTests,
  selectRunnerTestFiles,
} from "./select-runner-test-files.ts";
import { parseShard } from "./shard-utils.ts";
import { RUNNER_TEST_WEIGHTS } from "./test-timing-weights.ts";

const TOTAL_SHARDS = 10;

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

Deno.test("runner test weighting spreads expensive files across shards", () => {
  const files = ["a", "b", "c", "d", "e", "f"].map((name) => ({
    name: `${name}.test.ts`,
  }));
  const weights = Object.fromEntries(
    files.map((file, index) => [file.name, 6 - index]),
  );
  const loads = [1, 2, 3].map((index) =>
    selectRunnerTestFiles(files, { index, total: 3 }, weights)
      .reduce((sum, name) => sum + weights[name], 0)
  );
  assertEquals(loads, [7, 7, 7]);
});

Deno.test("real runner timing weights keep modeled shard loads close", async () => {
  const files = await listRunnerTests();
  const loads = Array.from(
    { length: TOTAL_SHARDS },
    (_, offset) =>
      selectRunnerTestFiles(files, {
        index: offset + 1,
        total: TOTAL_SHARDS,
      }).reduce((sum, name) => sum + (RUNNER_TEST_WEIGHTS[name] ?? 1), 0),
  );
  assertEquals(
    Math.max(...loads) - Math.min(...loads) < 2,
    true,
    `modeled runner shard loads: ${loads.join(", ")}`,
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

  for (const name of Object.keys(RUNNER_TEST_WEIGHTS)) {
    assertEquals(
      names.includes(name),
      true,
      `profiled ${name} is not a real runner test file`,
    );
  }
});
