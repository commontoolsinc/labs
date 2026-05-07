import { assertEquals } from "@std/assert";
import {
  parseShard,
  shardForPatternIntegrationFile,
  stableShardForName,
} from "./select-pattern-integration-files.ts";

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

Deno.test("pattern integration four-way shard keeps slow files balanced", () => {
  assertEquals(shardForPatternIntegrationFile("all.test.ts", 4), 1);
  assertEquals(
    shardForPatternIntegrationFile("cfc-spec-gallery.test.ts", 4),
    2,
  );
  assertEquals(
    shardForPatternIntegrationFile("cfc-authorized-save.test.ts", 4),
    3,
  );
  assertEquals(shardForPatternIntegrationFile("nested-counter.test.ts", 4), 4);
});

Deno.test("unknown pattern integration files are assigned deterministically", () => {
  assertEquals(
    shardForPatternIntegrationFile("new-test-file.test.ts", 4),
    stableShardForName("new-test-file.test.ts", 4),
  );
});
