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

Deno.test("selectRunnerTestFiles balances by file size", () => {
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
