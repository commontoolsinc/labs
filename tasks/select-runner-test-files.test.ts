import { assertEquals } from "@std/assert";
import {
  parseShard,
  selectRunnerTestFiles,
} from "./select-runner-test-files.ts";

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

Deno.test("selectRunnerTestFiles balances by estimated file weight", () => {
  const files = [
    { name: "large.test.ts", size: 100 },
    { name: "medium.test.ts", size: 60 },
    { name: "small-a.test.ts", size: 20 },
    { name: "small-b.test.ts", size: 20 },
  ];

  assertEquals(selectRunnerTestFiles(files, { index: 1, total: 2 }), [
    "large.test.ts",
  ]);
  assertEquals(selectRunnerTestFiles(files, { index: 2, total: 2 }), [
    "medium.test.ts",
    "small-a.test.ts",
    "small-b.test.ts",
  ]);
});

Deno.test("selectRunnerTestFiles honors explicit weights for slow small files", () => {
  const files = [
    { name: "large.test.ts", size: 100 },
    { name: "slow-small.test.ts", size: 10, weight: 90 },
    { name: "medium.test.ts", size: 50 },
    { name: "small.test.ts", size: 40 },
  ];

  assertEquals(selectRunnerTestFiles(files, { index: 1, total: 2 }), [
    "large.test.ts",
    "small.test.ts",
  ]);
  assertEquals(selectRunnerTestFiles(files, { index: 2, total: 2 }), [
    "medium.test.ts",
    "slow-small.test.ts",
  ]);
});

Deno.test("selectRunnerTestFiles spreads slow runner anchors across four shards", () => {
  const files = [
    { name: "engine.test.ts", size: 50_000 },
    { name: "piece-helpers.test.ts", size: 4_000 },
    { name: "json-utils.test.ts", size: 27_000 },
    { name: "reactive-dependencies.test.ts", size: 68_000 },
    { name: "pattern-manager.test.ts", size: 17_000 },
    { name: "runner.test.ts", size: 56_000 },
    { name: "wish.test.ts", size: 95_000 },
    { name: "pattern-scope.test.ts", size: 72_000 },
    { name: "small-a.test.ts", size: 20_000 },
    { name: "small-b.test.ts", size: 20_000 },
    { name: "small-c.test.ts", size: 20_000 },
    { name: "small-d.test.ts", size: 20_000 },
  ];

  const shards = [1, 2, 3, 4].map((index) =>
    selectRunnerTestFiles(files, { index, total: 4 })
  );

  assertEquals(shards[0].includes("engine.test.ts"), true);
  assertEquals(shards[1].includes("piece-helpers.test.ts"), true);
  assertEquals(shards[2].includes("json-utils.test.ts"), true);
  assertEquals(shards[3].includes("reactive-dependencies.test.ts"), true);
  assertEquals(
    shards.some((shard) =>
      shard.includes("piece-helpers.test.ts") &&
      shard.includes("json-utils.test.ts")
    ),
    false,
  );
});
