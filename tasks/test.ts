#!/usr/bin/env -S deno run --allow-read --allow-run
import * as path from "@std/path";
import { decode, encode } from "@commontools/utils/encoding";

export const ALL_DISABLED = [
  "background-charm-service", // no tests yet
  "vendor-astral", // no tests yet
];

export async function testPackage(
  packagePath: string,
): Promise<{ packagePath: string; result: Deno.CommandOutput }> {
  try {
    return {
      packagePath,
      result: await new Deno.Command(Deno.execPath(), {
        args: ["task", "test"],
        cwd: packagePath,
        stdout: "piped",
      }).output(),
    };
  } catch (e) {
    return {
      packagePath,
      result: {
        success: false,
        stdout: new Uint8Array(),
        stderr: encode(`${e}`),
        code: 1,
        signal: null,
      },
    };
  }
}

export async function runTests(disabledPackages: string[]): Promise<boolean> {
  const workspaceCwd = Deno.cwd();
  const manifest = JSON.parse(await Deno.readTextFile("./deno.json"));
  const members: string[] = manifest.workspace;

  const tests = [];
  for (const memberPath of members) {
    // Convert "./packages/memory" to "memory"
    const packageName = memberPath.substring(2).split("/")[1];

    if (disabledPackages.includes(packageName)) {
      continue;
    }
    console.log(`Testing ${packageName}...`);
    const packagePath = path.join(workspaceCwd, "packages", packageName);
    tests.push(testPackage(packagePath));
  }

  const results = await Promise.all(tests);
  const failedPackages = results.filter((result) => !result.result.success);

  if (failedPackages.length === 0) {
    console.log("All tests passing!");
  } else {
    console.error("One or more tests failed.");
    console.error("Failed packages:");
    for (const result of failedPackages) {
      console.error(`- ${result.packagePath}`);
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
