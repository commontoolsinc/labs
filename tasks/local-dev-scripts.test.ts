import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as path from "@std/path";

import ports from "@commonfabric/ports" with { type: "json" };

const repoRoot = path.resolve(import.meta.dirname!, "..");

// `scripts/start-local-dev.sh` reports this when a port it was asked for is one
// clients refuse to connect to.
const PORT_UNREACHABLE_EXIT = 4;

// The offset that puts the shell dev server on port 6000.
const UNREACHABLE_SHELL_OFFSET = 6000 - ports.shell;

// An offset whose servers every client will talk to.
const REACHABLE_OFFSET = 850;

/**
 * Run one of the local dev scripts with a `deno` that exits immediately, so a
 * run that gets as far as launching a server starts nothing and leaves nothing
 * behind.
 */
async function runScript(
  script: string,
  offset: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const binDir = await Deno.makeTempDir();
  const stub = path.join(binDir, "deno");
  await Deno.writeTextFile(stub, "#!/bin/sh\nexit 1\n");
  await Deno.chmod(stub, 0o755);
  try {
    const { code, stdout, stderr } = await new Deno.Command("bash", {
      args: [`scripts/${script}`, "--port-offset", String(offset)],
      cwd: repoRoot,
      env: { PATH: `${binDir}:${Deno.env.get("PATH")}` },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    return {
      code,
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
    };
  } finally {
    await Deno.remove(binDir, { recursive: true });
  }
}

describe("local-dev-scripts", () => {
  describe("start-local-dev.sh", () => {
    it("names the server and the port an offset makes unreachable", async () => {
      const { code, stderr } = await runScript(
        "start-local-dev.sh",
        UNREACHABLE_SHELL_OFFSET,
      );
      expect(code).toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("shell port 6000");
    });

    it("reaches the server launch on a reachable offset", async () => {
      const { code, stderr } = await runScript(
        "start-local-dev.sh",
        REACHABLE_OFFSET,
      );
      expect(code).not.toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("shell exited before it became ready");
    });
  });

  describe("restart-local-dev.sh", () => {
    it("refuses an unreachable offset before it stops a server", async () => {
      const { code, stdout, stderr } = await runScript(
        "restart-local-dev.sh",
        UNREACHABLE_SHELL_OFFSET,
      );
      expect(code).toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("shell port 6000");
      // The stop, and the cache and space clearing behind its flags, all
      // follow this line.
      expect(stdout).not.toContain("Stopping local dev servers");
    });
  });
});
