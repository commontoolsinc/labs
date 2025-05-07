#!/usr/bin/env -S deno run --allow-read --allow-run
import * as path from "@std/path";

const decoder = new TextDecoder();

export const ALL_DISABLED = [
  "deno-vite-plugin", // Do not test vendored code
  "toolshed", // Requires extra configuration to run (e.g. redis)
  "background-charm-service", // no tests yet
];

export async function testPackage(packagePath: string): Promise<boolean> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "test"],
    cwd: packagePath,
    stdout: "piped",
  }).output();

  const stdout = decoder.decode(result.stdout);
  if (stdout) {
    console.log(stdout);
  }
  const stderr = decoder.decode(result.stderr);
  if (stderr) {
    console.error(stderr);
  }
  return result.success;
}

export async function runTests(disabledPackages: string[]): Promise<boolean> {
  const workspaceCwd = Deno.cwd();
  const manifest = JSON.parse(await Deno.readTextFile("./deno.json"));
  const members: string[] = manifest.workspace;

  let success = true;
  for (const memberPath of members) {
    // Convert "./packages/memory" to "memory"
    const packageName = memberPath.substring(2).split("/")[1];

    if (disabledPackages.includes(packageName)) {
      continue;
    }
    console.log(`Testing ${packageName}...`);
    const packagePath = path.join(workspaceCwd, "packages", packageName);
    if (!await testPackage(packagePath)) {
      success = false;
    }
  }

  if (success) {
    console.log("All tests passing!");
  } else {
    console.error("One or more tests failed.");
    Deno.exit(1);
  }

  return success;
}

// Only run if this is the main module
if (import.meta.main) {
  await runTests(ALL_DISABLED);
}
