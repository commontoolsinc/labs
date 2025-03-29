#!/usr/bin/env -S deno run --allow-read --allow-run
import * as path from "@std/path";

const decoder = new TextDecoder();

export const ALL_DISABLED = [
  "deno-vite-plugin", // Do not test vendored code
  "toolshed", // Requires extra configuration to run (e.g. redis)
  "background-charm-service", // no tests yet
];

// Packages that need exclusive server access and can't run in parallel with each other
export const SERVER_PACKAGES = [
  "deno-web-test",
  "identity",
  "iframe-sandbox",
];

export async function testPackage(
  packagePath: string,
  packageName: string,
): Promise<boolean> {
  console.log(`Testing ${packageName}...`);

  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "test"],
    cwd: packagePath,
    stdout: "piped",
  }).output();

  const stdout = decoder.decode(result.stdout);
  if (stdout) {
    console.log(
      `\n--- ${packageName} stdout ---\n${stdout}\n--- End ${packageName} stdout ---\n`,
    );
  }
  const stderr = decoder.decode(result.stderr);
  if (stderr) {
    console.error(
      `\n--- ${packageName} stderr ---\n${stderr}\n--- End ${packageName} stderr ---\n`,
    );
  }

  console.log(`${packageName}: ${result.success ? "✅ PASSED" : "❌ FAILED"}`);
  return result.success;
}

export async function runTests(disabledPackages: string[]): Promise<boolean> {
  const workspaceCwd = Deno.cwd();
  const manifest = JSON.parse(await Deno.readTextFile("./deno.jsonc"));
  const members: string[] = manifest.workspace;

  // Group packages by type
  const parallelPackages = [];
  const serverPackages = [];

  for (const memberPath of members) {
    const packageName = memberPath.substring(2);

    if (disabledPackages.includes(packageName)) {
      continue;
    }

    const packagePath = path.join(workspaceCwd, packageName);

    if (SERVER_PACKAGES.includes(packageName)) {
      serverPackages.push({ packageName, packagePath });
    } else {
      parallelPackages.push({ packageName, packagePath });
    }
  }

  // Run parallel-safe tests concurrently
  console.log(`Running ${parallelPackages.length} packages in parallel...`);

  const parallelPromises = parallelPackages.map((
    { packageName, packagePath },
  ) =>
    testPackage(packagePath, packageName)
      .then((success) => ({ packageName, success }))
  );

  const parallelResults = await Promise.all(parallelPromises);

  // Run server-dependent tests sequentially
  console.log(
    `\nRunning ${serverPackages.length} server packages sequentially...`,
  );

  const serverResults = [];
  for (const { packageName, packagePath } of serverPackages) {
    const success = await testPackage(packagePath, packageName);
    serverResults.push({ packageName, success });
  }

  // Combine all results
  const results = [...parallelResults, ...serverResults];

  // Check if any tests failed
  const failedTests = results.filter((result) => !result.success);

  if (failedTests.length === 0) {
    console.log("\n✅ All tests passing!");
    return true;
  } else {
    console.error(`\n❌ ${failedTests.length} test(s) failed:`);
    for (const fail of failedTests) {
      console.error(`  - ${fail.packageName}`);
    }
    Deno.exit(1);
    return false;
  }
}

// Only run if this is the main module
if (import.meta.main) {
  await runTests(ALL_DISABLED);
}
