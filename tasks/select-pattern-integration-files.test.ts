import { assertEquals, assertThrows } from "@std/assert";
import {
  assignPatternIntegrationShards,
  INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES,
  listPatternIntegrationTests,
  selectPatternIntegrationFiles,
} from "./select-pattern-integration-files.ts";
import { parseShard } from "./shard-utils.ts";
import {
  parsePatternIntegrationShard,
  selectPatternIntegrationShard,
} from "../packages/patterns/integration/pattern-integration-shard.ts";

const TOTAL_SHARDS = 4;
const INTERNALLY_SHARDED_FILE_NAMES = new Set<string>(
  INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES,
);

Deno.test("parseShard parses shard notation", () => {
  assertEquals(parseShard("2/4"), { index: 2, total: 4 });
  assertEquals(parseShard("9007199254740991/9007199254740991"), {
    index: Number.MAX_SAFE_INTEGER,
    total: Number.MAX_SAFE_INTEGER,
  });
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

Deno.test("parseShard rejects unsafe integer values", () => {
  const enormous = "9".repeat(400);
  for (
    const raw of [
      "1/9007199254740992",
      "9007199254740992/9007199254740992",
      "9007199254740993/9007199254740992",
      `${enormous}/${enormous}`,
    ]
  ) {
    assertThrows(() => parseShard(raw), Error, "safe integers");
  }
});

Deno.test("pattern integration shard defaults local runs to every item", () => {
  const shard = parsePatternIntegrationShard(undefined);
  assertEquals(shard, { index: 1, total: 1 });
  assertEquals(selectPatternIntegrationShard(["a", "b", "c"], shard), [
    "a",
    "b",
    "c",
  ]);
});

Deno.test("pattern integration shard rejects an explicitly empty setting", () => {
  assertThrows(
    () => parsePatternIntegrationShard(""),
    Error,
    'Invalid PATTERN_INTEGRATION_SHARD ""',
  );
});

Deno.test("pattern integration shard divides items exactly once", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g"];
  const selections = Array.from(
    { length: TOTAL_SHARDS },
    (_, index) =>
      selectPatternIntegrationShard(
        items,
        parsePatternIntegrationShard(`${index + 1}/${TOTAL_SHARDS}`),
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

Deno.test("internally sharded files run in every shard", () => {
  const files = [
    ...INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES,
    "counter.test.ts",
    "default-app.test.ts",
    "parking-coordinator-admin-view.test.ts",
  ];
  for (let index = 1; index <= 4; index++) {
    const selected = selectPatternIntegrationFiles(files, { index, total: 4 });
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
  for (let index = 1; index <= 4; index++) {
    const selected = selectPatternIntegrationFiles(files, { index, total: 4 });
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
        [1, 2, 3, 4],
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

Deno.test("unlisted pattern integration files round-robin over the unlisted set", () => {
  // Files not in the table are distributed round-robin, so two unlisted files
  // land on consecutive shards rather than colliding.
  const files = ["all.test.ts", "new-a.test.ts", "new-b.test.ts"];
  const assignment = assignPatternIntegrationShards(files, TOTAL_SHARDS);
  assertEquals(assignment.get("new-a.test.ts"), 1);
  assertEquals(assignment.get("new-b.test.ts"), 2);
});
