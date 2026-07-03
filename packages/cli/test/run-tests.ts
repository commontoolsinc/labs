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

const SERIAL_TESTS = [
  "test/fuse.test.ts",
  "test/inspect-remote.test.ts",
  "test/log-level.test.ts",
  "test/main-command.test.ts",
  "test/test-runner-compile-byte-cache.test.ts",
  "test/test-runner-pattern-coverage.test.ts",
  "test/view-mod-gate.test.ts",
  "test/view-pager-pty.test.ts",
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
    args: ["test", ...PERMISSIONS, ...options, ...files],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!result.success) {
    Deno.exit(result.code);
  }
}

const tests = (await Promise.all(["test", "support"].map(collectTests)))
  .flat()
  .sort();
const serial = new Set(SERIAL_TESTS);
const missingSerialTests = SERIAL_TESTS.filter((test) => !tests.includes(test));
if (missingSerialTests.length > 0) {
  console.error(
    `Serial CLI test file(s) not found: ${missingSerialTests.join(", ")}`,
  );
  Deno.exit(1);
}

const parallelTests = tests.filter((test) => !serial.has(test));
const denoTestArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;

await run("parallel CLI tests", ["--parallel", ...denoTestArgs], parallelTests);
await run("serial CLI tests", denoTestArgs, SERIAL_TESTS);
