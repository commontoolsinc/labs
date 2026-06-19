import { assertEquals } from "@std/assert";
import {
  listGeneratedPatternTests,
  parseShard,
  selectGeneratedPatternFiles,
} from "./select-generated-pattern-files.ts";

const TOTAL_SHARDS = 4;

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

Deno.test("selectGeneratedPatternFiles round-robins sorted names", () => {
  const files = [
    "delta.test.ts",
    "alpha.test.ts",
    "echo.test.ts",
    "bravo.test.ts",
    "charlie.test.ts",
  ];

  assertEquals(selectGeneratedPatternFiles(files, { index: 1, total: 2 }), [
    "alpha.test.ts",
    "charlie.test.ts",
    "echo.test.ts",
  ]);
  assertEquals(selectGeneratedPatternFiles(files, { index: 2, total: 2 }), [
    "bravo.test.ts",
    "delta.test.ts",
  ]);
});

Deno.test("every real generated pattern file is covered exactly once across shards", async () => {
  // Read the actual generated-patterns directory so a file that silently falls
  // out of every shard fails here — CI itself would run green, because a
  // dropped file is simply never executed.
  const files = await listGeneratedPatternTests();

  // Guard against the test passing vacuously if the listing breaks.
  assertEquals(
    files.length > 0,
    true,
    "expected generated pattern files to exist",
  );

  const shardOf = new Map<string, number[]>();
  for (let index = 1; index <= TOTAL_SHARDS; index++) {
    for (
      const name of selectGeneratedPatternFiles(files, {
        index,
        total: TOTAL_SHARDS,
      })
    ) {
      const shards = shardOf.get(name) ?? [];
      shards.push(index);
      shardOf.set(name, shards);
    }
  }

  for (const name of files) {
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
      files.includes(name),
      true,
      `selected ${name} is not a real generated pattern file`,
    );
  }
});
