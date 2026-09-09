import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { readSpool } from "@commonfabric/test-support/records";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

// Runs the wrapper as CI does: joined to a spool through the environment,
// with the wrapped child spawned from the Deno under test.
async function runRecorded(
  spoolDir: string,
  args: string[],
): Promise<Deno.CommandOutput> {
  return await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--lock",
      lockPath,
      "-A",
      "tasks/run-recorded.ts",
      ...args,
    ],
    env: { CF_TEST_RECORDS_DIR: spoolDir },
  });
}

describe("run-recorded", () => {
  let spoolDir: string;

  beforeEach(async () => {
    spoolDir = await Deno.makeTempDir({ prefix: "run-recorded-spool-" });
  });

  afterEach(async () => {
    await Deno.remove(spoolDir, { recursive: true }).catch(() => {});
  });

  it("runs the command and records a pass with its exit code", async () => {
    const output = await runRecorded(spoolDir, [
      "gate",
      "repo",
      "probe-pass",
      "--",
      Deno.execPath(),
      "eval",
      "console.log('hello from the child')",
    ]);
    expect(output.code).toBe(0);
    expect(new TextDecoder().decode(output.stdout)).toContain(
      "hello from the child",
    );
    const spool = await readSpool(spoolDir);
    expect(spool.records).toEqual([{
      line: "record",
      test: { k: "gate", s: "repo", n: "probe-pass" },
      outcome: "pass",
      durationMs: spool.records[0]!.durationMs,
    }]);
  });

  it("propagates the child's exit code and records a fail", async () => {
    const output = await runRecorded(spoolDir, [
      "gate",
      "repo",
      "probe-fail",
      "--",
      Deno.execPath(),
      "eval",
      "Deno.exit(3)",
    ]);
    expect(output.code).toBe(3);
    const spool = await readSpool(spoolDir);
    expect(spool.records[0]?.outcome).toBe("fail");
  });

  it({
    name: "reports the signal that terminated the command",
    ignore: Deno.build.os === "windows",
    async fn() {
      const output = await runRecorded(spoolDir, [
        "gate",
        "repo",
        "probe-signal",
        "--",
        "/bin/sh",
        "-c",
        "kill -TERM $$",
      ]);
      expect(output.code).toBe(143);
      expect(new TextDecoder().decode(output.stderr)).toContain(
        "run-recorded: `/bin/sh` terminated by `SIGTERM`.",
      );
      const spool = await readSpool(spoolDir);
      expect(spool.records[0]?.outcome).toBe("fail");
    },
  });

  it("records a fail with code 127 for an unrunnable command", async () => {
    const output = await runRecorded(spoolDir, [
      "gate",
      "repo",
      "probe-missing",
      "--",
      "/no/such/binary",
    ]);
    expect(output.code).toBe(127);
    const spool = await readSpool(spoolDir);
    expect(spool.records[0]?.outcome).toBe("fail");
  });

  it("rejects an empty identity component as a usage error", async () => {
    const output = await runRecorded(spoolDir, [
      "gate",
      "",
      "probe-empty",
      "--",
      Deno.execPath(),
      "eval",
      "",
    ]);
    expect(output.code).toBe(2);
    expect(new TextDecoder().decode(output.stderr)).toContain("usage:");
    const spool = await readSpool(spoolDir);
    expect(spool.records).toEqual([]);
  });
});
