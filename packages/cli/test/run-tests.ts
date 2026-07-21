#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
import { join } from "@std/path";

const PERMISSIONS = [
  "--allow-ffi",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--allow-env",
  "--allow-net=127.0.0.1",
];

// Type checking of the CLI package (including test/ and support/) is done by
// `deno task check` (tasks/check.sh), so the test run skips it.
const BASE_FLAGS = ["--no-check"];

// Optional sharding for CI fan-out: CLI_TEST_SHARD="i/n" (1-based) runs only
// the test files where (sorted index % n) == (i - 1), so the CLI suite spreads
// across several workspace test shards instead of all landing in one. Mirrors
// PATTERN_INTEGRATION_SHARD in packages/patterns/integration/all.test.ts.
// Unset (local dev) runs every test file.
function parseCliTestShard(): { index: number; count: number } {
  const raw = Deno.env.get("CLI_TEST_SHARD");
  if (!raw) return { index: 0, count: 1 };
  const match = raw.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid CLI_TEST_SHARD "${raw}"; expected "i/n" (1-based).`,
    );
  }
  const index = Number(match[1]) - 1;
  const count = Number(match[2]);
  if (count < 1 || index < 0 || index >= count) {
    throw new Error(`CLI_TEST_SHARD "${raw}" out of range.`);
  }
  return { index, count };
}

const SERIAL_TESTS = [
  "test/fuse.test.ts",
  "test/inspect-remote.test.ts",
  "test/log-level.test.ts",
  "test/main-command.test.ts",
  "test/runtime-client-version.test.ts",
  "test/test-runner-compile-byte-cache.test.ts",
  "test/test-runner-pattern-coverage.test.ts",
  "test/view-commitmsg.test.ts",
  "test/view-mod-gate.test.ts",
  "test/view-pager-pty.test.ts",
];

// Tests that need a live toolshed named by API_URL. This runner excludes
// them: its --allow-net=127.0.0.1 grant cannot reach an arbitrary API_URL.
// The CI cli-integration-test job runs them against its toolshed; each
// file's header documents the direct local invocation.
const INTEGRATION_TESTS = [
  "test/piece-integration.test.ts",
];

function slashPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function collectTests(dir: string): Promise<string[]> {
  const tests: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = slashPath(join(dir, entry.name));
    if (entry.isDirectory) {
      tests.push(...await collectTests(path));
    } else if (entry.isFile && path.endsWith(".test.ts")) {
      tests.push(path);
    }
  }
  return tests;
}

async function run(
  label: string,
  options: string[],
  files: string[],
): Promise<void> {
  if (files.length === 0) {
    console.log(`Skipping ${label} (0 files)`);
    return;
  }

  console.log(`Running ${label} (${files.length} files)`);
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["test", ...PERMISSIONS, ...BASE_FLAGS, ...options, ...files],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!result.success) {
    Deno.exit(result.code);
  }
}

const allTests = (await Promise.all(["test", "support"].map(collectTests)))
  .flat()
  .sort();
const serial = new Set(SERIAL_TESTS);
const missingSerialTests = SERIAL_TESTS.filter((test) =>
  !allTests.includes(test)
);
if (missingSerialTests.length > 0) {
  console.error(
    `Serial CLI test file(s) not found: ${missingSerialTests.join(", ")}`,
  );
  Deno.exit(1);
}

const integration = new Set(INTEGRATION_TESTS);
const missingIntegrationTests = INTEGRATION_TESTS.filter((test) =>
  !allTests.includes(test)
);
if (missingIntegrationTests.length > 0) {
  console.error(
    `Integration CLI test file(s) not found: ${
      missingIntegrationTests.join(", ")
    }`,
  );
  Deno.exit(1);
}
const unitTests = allTests.filter((test) => !integration.has(test));

const shard = parseCliTestShard();
const tests = unitTests.filter((_, i) => i % shard.count === shard.index);

const parallelTests = tests.filter((test) => !serial.has(test));
const serialTests = tests.filter((test) => serial.has(test));
const denoTestArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;

await run("parallel CLI tests", ["--parallel", ...denoTestArgs], parallelTests);
await run("serial CLI tests", denoTestArgs, serialTests);
