import { assertEquals } from "@std/assert";
import {
  initializeDb,
  parseDisabledPackageList,
  readWorkspaceMembers,
  runTests,
  selectShardMembers,
  testConcurrency,
  testPackage,
} from "./workspace-tests.ts";

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

Deno.test("selectShardMembers splits enabled members round-robin over the sorted name list", () => {
  const members = [
    "./packages/d",
    "./packages/b",
    "./packages/a",
    "./packages/c",
    "./tasks",
  ];
  assertEquals(
    unitNames(selectShardMembers(members, [], { index: 1, total: 2 })),
    ["a", "c", "tasks"],
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

  // Sorted units: a, cli (1/3), cli (2/3), cli (3/3), z — round-robin over
  // two shards interleaves the cli slices across both.
  assertEquals(selectShardMembers(members, [], { index: 1, total: 2 }), [
    { memberPath: "./packages/a", packageName: "a" },
    {
      memberPath: "./packages/cli",
      packageName: "cli (2/3)",
      env: { CLI_TEST_SHARD: "2/3" },
    },
    { memberPath: "./packages/z", packageName: "z" },
  ]);
  assertEquals(selectShardMembers(members, [], { index: 2, total: 2 }), [
    {
      memberPath: "./packages/cli",
      packageName: "cli (1/3)",
      env: { CLI_TEST_SHARD: "1/3" },
    },
    {
      memberPath: "./packages/cli",
      packageName: "cli (3/3)",
      env: { CLI_TEST_SHARD: "3/3" },
    },
  ]);
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

// Run `fn` with TEST_CONCURRENCY set (or cleared, on undefined), restoring
// the caller's value afterwards. The CI test job itself sets the variable, so
// tests must not read or leak the ambient value.
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
    // Sorted units: a, cli (1/3), cli (2/3), cli (3/3), z. Shard 1 of 2
    // selects a, cli (2/3), and z — exactly one cli slice, so the marker file
    // is written by a single task and carries that slice's environment.
    const passed = await runTests([], { index: 1, total: 2 }, dir);
    assertEquals(passed, true);
    const ran = await Deno.readTextFile(`${dir}/packages/cli/ran.txt`);
    assertEquals(ran.trim(), "shard=2/3");
    assertEquals(await ranPackages(dir, ["a", "z"]), ["a", "z"]);
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
    await initializeDb(dir);
    await Deno.stat(`${dir}/initialized.txt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
