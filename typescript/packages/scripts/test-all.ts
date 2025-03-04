#!/usr/bin/env -S deno run --allow-read --allow-run
import * as path from "jsr:@std/path";

const decoder = new TextDecoder();
const workspaceCwd = Deno.cwd();
const manifest = JSON.parse(await Deno.readTextFile("./deno.json"));
const members: string[] = manifest.workspace;

const DISABLED = [
  "common-cli", // Disabled until `memory_test.ts` passes
  "common-html", // Disabled until we get tests and jsx in tests passing
  "deno-vite-plugin", // Do not test vendored code
  "toolshed", // Requires extra configuration to run (e.g. redis)
];

let success = true;
for (const memberPath of members) {
  // Convert "./common-memory" to "common-memory"
  const packageName = memberPath.substring(2);
  if (DISABLED.includes(packageName)) {
    continue;
  }
  console.log(`Testing ${packageName}...`);
  const packagePath = path.join(workspaceCwd, packageName);
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

async function testPackage(packagePath: string): Promise<boolean> {
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
