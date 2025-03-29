#!/usr/bin/env -S deno run --allow-read --allow-run
import * as path from "@std/path";

const decoder = new TextDecoder();

export const ALL_DISABLED = [
  "deno-vite-plugin", // Do not test vendored code
  "toolshed", // Requires extra configuration to run (e.g. redis)
  "background-charm-service", // no tests yet
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

  // Filter out disabled packages and prepare test promises
  const testPromises = members
    .filter((memberPath) => {
      // Convert "./memory" to "memory"
      const packageName = memberPath.substring(2);
      return !disabledPackages.includes(packageName);
    })
    .map((memberPath) => {
      const packageName = memberPath.substring(2);
      const packagePath = path.join(workspaceCwd, packageName);
      return { packageName, packagePath };
    })
    .map(({ packageName, packagePath }) =>
      testPackage(packagePath, packageName)
        .then((success) => ({ packageName, success }))
    );

  console.log(
    `Running tests concurrently for ${testPromises.length} packages...`,
  );

  // Run all tests concurrently
  const results = await Promise.all(testPromises);

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
