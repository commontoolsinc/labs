import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  ALLOWLIST,
  importsPollingWaitFor,
  isIntegrationTestFile,
  main,
  scan,
} from "./check-no-waitfor.ts";

// Writes a single integration test file with the given contents into a fresh
// temp tree and returns its root. The caller removes the tree.
async function fixtureTree(
  fileName: string,
  contents: string,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-no-waitfor-" });
  const dir = join(root, "packages", "foo", "integration");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, fileName), contents);
  return root;
}

// Runs `body` with console.log and console.error captured, returning what each
// received. Restores the originals afterward.
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

Deno.test("importsPollingWaitFor detects a single-line named import", () => {
  assert(
    importsPollingWaitFor(
      'import { env, waitFor } from "@commonfabric/integration";',
    ),
  );
});

Deno.test("importsPollingWaitFor detects a multi-line named import", () => {
  const source = [
    "import {",
    "  env,",
    "  Page,",
    "  waitFor,",
    "  waitForCondition,",
    '} from "@commonfabric/integration";',
  ].join("\n");
  assert(importsPollingWaitFor(source));
});

Deno.test("importsPollingWaitFor detects an aliased import", () => {
  assert(
    importsPollingWaitFor(
      'import { waitFor as poll } from "@commonfabric/integration";',
    ),
  );
});

Deno.test("importsPollingWaitFor ignores waitFor-prefixed helpers", () => {
  assertEquals(
    importsPollingWaitFor(
      'import { waitForCondition, waitForText } from "@commonfabric/integration";',
    ),
    false,
  );
});

Deno.test("importsPollingWaitFor ignores a subpath specifier", () => {
  assertEquals(
    importsPollingWaitFor(
      'import { waitFor } from "@commonfabric/integration/shell-utils";',
    ),
    false,
  );
});

Deno.test("importsPollingWaitFor ignores a harness.waitFor member call", () => {
  const source = [
    'import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";',
    "await harness.waitFor(() => true);",
  ].join("\n");
  assertEquals(importsPollingWaitFor(source), false);
});

Deno.test("importsPollingWaitFor ignores a commented-out member", () => {
  const source = [
    "import {",
    "  env,",
    "  // waitFor,",
    '} from "@commonfabric/integration";',
  ].join("\n");
  assertEquals(importsPollingWaitFor(source), false);
});

Deno.test("isIntegrationTestFile scopes to integration test files", () => {
  assert(isIntegrationTestFile("packages/shell/integration/piece.test.ts"));
  assert(
    isIntegrationTestFile("packages/patterns/integration/counter.test.ts"),
  );
  assert(
    isIntegrationTestFile(
      "packages/patterns/google/core/integration/google-calendar-importer.test.ts",
    ),
  );
});

Deno.test("isIntegrationTestFile excludes the integration package itself", () => {
  // packages/integration/ defines and re-exports waitFor.
  assertEquals(
    isIntegrationTestFile("packages/integration/utils.ts"),
    false,
  );
  assertEquals(
    isIntegrationTestFile("packages/integration/shell-utils.ts"),
    false,
  );
});

Deno.test("isIntegrationTestFile excludes non-integration and non-ts files", () => {
  assertEquals(
    isIntegrationTestFile("packages/runner/test/scheduler.test.ts"),
    false,
  );
  assertEquals(
    isIntegrationTestFile("packages/patterns/integration/counter.tsx"),
    false,
  );
  // Outside packages/ entirely.
  assertEquals(
    isIntegrationTestFile("docs/examples/integration/demo.ts"),
    false,
  );
});

// The following two tests run against the real repository tree. Together they
// assert that the set of in-scope files importing the polling `waitFor` equals
// the ALLOWLIST exactly.

Deno.test("no un-allowlisted polling waitFor in integration tests", async () => {
  const { violations } = await scan();
  assertEquals(
    violations,
    [],
    "New polling waitFor usage found in integration test(s). Migrate to " +
      "waitForCondition / awaitViewSettled (see docs/development/waitfor-migration.md), " +
      "or, for a genuine exception, add the file to ALLOWLIST in tasks/check-no-waitfor.ts.",
  );
});

Deno.test("ALLOWLIST has no stale entries", async () => {
  const { allowlisted } = await scan();
  const seen = new Set(allowlisted);
  const stale = [...ALLOWLIST].filter((path) => !seen.has(path)).sort();
  assertEquals(
    stale,
    [],
    "ALLOWLIST entries in tasks/check-no-waitfor.ts no longer import the polling " +
      "waitFor (or no longer exist). Remove them from the allowlist.",
  );
});

// The next two tests drive the command entry point over a temp fixture tree, so
// they cover the clean and violation paths without depending on the real tree.

Deno.test("main reports success and returns 0 on a clean tree", async () => {
  const root = await fixtureTree(
    "ok.test.ts",
    'import { env } from "@commonfabric/integration";\n',
  );
  try {
    let code = -1;
    const { out } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
    assert(out.includes("No new polling waitFor"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main reports the offender and returns 1 on a violation", async () => {
  const root = await fixtureTree(
    "bad.test.ts",
    'import { waitFor } from "@commonfabric/integration";\n',
  );
  try {
    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("packages/foo/integration/bad.test.ts"));
    assert(err.includes("waitForCondition"));
    assert(err.includes("docs/development/waitfor-migration.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
