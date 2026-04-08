#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
import * as path from "@std/path";
import { decode, encode } from "@commonfabric/utils/encoding";

export const ALL_DISABLED = [
  "background-charm-service", // no tests yet
  "vendor-astral", // no tests yet
];

export function getPackageName(memberPath: string): string {
  const relativePath = memberPath.replace(/^\.\//, "");
  return relativePath.replace(/^packages\//, "");
}

export async function testPackage(
  memberPath: string,
  packageName: string,
  packagePath: string,
): Promise<{
  memberPath: string;
  packageName: string;
  packagePath: string;
  durationMs: number;
  result: Deno.CommandOutput;
}> {
  const startedAt = Date.now();
  let result: Deno.CommandOutput;
  try {
    result = await new Deno.Command(Deno.execPath(), {
      args: ["task", "test"],
      cwd: packagePath,
      env: { ENV: "test" },
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    result = {
      success: false,
      stdout: new Uint8Array(),
      stderr: encode(`${e}`),
      code: 1,
      signal: null,
    };
  }

  const durationMs = Date.now() - startedAt;
  const duration = (durationMs / 1000).toFixed(1);
  const status = result.success ? "ok" : "failed";
  console.log(`Finished ${packageName} in ${duration}s (${status})`);

  return {
    memberPath,
    packageName,
    packagePath,
    durationMs,
    result,
  };
}

export async function runTests(disabledPackages: string[]): Promise<boolean> {
  const workspaceCwd = Deno.cwd();
  const suiteStartedAt = Date.now();
  const manifest = JSON.parse(await Deno.readTextFile("./deno.json"));
  const members: string[] = manifest.workspace;

  const tests = [];
  for (const memberPath of members) {
    const packageName = getPackageName(memberPath);

    if (disabledPackages.includes(packageName)) {
      continue;
    }
    console.log(`Testing ${packageName}...`);
    const packagePath = path.resolve(workspaceCwd, memberPath);
    tests.push(testPackage(memberPath, packageName, packagePath));
  }

  const results = await Promise.all(tests);
  const durationResults = [...results].sort((a, b) =>
    b.durationMs - a.durationMs
  );
  const failedPackages = results.filter((result) => !result.result.success);

  console.log("Package timings:");
  for (const result of durationResults) {
    const duration = (result.durationMs / 1000).toFixed(1);
    const status = result.result.success ? "ok" : "failed";
    console.log(`- ${result.packageName}: ${duration}s (${status})`);
  }
  console.log(
    `Total wall time: ${((Date.now() - suiteStartedAt) / 1000).toFixed(1)}s`,
  );

  if (failedPackages.length === 0) {
    console.log("All tests passing!");
  } else {
    console.error("One or more tests failed.");
    console.error("Failed packages:");
    for (const result of failedPackages) {
      console.error(`- ${result.packageName} (${result.packagePath})`);
      console.log(decode(result.result.stdout));
      console.error(decode(result.result.stderr));
    }
    Deno.exit(1);
  }

  return failedPackages.length === 0;
}

// Only run if this is the main module
if (import.meta.main) {
  await runTests(ALL_DISABLED);
}
