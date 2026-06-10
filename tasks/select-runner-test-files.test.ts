import { assertEquals } from "@std/assert";
import {
  selectRunnerTestFiles,
  shardForRunnerTestFile,
} from "./select-runner-test-files.ts";
import { parseShard, stableShardForName } from "./shard-utils.ts";

Deno.test("parseShard parses shard notation", () => {
  assertEquals(parseShard("2/4"), { index: 2, total: 4 });
});

Deno.test("parseShard rejects invalid shard notation", () => {
  try {
    parseShard("5/4");
    throw new Error("expected parseShard to throw");
  } catch (error) {
    assertEquals(
      (error as Error).message,
      "Shard index 5 exceeds total shard count 4",
    );
  }
});

Deno.test("runner test four-way shard keeps slow files balanced", () => {
  // The heaviest files are spread one per shard so no shard dominates.
  assertEquals(shardForRunnerTestFile("engine.test.ts", 4), 1);
  assertEquals(shardForRunnerTestFile("piece-helpers.test.ts", 4), 2);
  assertEquals(shardForRunnerTestFile("json-utils.test.ts", 4), 3);
  assertEquals(shardForRunnerTestFile("reactive-dependencies.test.ts", 4), 4);
});

Deno.test("runner test sharding is stable when files are added or removed", () => {
  const baseFiles = [
    { name: "engine.test.ts" },
    { name: "piece-helpers.test.ts" },
    { name: "json-utils.test.ts" },
    { name: "small-a.test.ts" },
    { name: "small-b.test.ts" },
  ];

  const before = [1, 2, 3, 4].map((index) =>
    selectRunnerTestFiles(baseFiles, { index, total: 4 })
  );

  // Adding a new file should not move any existing file between shards.
  const withNewFile = [
    ...baseFiles,
    { name: "new-feature.test.ts" },
  ];
  const after = [1, 2, 3, 4].map((index) =>
    selectRunnerTestFiles(withNewFile, { index, total: 4 })
  );

  for (const file of baseFiles) {
    const shardBefore = before.findIndex((s) => s.includes(file.name));
    const shardAfter = after.findIndex((s) => s.includes(file.name));
    assertEquals(
      shardBefore,
      shardAfter,
      `${file.name} moved from shard ${shardBefore + 1} to ${shardAfter + 1}`,
    );
  }
});

Deno.test("unknown runner test files are assigned deterministically", () => {
  assertEquals(
    shardForRunnerTestFile("new-test-file.test.ts", 4),
    stableShardForName("new-test-file.test.ts", 4),
  );
});
