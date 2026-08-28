import { assertEquals, assertThrows } from "@std/assert";
import {
  acceptsJUnitPath,
  assertTaskTestsIncluded,
  initializeDb,
  junitCapableMembers,
  memberTestTask,
  parseDisabledPackageList,
  readWorkspaceMembers,
  runTests,
  selectShardMembers,
  testConcurrency,
  testPackage,
} from "./workspace-tests.ts";
import { WORKSPACE_TEST_WEIGHTS } from "./test-timing-weights.ts";

const WORKSPACE_SHARDS = 8;
const CLI_SHARDS = 10;

// Write a minimal workspace under `dir`: a root deno.jsonc listing the
// members, and one directory per package whose `test` task records that it
// ran by writing a marker file into the package directory.
async function makeWorkspace(
  dir: string,
  packageNames: string[],
  rootTasks: Record<string, string> = {},
): Promise<void> {
  await Deno.writeTextFile(
    `${dir}/deno.jsonc`,
    JSON.stringify({
      workspace: packageNames.map((name) => `./packages/${name}`),
      tasks: rootTasks,
    }),
  );
  for (const name of packageNames) {
    await Deno.mkdir(`${dir}/packages/${name}`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/packages/${name}/deno.jsonc`,
      JSON.stringify({ tasks: { test: "echo ok > ran.txt" } }),
    );
  }
}

async function ranPackages(
  dir: string,
  packageNames: string[],
): Promise<string[]> {
  const ran: string[] = [];
  for (const name of packageNames) {
    try {
      await Deno.stat(`${dir}/packages/${name}/ran.txt`);
      ran.push(name);
    } catch {
      // no marker: the package's test task did not run
    }
  }
  return ran;
}

Deno.test("parseDisabledPackageList parses comma and whitespace separated names", () => {
  assertEquals(parseDisabledPackageList("runner, ui\nshell\tcli"), [
    "runner",
    "ui",
    "shell",
    "cli",
  ]);
});

Deno.test("parseDisabledPackageList ignores empty entries", () => {
  assertEquals(parseDisabledPackageList(" runner, ,ui "), ["runner", "ui"]);
  assertEquals(parseDisabledPackageList(undefined), []);
});

function unitNames(units: { packageName: string }[]): string[] {
  return units.map((unit) => unit.packageName);
}

Deno.test("selectShardMembers returns every enabled member without a shard", () => {
  assertEquals(
    selectShardMembers(
      ["./packages/b", "./packages/a", "./tasks"],
      ["a"],
      undefined,
    ),
    [
      { memberPath: "./packages/b", packageName: "b" },
      { memberPath: "./tasks", packageName: "tasks" },
    ],
  );
});

Deno.test("selectShardMembers balances enabled members by weight", () => {
  const members = [
    "./packages/d",
    "./packages/b",
    "./packages/a",
    "./packages/c",
    "./packages/e",
  ];
  assertEquals(
    unitNames(selectShardMembers(members, [], { index: 1, total: 2 })),
    ["a", "c", "e"],
  );
  assertEquals(
    unitNames(selectShardMembers(members, [], { index: 2, total: 2 })),
    ["b", "d"],
  );
});

Deno.test("selectShardMembers excludes disabled members before assigning shards", () => {
  const members = ["./packages/a", "./packages/b", "./packages/c"];
  assertEquals(
    unitNames(selectShardMembers(members, ["a"], { index: 1, total: 2 })),
    ["b"],
  );
  assertEquals(
    unitNames(selectShardMembers(members, ["a"], { index: 2, total: 2 })),
    ["c"],
  );
});

Deno.test("selectShardMembers expands the cli package into internal shards when sharded", () => {
  const members = ["./packages/a", "./packages/cli", "./packages/z"];

  // Without a workspace shard, cli stays a single unit with no shard env.
  assertEquals(selectShardMembers(members, [], undefined), [
    { memberPath: "./packages/a", packageName: "a" },
    { memberPath: "./packages/cli", packageName: "cli" },
    { memberPath: "./packages/z", packageName: "z" },
  ]);

  const selections = Array.from(
    { length: WORKSPACE_SHARDS },
    (_, offset) =>
      selectShardMembers(members, [], {
        index: offset + 1,
        total: WORKSPACE_SHARDS,
      }),
  );
  const units = selections.flat();
  const cliUnits = units.filter((unit) => unit.packageName.startsWith("cli "))
    .toSorted((a, b) => {
      const slice = (name: string) => Number(name.match(/\((\d+)\//)?.[1]);
      return slice(a.packageName) - slice(b.packageName);
    });
  assertEquals(
    cliUnits,
    Array.from({ length: CLI_SHARDS }, (_, offset) => ({
      memberPath: "./packages/cli",
      packageName: `cli (${offset + 1}/${CLI_SHARDS})`,
      env: { CLI_TEST_SHARD: `${offset + 1}/${CLI_SHARDS}` },
    })),
  );
  assertEquals(unitNames(units).filter((name) => name === "a"), ["a"]);
  assertEquals(unitNames(units).filter((name) => name === "z"), ["z"]);
});

Deno.test("selectShardMembers expands piece and tasks into internal shards", () => {
  const members = ["./packages/piece", "./tasks"];
  const units = Array.from(
    { length: 3 },
    (_, offset) =>
      selectShardMembers(members, [], { index: offset + 1, total: 3 }),
  ).flat();

  assertEquals(
    unitNames(units).sort(),
    [
      "piece (1/3)",
      "piece (2/3)",
      "piece (3/3)",
      "tasks (1/3)",
      "tasks (2/3)",
      "tasks (3/3)",
    ],
  );
});

Deno.test("real workspace timing weights limit two-worker makespans", async () => {
  const expectedCliUnits = Array.from(
    { length: CLI_SHARDS },
    (_, offset) => `cli (${offset + 1}/${CLI_SHARDS})`,
  );
  const profiledCliUnits = Object.keys(WORKSPACE_TEST_WEIGHTS)
    .filter((name) => name.startsWith("cli ("))
    .toSorted((a, b) => {
      const slice = (name: string) => Number(name.match(/\((\d+)\//)?.[1]);
      return slice(a) - slice(b);
    });
  assertEquals(profiledCliUnits, expectedCliUnits);

  const members = await readWorkspaceMembers(
    new URL("../deno.jsonc", import.meta.url),
  );
  const makespans = Array.from(
    { length: WORKSPACE_SHARDS },
    (_, offset) => {
      const workerLoads = [0, 0];
      const units = selectShardMembers(members, ["runner"], {
        index: offset + 1,
        total: WORKSPACE_SHARDS,
      });
      for (const unit of units) {
        const worker = workerLoads[0] <= workerLoads[1] ? 0 : 1;
        workerLoads[worker] += WORKSPACE_TEST_WEIGHTS[unit.packageName] ?? 1;
      }
      return Math.max(...workerLoads);
    },
  );

  assertEquals(
    Math.max(...makespans) < 80,
    true,
    `modeled workspace two-worker makespans: ${makespans.join(", ")}`,
  );
});

Deno.test("readWorkspaceMembers reads the workspace list from a JSONC manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-members-" });
  try {
    const configPath = `${dir}/deno.jsonc`;
    // Comments must not break parsing — that is the whole point of the JSONC
    // parser here.
    await Deno.writeTextFile(
      configPath,
      `{
  // workspace packages
  "workspace": ["./packages/a", "./packages/b"]
}
`,
    );
    assertEquals(await readWorkspaceMembers(configPath), [
      "./packages/a",
      "./packages/b",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertTaskTestsIncluded requires tasks in the root workspace", () => {
  assertTaskTestsIncluded(["./packages/api", "./tasks"]);
  assertThrows(
    () => assertTaskTestsIncluded(["./packages/api"]),
    Error,
    "workspace must include tasks",
  );
});

// Run `fn` with TEST_CONCURRENCY set or cleared, then restore the caller's
// value. This keeps each test independent of the ambient environment.
async function withTestConcurrency<T>(
  value: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = Deno.env.get("TEST_CONCURRENCY");
  if (value === undefined) {
    Deno.env.delete("TEST_CONCURRENCY");
  } else {
    Deno.env.set("TEST_CONCURRENCY", value);
  }
  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      Deno.env.delete("TEST_CONCURRENCY");
    } else {
      Deno.env.set("TEST_CONCURRENCY", saved);
    }
  }
}

Deno.test("testConcurrency parses the override and defaults to half the cores", async () => {
  assertEquals(testConcurrency("3"), 3);
  await withTestConcurrency(undefined, () => {
    assertEquals(
      testConcurrency(),
      Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)),
    );
  });
  let threw = false;
  try {
    testConcurrency("zero");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("runTests drains every package with a concurrency limit of one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-serialpool-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c"]);
    await withTestConcurrency("1", async () => {
      const passed = await runTests([], undefined, dir);
      assertEquals(passed, true);
    });
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a", "b", "c"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests reports a failure and stops scheduling packages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-fail-fast-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c"]);
    await Deno.writeTextFile(
      `${dir}/packages/a/deno.jsonc`,
      JSON.stringify({
        tasks: {
          test:
            "echo started > ran.txt && echo upstream package download failed >&2 && exit 1",
        },
      }),
    );

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    };
    let passed: boolean;
    try {
      passed = await withTestConcurrency(
        "1",
        () => runTests([], undefined, dir),
      );
    } finally {
      console.error = originalError;
    }

    assertEquals(passed, false);
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a"]);
    const downloadErrorIndex = errors.findIndex((message) =>
      message.includes("upstream package download failed")
    );
    const summaryIndex = errors.indexOf("One or more tests failed.");
    assertEquals(downloadErrorIndex >= 0, true);
    assertEquals(summaryIndex >= 0, true);
    assertEquals(downloadErrorIndex < summaryIndex, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests runs every enabled package's test task", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-run-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c"]);
    const passed = await runTests(["b"], undefined, dir);
    assertEquals(passed, true);
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a", "c"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests runs only the selected shard's packages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-shard-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c", "d"]);
    const passed = await runTests([], { index: 2, total: 2 }, dir);
    assertEquals(passed, true);
    assertEquals(await ranPackages(dir, ["a", "b", "c", "d"]), ["b", "d"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests passes internal shard environment to expanded packages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-clishard-" });
  try {
    await makeWorkspace(dir, ["a", "cli", "z"]);
    await Deno.writeTextFile(
      `${dir}/packages/cli/deno.jsonc`,
      JSON.stringify({
        tasks: { test: "echo shard=$CLI_TEST_SHARD > ran.txt" },
      }),
    );
    const shard = { index: 1, total: WORKSPACE_SHARDS };
    const expected = selectShardMembers(
      ["./packages/a", "./packages/cli", "./packages/z"],
      [],
      shard,
    ).find((unit) => unit.packageName.startsWith("cli "));
    const passed = await runTests([], shard, dir);
    assertEquals(passed, true);
    const ran = await Deno.readTextFile(`${dir}/packages/cli/ran.txt`);
    assertEquals(ran.trim(), `shard=${expected?.env?.CLI_TEST_SHARD}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("testPackage reports a failure when the package directory cannot be spawned in", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-nodir-" });
  try {
    const outcome = await testPackage(
      "./packages/missing",
      "missing",
      `${dir}/packages/missing`,
      undefined,
    );
    assertEquals(outcome.result.success, false);
    assertEquals(outcome.packageName, "missing");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("initializeDb runs the initialize-db task in the given directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-initdb-" });
  try {
    await makeWorkspace(dir, [], {
      "initialize-db": "echo ok > initialized.txt",
    });
    assertEquals(await initializeDb(dir), true);
    await Deno.stat(`${dir}/initialized.txt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("initializeDb returns false when the task fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-initdb-fail-" });
  try {
    await makeWorkspace(dir, [], {
      "initialize-db": "exit 3",
    });
    assertEquals(await initializeDb(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests reports a failure when every member is disabled", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-empty-" });
  try {
    await makeWorkspace(dir, ["a", "b"]);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    };
    let passed: boolean;
    try {
      passed = await runTests(["a", "b"], undefined, dir);
    } finally {
      console.error = originalError;
    }
    // A run that tested nothing is a misconfiguration, not a pass.
    assertEquals(passed, false);
    assertEquals(errors, ["No workspace packages selected to test."]);
    assertEquals(await ranPackages(dir, ["a", "b"]), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

//
// The runner reads each member's manifest to decide whether an appended
// --junit-path reaches its `deno test` whole, so an ordinary new package is
// covered without being named anywhere.
//

Deno.test("acceptsJUnitPath reads an ordinary test task", () => {
  assertEquals(acceptsJUnitPath("./packages/x", "deno test"), true);
  assertEquals(
    acceptsJUnitPath("./packages/x", "ENV=test deno test --no-check -A"),
    true,
  );
  assertEquals(acceptsJUnitPath("./packages/x", undefined), false);
  assertEquals(
    acceptsJUnitPath("./packages/x", "echo 'No tests defined.'"),
    false,
  );
});

Deno.test("acceptsJUnitPath refuses a task whose flag would land elsewhere", () => {
  // The appended flag reaches only the last command of a chain, which is
  // how a benchmark once received a --junit-path meant for the tests.
  assertEquals(
    acceptsJUnitPath("./packages/x", "deno test test/ && deno run -A perf.ts"),
    false,
  );
  assertEquals(
    acceptsJUnitPath("./packages/x", "deno test a/ ; deno test b/"),
    false,
  );
  assertEquals(
    acceptsJUnitPath("./packages/x", "deno test > results.txt"),
    false,
  );
});

Deno.test("acceptsJUnitPath takes a runner only when it is known to forward", () => {
  const runner = "deno run -A test/run-tests.ts";
  assertEquals(acceptsJUnitPath("./packages/piece", runner), true);
  assertEquals(acceptsJUnitPath("./tasks", runner), true);
  assertEquals(acceptsJUnitPath("./packages/cli", runner), false);
  assertEquals(acceptsJUnitPath("./packages/dashboard", runner), false);
});

Deno.test("memberTestTask accepts a directory path as well as a URL", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-manifest-root-" });
  try {
    await Deno.mkdir(`${dir}/packages/probe`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/packages/probe/deno.jsonc`,
      JSON.stringify({ tasks: { test: "deno test" } }),
    );
    // A plain path is the natural thing to pass, and reading through it
    // must find the manifest rather than quietly reporting none.
    assertEquals(await memberTestTask("./packages/probe", dir), "deno test");
    assertEquals(
      await memberTestTask("./packages/probe", new URL(`file://${dir}/`)),
      "deno test",
    );
    // Without the trailing slash a member resolves beside the directory
    // rather than inside it, which reads as a member with no manifest.
    assertEquals(
      await memberTestTask("./packages/probe", new URL(`file://${dir}`)),
      "deno test",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("memberTestTask reads deno.json ahead of deno.jsonc", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-manifest-order-" });
  try {
    await Deno.mkdir(`${dir}/packages/probe`, { recursive: true });
    // Deno resolves deno.json first, so that is the task that governs.
    await Deno.writeTextFile(
      `${dir}/packages/probe/deno.json`,
      JSON.stringify({ tasks: { test: "deno test" } }),
    );
    await Deno.writeTextFile(
      `${dir}/packages/probe/deno.jsonc`,
      JSON.stringify({ tasks: { test: "echo 'No tests defined.'" } }),
    );
    assertEquals(await memberTestTask("./packages/probe", dir), "deno test");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the workspace's capable members are read from their manifests", async () => {
  const rootUrl = new URL("../", import.meta.url);
  const members = await readWorkspaceMembers(new URL("deno.jsonc", rootUrl));
  const capable = await junitCapableMembers(members, rootUrl);

  // An ordinary package, a flag-forwarding runner, and a member whose task
  // ends in a `deno test`, all of which take the flag.
  for (
    const member of ["./packages/navigation", "./tasks", "./packages/runner"]
  ) {
    assertEquals(capable.has(member), true, `${member} should take the flag`);
  }
  // A chained task, a runner that runs several test commands, and a
  // browser harness, none of which do.
  for (
    const member of ["./packages/api", "./packages/cli", "./packages/dashboard"]
  ) {
    assertEquals(capable.has(member), false, `${member} should not`);
  }
});
