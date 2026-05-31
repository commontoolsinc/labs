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
  // The heaviest end-to-end tests are spread one per shard so no shard
  // dominates: group-chat (shard 2), parking-coordinator (shard 3), and
  // spec-gallery (shard 4); `all` runs alone on shard 1.
  assertEquals(shardForPatternIntegrationFile("all.test.ts", 4), 1);
  assertEquals(
    shardForPatternIntegrationFile("cfc-group-chat-demo.test.ts", 4),
    2,
  );
  assertEquals(
    shardForPatternIntegrationFile("parking-coordinator-admin-view.test.ts", 4),
    3,
  );
  assertEquals(
    shardForPatternIntegrationFile("cfc-spec-gallery.test.ts", 4),
    4,
  );
});

Deno.test("unknown pattern integration files are assigned deterministically", () => {
  assertEquals(
    shardForPatternIntegrationFile("new-test-file.test.ts", 4),
    stableShardForName("new-test-file.test.ts", 4),
  );
});
