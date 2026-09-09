import { assertEquals, assertThrows } from "@std/assert";
import {
  assignPatternIntegrationShards,
  INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES,
  listPatternIntegrationTests,
  PATTERN_INTEGRATION_DISTINCT_WEIGHT_MINIMUM,
  PATTERN_INTEGRATION_INITIAL_SHARD_LOADS,
  PATTERN_INTEGRATION_SHARD_COUNT,
  PATTERN_INTEGRATION_TEST_WEIGHTS,
  selectPatternIntegrationFiles,
} from "./select-pattern-integration-files.ts";
import {
  parsePatternIntegrationShard,
  selectPatternIntegrationShard,
} from "../packages/patterns/integration/pattern-integration-shard.ts";

const TOTAL_SHARDS = PATTERN_INTEGRATION_SHARD_COUNT;
const INTERNALLY_SHARDED_FILE_NAMES = new Set<string>(
  INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES,
);

Deno.test("pattern integration shard defaults local runs to every item", () => {
  const shard = parsePatternIntegrationShard(undefined);
  assertEquals(shard, { index: 1, total: 1 });
  assertEquals(selectPatternIntegrationShard(["a", "b", "c"], shard), [
    "a",
    "b",
    "c",
  ]);
  assertEquals(
    selectPatternIntegrationShard(["a", "b", "c"], shard, () => 4),
    ["a", "b", "c"],
  );
});

Deno.test("pattern integration shard rejects an explicitly empty setting", () => {
  assertThrows(
    () => parsePatternIntegrationShard(""),
    Error,
    'Invalid PATTERN_INTEGRATION_SHARD ""',
  );
});

Deno.test("pattern integration shard divides items exactly once", () => {
  const total = 4;
  const items = ["a", "b", "c", "d", "e", "f", "g"];
  const selections = Array.from(
    { length: total },
    (_, index) =>
      selectPatternIntegrationShard(
        items,
        parsePatternIntegrationShard(`${index + 1}/${total}`),
      ),
  );
  assertEquals(selections, [
    ["a", "e"],
    ["b", "f"],
    ["c", "g"],
    ["d"],
  ]);
  assertEquals(selections.flat().sort(), items);
});

Deno.test("pattern integration shard moves only assigned items", () => {
  const total = 4;
  const items = ["a", "b", "c", "d", "e", "f", "g"];
  const assignments: Readonly<Record<string, number>> = { b: 3 };
  const selections = Array.from(
    { length: total },
    (_, index) =>
      selectPatternIntegrationShard(
        items,
        parsePatternIntegrationShard(`${index + 1}/${total}`),
        (item) => assignments[item],
      ),
  );
  assertEquals(selections, [
    ["a", "e"],
    ["f"],
    ["b", "c", "g"],
    ["d"],
  ]);
  assertEquals(selections.flat().sort(), items);
});

Deno.test("pattern integration shard rejects invalid notation", () => {
  for (const raw of ["0/4", "1/0", "5/4", "2", "2/4/6"]) {
    try {
      parsePatternIntegrationShard(raw);
      throw new Error(`expected ${raw} to be rejected`);
    } catch (error) {
      assertEquals(
        (error as Error).message.startsWith(
          `Invalid PATTERN_INTEGRATION_SHARD "${raw}"`,
        ) ||
          (error as Error).message ===
            `PATTERN_INTEGRATION_SHARD "${raw}" out of range.`,
        true,
      );
    }
  }
});

Deno.test("pattern integration shard rejects unsafe integer values", () => {
  assertEquals(
    parsePatternIntegrationShard("9007199254740991/9007199254740991"),
    {
      index: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
    },
  );
  const enormous = "9".repeat(400);
  for (
    const raw of [
      "1/9007199254740992",
      "9007199254740992/9007199254740992",
      "9007199254740993/9007199254740992",
      `${enormous}/${enormous}`,
    ]
  ) {
    assertThrows(
      () => parsePatternIntegrationShard(raw),
      Error,
      "shard values must be safe integers",
    );
  }
});

Deno.test("pattern integration assignments reject other shard counts", () => {
  for (const total of [TOTAL_SHARDS - 1, TOTAL_SHARDS + 1]) {
    assertThrows(
      () => assignPatternIntegrationShards([], total),
      Error,
      `require ${TOTAL_SHARDS} shards`,
    );
  }
});

Deno.test("pattern integration weights name real files", async () => {
  const files = new Set(await listPatternIntegrationTests());
  for (const name of Object.keys(PATTERN_INTEGRATION_TEST_WEIGHTS)) {
    assertEquals(
      files.has(name),
      true,
      `weight ${name} should name a real integration test`,
    );
  }
});

Deno.test("pattern integration assignments separate expensive files", async () => {
  const expensiveFiles = [
    "cf-code-editor.test.ts",
    "lunch-poll-vote.test.ts",
    "parking-coordinator-admin-view.test.ts",
    "home-profile.test.ts",
    "cfc-group-chat-demo-two-browsers.test.ts",
  ];
  for (const name of expensiveFiles) {
    assertEquals(
      (PATTERN_INTEGRATION_TEST_WEIGHTS[name] ?? 0) >=
        PATTERN_INTEGRATION_DISTINCT_WEIGHT_MINIMUM,
      true,
      `${name} should remain in the distinct-shard weight group`,
    );
  }
  const assignments = assignPatternIntegrationShards(
    await listPatternIntegrationTests(),
    TOTAL_SHARDS,
  );
  const assignedShards = expensiveFiles.map((name) => assignments.get(name));

  assertEquals(
    assignedShards.every((shard) => shard !== undefined),
    true,
    "every expensive file should have an assignment",
  );
  assertEquals(
    new Set(assignedShards).size,
    expensiveFiles.length,
    "expensive files should run in distinct shards",
  );
});

Deno.test("pattern integration weights stay within the internal-work floor", async () => {
  const files = await listPatternIntegrationTests();
  const assignments = assignPatternIntegrationShards(
    files,
    TOTAL_SHARDS,
  );
  const loads = [...PATTERN_INTEGRATION_INITIAL_SHARD_LOADS];
  for (const name of files) {
    if (INTERNALLY_SHARDED_FILE_NAMES.has(name)) continue;
    const shard = assignments.get(name);
    if (shard === undefined) throw new Error(`No assignment for ${name}.`);
    loads[shard - 1] += PATTERN_INTEGRATION_TEST_WEIGHTS[name] ?? 1;
  }

  assertEquals(
    Math.max(...loads),
    Math.max(...PATTERN_INTEGRATION_INITIAL_SHARD_LOADS),
    `modeled pattern integration shard loads: ${loads.join(", ")}`,
  );
});

Deno.test("internally sharded files run in every shard", () => {
  const files = [
    ...INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES,
    "counter.test.ts",
    "default-app.test.ts",
    "parking-coordinator-admin-view.test.ts",
  ];
  for (let index = 1; index <= TOTAL_SHARDS; index++) {
    const selected = selectPatternIntegrationFiles(files, {
      index,
      total: TOTAL_SHARDS,
    });
    for (const name of INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES) {
      assertEquals(
        selected.includes(`./integration/${name}`),
        true,
        `shard ${index} should include ${name}`,
      );
    }
  }
});

Deno.test("every file without internal sharding is assigned to one shard", () => {
  const files = [
    ...INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES,
    "parking-coordinator-admin-view.test.ts",
    "cfc-spec-gallery.test.ts",
    "default-app.test.ts",
    "cfc-group-chat-demo.test.ts",
    "counter.test.ts",
    "new-unmapped-file.test.ts",
  ];
  const counts = new Map<string, number>();
  for (let index = 1; index <= TOTAL_SHARDS; index++) {
    const selected = selectPatternIntegrationFiles(files, {
      index,
      total: TOTAL_SHARDS,
    });
    for (const path of selected) {
      const name = path.replace("./integration/", "");
      if (INTERNALLY_SHARDED_FILE_NAMES.has(name)) continue;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  for (const file of files) {
    if (INTERNALLY_SHARDED_FILE_NAMES.has(file)) continue;
    assertEquals(
      counts.get(`./integration/${file}`),
      1,
      `${file} should appear on exactly one shard`,
    );
  }
});

Deno.test("every real integration file follows its sharding contract", async () => {
  // Read the actual integration directory so a file that silently falls out of
  // every shard fails here — CI itself would run green, because a dropped file
  // is simply never executed.
  const files = await listPatternIntegrationTests();

  // Guard against the test passing vacuously if the listing breaks.
  for (const name of INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES) {
    assertEquals(
      files.includes(name),
      true,
      `expected ${name} in the integration directory`,
    );
  }

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
    if (INTERNALLY_SHARDED_FILE_NAMES.has(name)) {
      assertEquals(
        shards,
        Array.from({ length: TOTAL_SHARDS }, (_, index) => index + 1),
        `${name} should run in every shard`,
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
