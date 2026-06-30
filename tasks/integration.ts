#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

/**
 * Integration test runner for the entire monorepo.
 *
 * Usage:
 *   deno task integration [package] [filter]
 *
 * Examples:
 *   deno task integration              # Run all integration tests
 *   deno task integration cli          # Run only cli integration tests
 *   deno task integration patterns counter  # Run patterns tests matching "counter"
 *
 * Environment:
 *   PORT_OFFSET - If set, uses this offset and stops existing servers first.
 *                 If not set, picks a random offset and cleans up after.
 */

import * as path from "@std/path";
import ports from "@commonfabric/ports" with { type: "json" };

// Packages with integration tests that need a running server by default.
const DEFAULT_PACKAGES_WITH_SERVER = [
  "runner",
  "runtime-client",
  "shell",
  "patterns",
  "cli",
];

// Opt-in suites that mirror CI jobs but rely on more platform-specific setup.
const OPTIONAL_PACKAGES_WITH_SERVER = ["cli-fuse", "patterns-reload"];

// Packages with integration tests that DON'T need a running server
const PACKAGES_WITHOUT_SERVER = ["generated-patterns", "pattern-tests"];

// Default `deno task integration` coverage.
const DEFAULT_PACKAGES = [
  ...DEFAULT_PACKAGES_WITH_SERVER,
  ...PACKAGES_WITHOUT_SERVER,
];

const ALL_PACKAGES_WITH_SERVER = [
  ...DEFAULT_PACKAGES_WITH_SERVER,
  ...OPTIONAL_PACKAGES_WITH_SERVER,
];

// All valid integration targets, including opt-in platform-specific suites.
const ALL_PACKAGES = [...DEFAULT_PACKAGES, ...OPTIONAL_PACKAGES_WITH_SERVER];

// Packages that need HEADLESS=1 for browser tests
const HEADLESS_PACKAGES = [
  "shell",
  "patterns",
  "patterns-reload",
];

async function runCommand(
  cmd: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    inheritStdio?: boolean;
  } = {},
): Promise<
  { success: boolean; code: number; stdout?: string; stderr?: string }
> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: options.cwd,
    env: { ...Deno.env.toObject(), ...options.env },
    stdout: options.inheritStdio ? "inherit" : "piped",
    stderr: options.inheritStdio ? "inherit" : "piped",
  });

  const result = await command.output();
  const decoder = new TextDecoder();

  return {
    success: result.success,
    code: result.code,
    stdout: options.inheritStdio ? undefined : decoder.decode(result.stdout),
    stderr: options.inheritStdio ? undefined : decoder.decode(result.stderr),
  };
}

async function stopServers(portOffset: number, rootDir: string): Promise<void> {
  console.log(`Stopping servers with PORT_OFFSET=${portOffset}...`);
  await runCommand(
    ["bash", "scripts/stop-local-dev.sh", `--port-offset=${portOffset}`],
    { cwd: rootDir, inheritStdio: true },
  );
}

// start-local-dev.sh exits with this code when a requested port is already in
// use. Other failures use different codes and are not worth retrying.
const PORT_IN_USE_EXIT = 3;

// Starts the dev servers for the given offset. Returns the start-local-dev.sh
// exit code: 0 on success, PORT_IN_USE_EXIT on a port collision, or another
// non-zero code for any other startup failure.
async function startServers(
  portOffset: number,
  rootDir: string,
  env: Record<string, string> = {},
): Promise<number> {
  console.log(`Starting servers with PORT_OFFSET=${portOffset}...`);
  const result = await runCommand(
    ["bash", "scripts/start-local-dev.sh", `--port-offset=${portOffset}`],
    { cwd: rootDir, env, inheritStdio: true },
  );

  if (!result.success) {
    console.error("Failed to start servers");
    return result.code;
  }

  // Wait a bit more for servers to be fully ready
  console.log("Waiting for servers to be fully ready...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return 0;
}

/**
 * Resolve the cf binary: CF_BINARY env var, or fall back to running
 * the CLI entrypoint via deno.
 */
function getCfCommand(rootDir: string): string[] {
  const cfBinary = Deno.env.get("CF_BINARY");
  if (cfBinary) {
    return [cfBinary];
  }
  return [
    "deno",
    "run",
    "--allow-net",
    "--allow-ffi",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    path.join(rootDir, "packages/cli/mod.ts"),
  ];
}

/**
 * Finds all `.test.tsx` pattern tests that match the given filter (if any). A
 * filter of the form `<chunk>/<total-chunks>` produces the indicated "chunk" of
 * the tests, to allow for separate parallel tasks to handle all the chunks.
 */
async function findPatternTests(
  rootDir: string,
  patternsDir: string,
  filter?: string,
): Promise<string[]> {
  const { chunkStr, totalChunksStr, nameFilter } = (filter ?? "")
    .match(
      /^(?:(?<chunkStr>[1-9][0-9]*)[/](?<totalChunksStr>[1-9][0-9]*)|(?<nameFilter>.+)|)$/,
    )!
    .groups as {
      chunkStr?: string;
      totalChunksStr?: string;
      nameFilter?: string;
    };

  const chunk = chunkStr ? parseInt(chunkStr) : undefined;
  const totalChunks = totalChunksStr ? parseInt(totalChunksStr) : undefined;

  // Find all .test.tsx files
  const testFiles: string[] = [];
  for await (const entry of walkDir(patternsDir)) {
    if (entry.endsWith(".test.tsx")) {
      const relative = path.relative(rootDir, entry);
      if (!nameFilter || relative.includes(nameFilter)) {
        testFiles.push(relative);
      }
    }
  }

  testFiles.sort();

  if (chunk && totalChunks) {
    if (chunk > totalChunks) {
      throw new Error(`Nonsensical chunk demand: ${chunk}/${totalChunks}`);
    }
    const perChunk = testFiles.length / totalChunks;
    const first = Math.floor((chunk - 1) * perChunk);
    const afterLast = Math.floor(chunk * perChunk);
    console.log(`Testing pattern chunk ${chunk} of ${totalChunks}.`);
    console.log(`${testFiles.length} tests in total across all chunks.`);
    return testFiles.slice(first, afterLast);
  } else {
    return testFiles;
  }
}

/**
 * Find and run all .test.tsx pattern tests via `cf test`.
 * Captures per-test timing and optionally writes JUnit XML.
 */
async function runPatternTests(
  rootDir: string,
  filter?: string,
  junitDir?: string,
): Promise<boolean> {
  const patternsDir = path.join(rootDir, "packages/patterns");
  const cfCmd = getCfCommand(rootDir);
  const testFiles = await findPatternTests(rootDir, patternsDir, filter);

  if (testFiles.length === 0) {
    console.log("No pattern test files found.");
    return true;
  }

  const concurrency = 5;
  console.log(
    `Found ${testFiles.length} pattern test(s), running ${concurrency} at a time`,
  );
  const failed: string[] = [];
  const testTimings: { file: string; durationMs: number; passed: boolean }[] =
    [];

  // Run as a pool: always keep `concurrency` tests in flight
  let nextIndex = 0;
  const running = new Set<Promise<void>>();

  function enqueue(): void {
    while (running.size < concurrency && nextIndex < testFiles.length) {
      const testFile = testFiles[nextIndex++];
      const p = (async () => {
        const startMs = performance.now();
        const result = await runCommand(
          [
            ...cfCmd,
            "test",
            "--timeout",
            "180000",
            "--root",
            patternsDir,
            testFile,
          ],
          { cwd: rootDir },
        );
        const durationMs = performance.now() - startMs;

        testTimings.push({
          file: testFile,
          durationMs,
          passed: result.success,
        });

        if (result.success) {
          console.log(
            `✅ ${testFile} (${(durationMs / 1000).toFixed(1)}s)`,
          );
        } else {
          console.log(
            `❌ ${testFile} (${(durationMs / 1000).toFixed(1)}s)`,
          );
          failed.push(testFile);
        }
        if (result.stdout) {
          for (const line of result.stdout.trimEnd().split("\n")) {
            console.log(`   ${line}`);
          }
        }
        if (result.stderr) {
          for (const line of result.stderr.trimEnd().split("\n")) {
            console.error(`   ${line}`);
          }
        }
      })().finally(() => {
        running.delete(p);
        enqueue();
      });
      running.add(p);
    }
  }

  enqueue();
  while (running.size > 0) {
    await Promise.race(running);
  }

  if (failed.length === 0) {
    console.log(`\n✅ All ${testFiles.length} pattern tests passed`);
  } else {
    console.error(
      `\n❌ ${failed.length}/${testFiles.length} pattern tests failed:`,
    );
    for (const f of failed) {
      console.error(`   ${f}`);
    }
  }

  // Write JUnit XML with per-test timing
  if (junitDir) {
    await Deno.mkdir(junitDir, { recursive: true });
    const xml = buildPatternTestJUnit(testTimings);
    const junitPath = path.join(junitDir, "pattern-unit-tests.xml");
    await Deno.writeTextFile(junitPath, xml);
    console.log(`Wrote JUnit timing to ${junitPath}`);
  }

  return failed.length === 0;
}

/** Build a JUnit XML document from per-test pattern test timings. */
function buildPatternTestJUnit(
  timings: { file: string; durationMs: number; passed: boolean }[],
): string {
  const escapeXml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const totalTime = timings.reduce((s, t) => s + t.durationMs, 0) / 1000;
  const failures = timings.filter((t) => !t.passed).length;

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites>`,
    `<testsuite name="pattern-unit-tests" tests="${timings.length}" failures="${failures}" time="${
      totalTime.toFixed(3)
    }">`,
  ];

  for (const t of timings) {
    const timeSec = (t.durationMs / 1000).toFixed(3);
    lines.push(
      `  <testcase name="${escapeXml(t.file)}" time="${timeSec}"${
        t.passed ? " />" : ">"
      }`,
    );
    if (!t.passed) {
      lines.push(`    <failure message="Test failed" />`);
      lines.push(`  </testcase>`);
    }
  }

  lines.push(`</testsuite>`);
  lines.push(`</testsuites>`);

  return lines.join("\n");
}

/**
 * The directory, relative to a package root, that holds its integration test
 * files. Most packages keep them directly in `integration/`. The
 * generated-patterns package keeps them in `integration/patterns/`, matching
 * the glob its own `integration` task runs.
 */
export function integrationTestDir(pkg: string): string {
  return pkg === "generated-patterns" ? "integration/patterns" : "integration";
}

/**
 * Select the integration test files whose name matches a filter.
 *
 * Keeps the names ending in `.test.ts` whose name contains the filter
 * substring, sorted so the order is stable.
 */
export function selectIntegrationTestFiles(
  fileNames: string[],
  filter: string,
): string[] {
  return fileNames
    .filter((name) => name.endsWith(".test.ts") && name.includes(filter))
    .sort();
}

/**
 * List the integration test files in a directory whose name matches a filter.
 *
 * Reads the directory one level deep and returns the matching file names. A
 * missing directory yields an empty list. Nested directories such as
 * `integration/reload/` are not descended into, matching the single-level set
 * the package's `integration` task runs.
 */
export async function findIntegrationTestFiles(
  integrationDir: string,
  filter: string,
): Promise<string[]> {
  const fileNames: string[] = [];
  try {
    for await (const entry of Deno.readDir(integrationDir)) {
      if (entry.isFile) {
        fileNames.push(entry.name);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return selectIntegrationTestFiles(fileNames, filter);
}

/**
 * Build the `deno test` arguments for a name-filtered integration run. The
 * matching files are passed as explicit paths under `relDir`. Deno does not
 * filter explicitly-passed paths through a package `test` config's `exclude`,
 * so they run even where that config drops the `integration/` directory.
 */
export function buildFilteredTestArgs(
  pkg: string,
  relDir: string,
  testFiles: string[],
  junitDir?: string,
): string[] {
  const args = ["test", "-A"];

  if (pkg === "patterns") {
    args.push("--v8-flags=--max-old-space-size=4096", "--trace-leaks");
  } else if (pkg === "generated-patterns") {
    args.push("--trace-leaks", "--parallel");
  }

  if (junitDir) {
    args.push(`--junit-path=${path.join(junitDir, `${pkg}.xml`)}`);
  }

  for (const name of testFiles) {
    args.push(`./${relDir}/${name}`);
  }

  return args;
}

/**
 * Run a package's integration tests filtered by name.
 *
 * Enumerates the matching test files and passes them to `deno test` as explicit
 * paths. A glob string handed to `deno test` is expanded and then filtered
 * through the package's `test` config; that config's `exclude` drops the
 * `integration/` directory, leaving no modules to run. Explicit file paths skip
 * that filtering, so the files are enumerated here instead of passing a glob.
 * Returns a failing result, without running anything, when no file matches.
 */
export async function runFilteredIntegration(
  pkg: string,
  packageDir: string,
  env: Record<string, string>,
  filter: string,
  junitDir?: string,
  run: typeof runCommand = runCommand,
): Promise<{ success: boolean; code: number }> {
  const relDir = integrationTestDir(pkg);
  const testFiles = await findIntegrationTestFiles(
    path.join(packageDir, relDir),
    filter,
  );

  if (testFiles.length === 0) {
    console.error(
      `No integration test files in ${pkg} match filter "${filter}".`,
    );
    return { success: false, code: 1 };
  }

  const args = buildFilteredTestArgs(pkg, relDir, testFiles, junitDir);
  return await run(["deno", ...args], {
    cwd: packageDir,
    env,
    inheritStdio: true,
  });
}

/** Recursively walk a directory yielding file paths. */
async function* walkDir(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory) {
      yield* walkDir(fullPath);
    } else {
      yield fullPath;
    }
  }
}

export async function runPackageIntegration(
  pkg: string,
  apiUrl: string,
  rootDir: string,
  filter?: string,
  junitDir?: string,
): Promise<boolean> {
  const packageDirName = pkg === "cli-fuse"
    ? "cli"
    : pkg === "patterns-reload"
    ? "patterns"
    : pkg;
  const packageDir = path.join(
    rootDir,
    "packages",
    packageDirName,
  );
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Running integration tests for: ${pkg}`);
  console.log(`${"=".repeat(60)}`);

  const env: Record<string, string> = {
    LOG_LEVEL: "warn",
  };

  // Set INTEGRATION_TEST_FLAGS for JUnit output if --junit-dir was specified
  if (junitDir) {
    const junitPath = path.join(junitDir, `${pkg}.xml`);
    env.INTEGRATION_TEST_FLAGS = `--junit-path=${junitPath}`;
  } else {
    // Pass through INTEGRATION_TEST_FLAGS if set in environment
    const testFlags = Deno.env.get("INTEGRATION_TEST_FLAGS");
    if (testFlags) {
      env.INTEGRATION_TEST_FLAGS = testFlags;
    }
  }

  // Add API_URL for packages that need it
  if (ALL_PACKAGES_WITH_SERVER.includes(pkg)) {
    env.API_URL = apiUrl;
  }

  if (pkg === "patterns-reload") {
    env.CF_EXPECT_PERSISTENT_SCHEDULER_STATE = "1";
  }

  // For browser test packages, pass through HEADLESS and PIPE_CONSOLE
  if (HEADLESS_PACKAGES.includes(pkg)) {
    // Default HEADLESS to "1" unless explicitly set in environment
    const headlessEnv = Deno.env.get("HEADLESS");
    env.HEADLESS = headlessEnv ?? "1";

    // Pass through PIPE_CONSOLE if set
    const pipeConsoleEnv = Deno.env.get("PIPE_CONSOLE");
    if (pipeConsoleEnv) {
      env.PIPE_CONSOLE = pipeConsoleEnv;
    }
  }

  let result: { success: boolean; code: number };

  if (pkg === "pattern-tests") {
    return await runPatternTests(rootDir, filter, junitDir);
  } else if (pkg === "cli") {
    // CLI uses a special shell script
    env.CF_CLI_INTEGRATION_USE_LOCAL = "1";
    result = await runCommand(
      ["bash", "./integration/integration.sh"],
      { cwd: packageDir, env, inheritStdio: true },
    );
  } else if (pkg === "cli-fuse") {
    // Mirror the dedicated GitHub Actions FUSE suite, but keep it opt-in
    // locally because it depends on platform-specific FUSE setup.
    env.CF_CLI_INTEGRATION_USE_LOCAL = "1";
    env.FUSE_DEEP_ENTITY_PROBE = Deno.env.get("FUSE_DEEP_ENTITY_PROBE") ?? "0";
    result = await runCommand(
      ["bash", "./integration/fuse-exec.sh"],
      { cwd: packageDir, env, inheritStdio: true },
    );
  } else if (pkg === "patterns-reload") {
    result = await runCommand(["deno", "task", "integration:reload"], {
      cwd: packageDir,
      env,
      inheritStdio: true,
    });
  } else if (filter) {
    result = await runFilteredIntegration(
      pkg,
      packageDir,
      env,
      filter,
      junitDir,
    );
  } else {
    // Run the standard integration task
    result = await runCommand(["deno", "task", "integration"], {
      cwd: packageDir,
      env,
      inheritStdio: true,
    });
  }

  if (result.success) {
    console.log(`✅ ${pkg} integration tests passed`);
  } else {
    console.error(
      `❌ ${pkg} integration tests failed (exit code: ${result.code})`,
    );
  }

  return result.success;
}

function printUsage(): void {
  console.log(`
Integration Test Runner
=======================

Usage:
  deno task integration [options] [package] [filter]

Options:
  --port-offset=N   Use port offset N (100-1000). Servers are left running
                    after tests complete. If not set, picks a random offset
                    and cleans up servers after tests.
  --junit-dir=DIR   Write JUnit XML results per package to DIR (e.g.,
                    --junit-dir=test-results creates test-results/<package>.xml).
  --help, -h        Show this help message.

Arguments:
  package   Optional. Run tests for a specific package only.
            Available: ${ALL_PACKAGES.join(", ")}
  filter    Optional. Filter test files by name pattern.
            Only works with deno test packages (not cli or cli-fuse).

Examples:
  deno task integration                       # Run all, auto-cleanup
  deno task integration cli                   # Run only cli tests
  deno task integration cli-fuse              # Run the opt-in CLI FUSE suite
  deno task integration patterns counter      # Filter by test name
  deno task integration patterns-reload       # Run opt-in pattern reload tests
  deno task integration pattern-tests         # Run .test.tsx pattern unit tests
  deno task integration --port-offset=500     # Use specific port offset
  deno task integration --port-offset=500 cli # Combine options

Notes:
  The default run omits platform-specific suites such as cli-fuse.
  Use them explicitly when your machine is set up similarly to CI.

Environment:
  CF_BINARY      - Path to the cf binary (for pattern-tests target).
                   Falls back to running packages/cli/mod.ts via deno.
Server ports (with offset):
  Toolshed:  ${ports.toolshed} + offset
  Shell:     ${ports.shell} + offset

Log files (after servers start):
  packages/shell/local-dev-shell.log
  packages/toolshed/local-dev-toolshed.log
`);
}

/**
 * Parse a port offset, exiting with a clear error if it is not a non-negative
 * integer. Shared by --port-offset and the PORT_OFFSET env var so an invalid
 * value fails fast instead of becoming NaN in URLs and command arguments.
 */
function parsePortOffset(value: string, source: string): number {
  const offset = parseInt(value, 10);
  if (Number.isNaN(offset) || offset < 0) {
    console.error(`Invalid port offset from ${source}: "${value}"`);
    Deno.exit(1);
  }
  return offset;
}

async function main(): Promise<void> {
  const args = Deno.args;

  // Handle --help
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    Deno.exit(0);
  }

  // Parse flags
  let cliPortOffset: number | undefined;
  let junitDir: string | undefined;
  const positionalArgs: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--port-offset=")) {
      cliPortOffset = parsePortOffset(arg.split("=")[1], "--port-offset");
    } else if (arg.startsWith("--junit-dir=")) {
      junitDir = arg.split("=")[1];
    } else if (!arg.startsWith("-")) {
      positionalArgs.push(arg);
    }
  }

  // If --junit-dir is set, pass per-package INTEGRATION_TEST_FLAGS
  if (junitDir) {
    await Deno.mkdir(junitDir, { recursive: true });
  }

  const packageFilter = positionalArgs[0];
  const nameFilter = positionalArgs[1];

  // Validate package filter
  if (packageFilter && !ALL_PACKAGES.includes(packageFilter)) {
    console.error(`Unknown package: ${packageFilter}`);
    console.error(`Available packages: ${ALL_PACKAGES.join(", ")}`);
    Deno.exit(1);
  }

  const rootDir = Deno.cwd();

  // Priority: CLI arg > env var > generated. An explicit offset is reused as-is
  // and its servers are left running; a generated offset is tried at random,
  // retried on a port collision, and stopped after the run.
  // An empty or whitespace PORT_OFFSET is treated as unset (use a generated
  // offset); a non-empty value is validated so a typo fails fast.
  const envPortOffsetRaw = Deno.env.get("PORT_OFFSET");
  const envPortOffset =
    envPortOffsetRaw !== undefined && envPortOffsetRaw.trim() !== ""
      ? parsePortOffset(envPortOffsetRaw, "PORT_OFFSET")
      : undefined;
  const portOffsetWasSet = cliPortOffset !== undefined ||
    envPortOffset !== undefined;
  const offsetSource = cliPortOffset !== undefined
    ? " (from --port-offset)"
    : envPortOffset !== undefined
    ? " (from env)"
    : " (generated)";

  console.log("Integration Test Runner");
  console.log("=======================");
  if (packageFilter) {
    console.log(`Package filter: ${packageFilter}`);
  }
  if (nameFilter) {
    console.log(`Name filter: ${nameFilter}`);
  }
  console.log();

  // Determine which packages to run
  const packagesToRun = packageFilter ? [packageFilter] : DEFAULT_PACKAGES;

  // Check if we need to start servers
  const needsServer = packagesToRun.some((pkg) =>
    ALL_PACKAGES_WITH_SERVER.includes(pkg)
  );

  // An explicit offset is used directly; a generated offset is replaced with a
  // free one just before the servers start.
  let portOffset = cliPortOffset ?? envPortOffset ?? 0;
  let apiUrl = "";

  // A generated-offset run owns the servers it starts and stops them on the way
  // out, including after a failure. An explicit offset is left running.
  let ownsServers = false;
  let serverStarted = false;
  let cleanedUp = false;
  let exitCode = 0;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (ownsServers) {
      console.log("\nCleaning up servers...");
      await stopServers(portOffset, rootDir);
    } else if (serverStarted) {
      console.log("\nLeaving servers running (PORT_OFFSET was set).");
    }
  };

  // A signal terminates the process without running `finally`, so stop the
  // servers from the handler before exiting.
  const onSignal = () => {
    console.log("\nInterrupted, cleaning up...");
    cleanup().finally(() => Deno.exit(130));
  };
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  try {
    if (needsServer) {
      const serverEnv: Record<string, string> = {};
      if (packagesToRun.includes("patterns-reload")) {
        serverEnv.EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE = "true";
      }

      if (portOffsetWasSet) {
        // Reuse the requested offset, stopping anything already on its ports.
        await stopServers(portOffset, rootDir);
        apiUrl = `http://localhost:${ports.toolshed + portOffset}`;
        console.log(`PORT_OFFSET: ${portOffset}${offsetSource}`);
        console.log(`API_URL: ${apiUrl}`);
        if (await startServers(portOffset, rootDir, serverEnv) !== 0) {
          console.error("Failed to start servers, aborting.");
          exitCode = 1;
          return;
        }
        serverStarted = true;
      } else {
        // Try a random offset and let the servers report a real port collision
        // by failing to bind (PORT_IN_USE_EXIT); retry on a fresh offset only in
        // that case. Any other failure is not port-related and would recur on
        // every offset, so it stops the run.
        const maxStartAttempts = 5;
        for (let attempt = 1; attempt <= maxStartAttempts; attempt++) {
          portOffset = Math.floor(Math.random() * 901) + 100; // 100-1000
          apiUrl = `http://localhost:${ports.toolshed + portOffset}`;
          console.log(`PORT_OFFSET: ${portOffset}${offsetSource}`);
          console.log(`API_URL: ${apiUrl}`);
          // Once an offset is chosen, this run is responsible for stopping
          // anything started on it, including after a failed attempt.
          ownsServers = true;
          const startCode = await startServers(portOffset, rootDir, serverEnv);
          if (startCode === 0) {
            serverStarted = true;
            break;
          }
          if (startCode !== PORT_IN_USE_EXIT) {
            break;
          }
          console.warn(
            `Offset ${portOffset} hit a port collision; retrying...`,
          );
        }
        if (!serverStarted) {
          console.error("Failed to start servers, aborting.");
          exitCode = 1;
          return;
        }
      }
    }

    // Run integration tests
    const results: { pkg: string; success: boolean }[] = [];

    // Run packages that need server first
    for (
      const pkg of packagesToRun.filter((p) =>
        ALL_PACKAGES_WITH_SERVER.includes(p)
      )
    ) {
      const success = await runPackageIntegration(
        pkg,
        apiUrl,
        rootDir,
        nameFilter,
        junitDir,
      );
      results.push({ pkg, success });
    }

    // Then run packages that don't need server
    for (
      const pkg of packagesToRun.filter((p) =>
        PACKAGES_WITHOUT_SERVER.includes(p)
      )
    ) {
      const success = await runPackageIntegration(
        pkg,
        apiUrl,
        rootDir,
        nameFilter,
        junitDir,
      );
      results.push({ pkg, success });
    }

    // Summary
    console.log(`\n${"=".repeat(60)}`);
    console.log("Summary");
    console.log(`${"=".repeat(60)}`);

    const passed = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    for (const { pkg, success } of results) {
      console.log(`  ${success ? "✅" : "❌"} ${pkg}`);
    }

    console.log();
    console.log(`Passed: ${passed.length}/${results.length}`);

    if (failed.length > 0) {
      console.log(`Failed: ${failed.map((r) => r.pkg).join(", ")}`);
      exitCode = 1;
    }
  } catch (error) {
    console.error("Integration run failed:", error);
    exitCode = 1;
  } finally {
    Deno.removeSignalListener("SIGINT", onSignal);
    Deno.removeSignalListener("SIGTERM", onSignal);
    await cleanup();
    Deno.exit(exitCode);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Integration run failed:", error);
    Deno.exit(1);
  });
}
