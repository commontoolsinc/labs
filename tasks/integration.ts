#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env

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

// Packages with integration tests that need a running server
const PACKAGES_WITH_SERVER = [
  "runner",
  "runtime-client",
  "shell",
  "background-charm-service",
  "patterns",
  "cli",
];

// Packages with integration tests that DON'T need a running server
const PACKAGES_WITHOUT_SERVER = ["generated-patterns"];

// All packages with integration tests
const ALL_PACKAGES = [...PACKAGES_WITH_SERVER, ...PACKAGES_WITHOUT_SERVER];

// Packages that need HEADLESS=1 for browser tests
const HEADLESS_PACKAGES = ["shell", "background-charm-service", "patterns"];

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

async function startServers(
  portOffset: number,
  rootDir: string,
): Promise<boolean> {
  console.log(`Starting servers with PORT_OFFSET=${portOffset}...`);
  const result = await runCommand(
    ["bash", "scripts/start-local-dev.sh", `--port-offset=${portOffset}`],
    { cwd: rootDir, inheritStdio: true },
  );

  if (!result.success) {
    console.error("Failed to start servers");
    return false;
  }

  // Wait a bit more for servers to be fully ready
  console.log("Waiting for servers to be fully ready...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return true;
}

async function runPackageIntegration(
  pkg: string,
  apiUrl: string,
  rootDir: string,
  filter?: string,
): Promise<boolean> {
  const packageDir = path.join(rootDir, "packages", pkg);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Running integration tests for: ${pkg}`);
  console.log(`${"=".repeat(60)}`);

  const env: Record<string, string> = {
    LOG_LEVEL: "warn",
  };

  // Add API_URL for packages that need it
  if (PACKAGES_WITH_SERVER.includes(pkg)) {
    env.API_URL = apiUrl;
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

  if (pkg === "cli") {
    // CLI uses a special shell script
    env.CT_CLI_INTEGRATION_USE_LOCAL = "1";
    result = await runCommand(
      ["bash", "./integration/integration.sh"],
      { cwd: packageDir, env, inheritStdio: true },
    );
  } else if (filter) {
    // Run with filter - find matching test files
    const globPattern = `./integration/*${filter}*.test.ts`;
    const args = ["test", "-A"];

    // Add package-specific flags
    if (pkg === "patterns") {
      args.push("--v8-flags=--max-old-space-size=4096", "--trace-leaks");
    } else if (pkg === "generated-patterns") {
      args.push("--trace-leaks", "--parallel");
    }

    args.push(globPattern);
    result = await runCommand(["deno", ...args], {
      cwd: packageDir,
      env,
      inheritStdio: true,
    });
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
  --help, -h        Show this help message.

Arguments:
  package   Optional. Run tests for a specific package only.
            Available: ${ALL_PACKAGES.join(", ")}
  filter    Optional. Filter test files by name pattern.
            Only works with deno test packages (not cli).

Examples:
  deno task integration                       # Run all, auto-cleanup
  deno task integration cli                   # Run only cli tests
  deno task integration patterns counter      # Filter by test name
  deno task integration --port-offset=500     # Use specific port offset
  deno task integration --port-offset=500 cli # Combine options

Server ports (with offset):
  Toolshed:  8000 + offset
  Shell:     5173 + offset

Log files (after servers start):
  packages/shell/local-dev-shell.log
  packages/toolshed/local-dev-toolshed.log
`);
}

async function main(): Promise<void> {
  const args = Deno.args;

  // Handle --help
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    Deno.exit(0);
  }

  // Parse --port-offset argument
  let cliPortOffset: number | undefined;
  const positionalArgs: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--port-offset=")) {
      cliPortOffset = parseInt(arg.split("=")[1], 10);
      if (isNaN(cliPortOffset) || cliPortOffset < 0) {
        console.error(`Invalid port offset: ${arg}`);
        Deno.exit(1);
      }
    } else if (!arg.startsWith("-")) {
      positionalArgs.push(arg);
    }
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

  // Priority: CLI arg > env var > random
  const envPortOffset = Deno.env.get("PORT_OFFSET");
  const portOffsetWasSet = cliPortOffset !== undefined ||
    envPortOffset !== undefined;
  const portOffset = cliPortOffset ??
    (envPortOffset ? parseInt(envPortOffset, 10) : undefined) ??
    Math.floor(Math.random() * 901) + 100; // 100-1000

  const apiUrl = `http://localhost:${8000 + portOffset}`;

  console.log("Integration Test Runner");
  console.log("=======================");
  const offsetSource = cliPortOffset !== undefined
    ? " (from --port-offset)"
    : envPortOffset !== undefined
    ? " (from env)"
    : " (generated)";
  console.log(`PORT_OFFSET: ${portOffset}${offsetSource}`);
  console.log(`API_URL: ${apiUrl}`);
  if (packageFilter) {
    console.log(`Package filter: ${packageFilter}`);
  }
  if (nameFilter) {
    console.log(`Name filter: ${nameFilter}`);
  }
  console.log();

  // Determine which packages to run
  const packagesToRun = packageFilter ? [packageFilter] : ALL_PACKAGES;

  // Check if we need to start servers
  const needsServer = packagesToRun.some((pkg) =>
    PACKAGES_WITH_SERVER.includes(pkg)
  );

  let serverStarted = false;

  try {
    if (needsServer) {
      // If PORT_OFFSET was set, stop existing servers first
      if (portOffsetWasSet) {
        await stopServers(portOffset, rootDir);
      }

      // Start servers
      const started = await startServers(portOffset, rootDir);
      if (!started) {
        console.error("Failed to start servers, aborting.");
        Deno.exit(1);
      }
      serverStarted = true;
    }

    // Run integration tests
    const results: { pkg: string; success: boolean }[] = [];

    // Run packages that need server first
    for (
      const pkg of packagesToRun.filter((p) => PACKAGES_WITH_SERVER.includes(p))
    ) {
      const success = await runPackageIntegration(
        pkg,
        apiUrl,
        rootDir,
        nameFilter,
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
      Deno.exit(1);
    }
  } finally {
    // Clean up: stop servers if we started them and PORT_OFFSET was NOT originally set
    if (serverStarted && !portOffsetWasSet) {
      console.log("\nCleaning up servers...");
      await stopServers(portOffset, rootDir);
    } else if (serverStarted && portOffsetWasSet) {
      console.log("\nLeaving servers running (PORT_OFFSET was set).");
    }
  }
}

main();
