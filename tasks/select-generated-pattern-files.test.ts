import { assertEquals } from "@std/assert";
import {
  parseShard,
  selectGeneratedPatternFiles,
} from "./select-generated-pattern-files.ts";

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
