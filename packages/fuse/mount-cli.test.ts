// The daemon entrypoint's option contract, exercised through a real process.
//
// main() validates the cache mount flags before it opens libfuse or creates
// the mountpoint, so these runs need no FUSE provider and mount nothing. The
// checks cannot run in-process: main() reports a rejected flag by exiting.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { dirname, fromFileUrl, join } from "@std/path";
import { existsSync } from "@std/fs";

const packageDir = dirname(fromFileUrl(import.meta.url));
const repoRoot = join(packageDir, "..", "..");
const modPath = join(packageDir, "mod.ts");
const decoder = new TextDecoder();

/** Run the daemon entrypoint and capture how it exited. */
async function runDaemon(
  args: string[],
): Promise<{ code: number; stderr: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: repoRoot,
    args: (lockPath) => [
      "run",
      `--lock=${lockPath}`,
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      modPath,
      ...args,
    ],
  });
  return { code: output.code, stderr: decoder.decode(output.stderr) };
}

/** A mountpoint path the daemon must reject before ever creating. */
function unusedMountpoint(): string {
  return join(
    Deno.makeTempDirSync({ prefix: "cf-fuse-cli-test-" }),
    "never-mounted",
  );
}

Deno.test("daemon rejects an out-of-range attrcache-timeout", async () => {
  const mountpoint = unusedMountpoint();
  const { code, stderr } = await runDaemon([
    mountpoint,
    "--attrcache-timeout=-1",
  ]);

  assertEquals(code, 1);
  assertStringIncludes(stderr, "Invalid --attrcache-timeout value: -1");
  // The flags are rejected before the mountpoint is created.
  assertEquals(existsSync(mountpoint), false);
});

Deno.test("daemon rejects an attrcache-timeout whose value was dropped", async () => {
  // The argument parser does not read "-1" as this flag's value, and a mount
  // must not silently fall back to the default cache regime.
  const { code, stderr } = await runDaemon([
    unusedMountpoint(),
    "--attrcache-timeout",
    "-1",
  ]);

  assertEquals(code, 1);
  assertStringIncludes(stderr, "Missing value for --attrcache-timeout");
});

Deno.test("daemon rejects a non-integer attrcache-timeout", async () => {
  const { code, stderr } = await runDaemon([
    unusedMountpoint(),
    "--attrcache-timeout",
    "1.5",
  ]);

  assertEquals(code, 1);
  assertStringIncludes(stderr, "Invalid --attrcache-timeout value: 1.5");
});

Deno.test("daemon rejects both cache flags together", async () => {
  const { code, stderr } = await runDaemon([
    unusedMountpoint(),
    "--noattrcache",
    "--attrcache-timeout",
    "1",
  ]);

  assertEquals(code, 1);
  assertStringIncludes(
    stderr,
    "--noattrcache and --attrcache-timeout are mutually exclusive",
  );
});

Deno.test("daemon accepts the cache flags it supports", async () => {
  // A missing mountpoint is reported only once the flags have parsed, so
  // reaching the usage message proves the flags themselves were accepted.
  for (
    const accepted of [
      ["--noattrcache"],
      ["--attrcache-timeout", "0"],
      ["--attrcache-timeout", "86400"],
    ]
  ) {
    const { code, stderr } = await runDaemon(accepted);
    assertEquals(code, 1, `expected usage exit for ${accepted.join(" ")}`);
    assertStringIncludes(stderr, "Usage: mod.ts <mountpoint>");
  }
});
