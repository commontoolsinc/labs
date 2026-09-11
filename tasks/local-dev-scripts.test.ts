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

// The offset that puts the inspector on port 10080, leaving the shell and the
// toolshed on ports every client will talk to.
const UNREACHABLE_INSPECTOR_OFFSET = 10080 - ports.inspector;

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
  options: { args?: string[]; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const binDir = await Deno.makeTempDir();
  const stub = path.join(binDir, "deno");
  await Deno.writeTextFile(stub, "#!/bin/sh\nexit 1\n");
  await Deno.chmod(stub, 0o755);
  try {
    const { code, stdout, stderr } = await new Deno.Command("bash", {
      args: [
        `scripts/${script}`,
        ...(options.args ?? []),
        "--port-offset",
        String(offset),
      ],
      cwd: repoRoot,
      env: { ...options.env, PATH: `${binDir}:${Deno.env.get("PATH")}` },
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

/**
 * Run a bash snippet with the local dev scripts' shared port utilities
 * sourced, and return what it printed.
 */
async function runWithPortUtils(script: string): Promise<string> {
  const { stdout } = await new Deno.Command("bash", {
    args: ["-c", `source scripts/common/port-utils.sh\n${script}`],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  return new TextDecoder().decode(stdout).trim();
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

    it("answers from the recorded list, not from the environment", async () => {
      const { code, stderr } = await runScript(
        "start-local-dev.sh",
        UNREACHABLE_SHELL_OFFSET,
        { env: { BLOCKED_PORTS: "1" } },
      );
      expect(code).toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("shell port 6000");
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

    it("refuses an inspector port an --inspect run would bind", async () => {
      const { code, stdout, stderr } = await runScript(
        "restart-local-dev.sh",
        UNREACHABLE_INSPECTOR_OFFSET,
        { args: ["--inspect"] },
      );
      expect(code).toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("inspector port 10080");
      expect(stdout).not.toContain("Stopping local dev servers");
    });
  });

  describe("port-utils.sh", () => {
    describe("foreign_port_holder()", () => {
      // Each case listens on a port here, so the pid the utility has to find
      // is one the test already knows: this process.

      it("returns nothing for a port the given pid listens on", async () => {
        const listener = Deno.listen({ port: 0 });
        try {
          expect(
            await runWithPortUtils(
              `foreign_port_holder ${listener.addr.port} ${Deno.pid}`,
            ),
          ).toBe("");
        } finally {
          listener.close();
        }
      });

      it("returns nothing for a port a descendant of the given pid listens on", async () => {
        // `Deno.ppid` is the process that spawned this one, so the
        // listener below is a descendant of it rather than the pid itself.
        const listener = Deno.listen({ port: 0 });
        try {
          expect(
            await runWithPortUtils(
              `foreign_port_holder ${listener.addr.port} ${Deno.ppid}`,
            ),
          ).toBe("");
        } finally {
          listener.close();
        }
      });

      it("returns the listening pid for a port held outside the given pid's tree", async () => {
        // `$$` is the bash the snippet runs in, a child of this process and so
        // an ancestor of nothing that listens here.
        const listener = Deno.listen({ port: 0 });
        try {
          expect(
            await runWithPortUtils(
              `foreign_port_holder ${listener.addr.port} $$`,
            ),
          ).toBe(String(Deno.pid));
        } finally {
          listener.close();
        }
      });
    });
  });
});
