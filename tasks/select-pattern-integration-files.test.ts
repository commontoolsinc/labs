import { assertEquals } from "@std/assert";
import {
  assignPatternIntegrationShards,
  INDEPENDENT_PATTERN_INTEGRATION_FILES,
  listPatternIntegrationTests,
  selectPatternIntegrationFiles,
} from "./select-pattern-integration-files.ts";
import { parseShard } from "./shard-utils.ts";

const TOTAL_SHARDS = 4;
const ALL_PATTERNS_FILE = "all.test.ts";

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

Deno.test("pattern integration four-way shard keeps the heaviest tests apart", () => {
  const heavy = [
    "parking-coordinator-admin-view.test.ts",
    "cfc-group-chat-demo-two-browsers.test.ts",
    "cfc-spec-gallery.test.ts",
    "cfc-group-chat-demo.test.ts",
  ];
  const assignment = assignPatternIntegrationShards(heavy, TOTAL_SHARDS);
  const shardOf = (file: string) => assignment.get(file);

  // The two group-chat browser tests are the heaviest end-to-end tests on CI
  // (~41s for two-browsers, ~29s for the single-browser one). They must not
  // share a shard, or that shard carries ~70s of group-chat work alone.
  assertEquals(
    shardOf("cfc-group-chat-demo-two-browsers.test.ts") !==
      shardOf("cfc-group-chat-demo.test.ts"),
    true,
    "the two group-chat browser tests must be on different shards",
  );

  // The three heaviest single files land on distinct shards.
  const top = [
    "parking-coordinator-admin-view.test.ts",
    "cfc-group-chat-demo-two-browsers.test.ts",
    "cfc-spec-gallery.test.ts",
  ].map(shardOf);
  assertEquals(
    new Set(top).size,
    3,
    "the three heaviest tests should be on distinct shards",
  );
});

Deno.test("all.test.ts runs in every shard", () => {
  const files = [
    "all.test.ts",
    "counter.test.ts",
    "default-app.test.ts",
    "parking-coordinator-admin-view.test.ts",
  ];
  for (let index = 1; index <= 4; index++) {
    const selected = selectPatternIntegrationFiles(files, { index, total: 4 });
    assertEquals(
      selected.includes("./integration/all.test.ts"),
      true,
      `shard ${index} should include all.test.ts`,
    );
  }
});

Deno.test("every non-all file is assigned to exactly one shard", () => {
  const files = [
    "all.test.ts",
    "parking-coordinator-admin-view.test.ts",
    "lunch-poll-contention.test.ts",
    "cfc-spec-gallery.test.ts",
    "default-app.test.ts",
    "cfc-group-chat-demo.test.ts",
    "counter.test.ts",
    "new-unmapped-file.test.ts",
  ];
  const counts = new Map<string, number>();
  for (let index = 1; index <= 4; index++) {
    const selected = selectPatternIntegrationFiles(files, { index, total: 4 });
    for (const path of selected) {
      if (path === "./integration/all.test.ts") continue;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  for (const file of files) {
    if (
      file === "all.test.ts" ||
      INDEPENDENT_PATTERN_INTEGRATION_FILES.includes(
        file as typeof INDEPENDENT_PATTERN_INTEGRATION_FILES[number],
      )
    ) {
      continue;
    }
    assertEquals(
      counts.get(`./integration/${file}`),
      1,
      `${file} should appear on exactly one shard`,
    );
  }
  for (const file of INDEPENDENT_PATTERN_INTEGRATION_FILES) {
    assertEquals(
      counts.has(`./integration/${file}`),
      false,
      `${file} should be excluded from normal shards`,
    );
  }
});

Deno.test("independent pattern integration files are not selected by shards", () => {
  const files = [
    "all.test.ts",
    "counter.test.ts",
    ...INDEPENDENT_PATTERN_INTEGRATION_FILES,
  ];

  for (let index = 1; index <= TOTAL_SHARDS; index++) {
    const selected = selectPatternIntegrationFiles(files, {
      index,
      total: TOTAL_SHARDS,
    });
    for (const file of INDEPENDENT_PATTERN_INTEGRATION_FILES) {
      assertEquals(
        selected.includes(`./integration/${file}`),
        false,
        `${file} should not run in shard ${index}`,
      );
    }
  }
});

Deno.test("every real integration file is covered exactly once across shards", async () => {
  // Read the actual integration directory so a file that silently falls out of
  // every shard fails here — CI itself would run green, because a dropped file
  // is simply never executed.
  const files = await listPatternIntegrationTests();

  // Guard against the test passing vacuously if the listing breaks.
  assertEquals(
    files.includes(ALL_PATTERNS_FILE),
    true,
    `expected ${ALL_PATTERNS_FILE} in the integration directory`,
  );

  const shardOf = new Map<string, number[]>();
  for (let index = 1; index <= TOTAL_SHARDS; index++) {
    const selected = selectPatternIntegrationFiles(files, {
      index,
      total: TOTAL_SHARDS,
    });
    for (const path of selected) {
      const name = path.replace("./integration/", "");
      const shards = shardOf.get(name) ?? [];
      shards.push(index);
      shardOf.set(name, shards);
    }
  }

  for (const name of files) {
    const shards = shardOf.get(name) ?? [];
    if (name === ALL_PATTERNS_FILE) {
      assertEquals(
        shards,
        [1, 2, 3, 4],
        `${name} should run in every shard`,
      );
    } else if (
      INDEPENDENT_PATTERN_INTEGRATION_FILES.includes(
        name as typeof INDEPENDENT_PATTERN_INTEGRATION_FILES[number],
      )
    ) {
      assertEquals(
        shards.length,
        0,
        `${name} should run in its dedicated workflow job, not normal shards`,
      );
    } else {
      assertEquals(
        shards.length,
        1,
        `${name} should run in exactly one shard, got ${
          JSON.stringify(shards)
        }`,
      );
    }
  }

  // No phantom files: everything selected corresponds to a real file.
  for (const name of shardOf.keys()) {
    assertEquals(
      files.includes(name),
      true,
      `selected ${name} is not a real integration file`,
    );
  }
});

Deno.test("unlisted pattern integration files round-robin over the unlisted set", () => {
  // Files not in the table are distributed round-robin, so two unlisted files
  // land on consecutive shards rather than colliding.
  const files = ["all.test.ts", "new-a.test.ts", "new-b.test.ts"];
  const assignment = assignPatternIntegrationShards(files, TOTAL_SHARDS);
  assertEquals(assignment.get("new-a.test.ts"), 1);
  assertEquals(assignment.get("new-b.test.ts"), 2);
});
