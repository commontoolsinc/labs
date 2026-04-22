import { assertEquals } from "@std/assert";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import {
  CAPABILITY_PROBE_SENTINEL,
  classifyBashToolFailure,
  classifyHarnessPolicyEventFailure,
  classifyHarnessRunError,
  collectHarnessCapabilitySnapshot,
  createHarnessFailureRecord,
  selectPrimaryHarnessFailure,
} from "../src/diagnostics.ts";
import { createHarnessPolicyEvent } from "../src/contracts/policy.ts";
import { ProcessTimeoutError } from "../src/sandbox/process-runner.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

class FakeSandboxRuntime implements SandboxRuntime {
  readonly kind = "docker-runsc-cfc" as const;

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return path.startsWith("/") ? path : `${cwd}/${path}`;
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    if (!request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      throw new Error("unexpected shell request");
    }
    return Promise.resolve({
      stdout: [
        "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        "sh\tpresent\t/bin/sh\tBusyBox v1.36.1",
        "node\tmissing\t\t",
        "deno\tpresent\t/usr/local/bin/deno\tdeno 2.2.0",
        "python\tmissing\t\t",
        "python3\tpresent\t/usr/bin/python3\tPython 3.11.9",
        "git\tpresent\t/usr/bin/git\tgit version 2.45.1",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });
  }
}

Deno.test("collectHarnessCapabilitySnapshot captures fixed sandbox capabilities", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeSandboxRuntime(),
    "/workspace",
    "2026-04-22T23:00:00.000Z",
  );

  assertEquals(snapshot, {
    type: "cf-harness.capability-snapshot",
    at: "2026-04-22T23:00:00.000Z",
    commands: {
      bash: {
        present: true,
        path: "/bin/bash",
        version: "GNU bash, version 5.2.26(1)-release",
      },
      sh: {
        present: true,
        path: "/bin/sh",
        version: "BusyBox v1.36.1",
      },
      node: { present: false },
      deno: {
        present: true,
        path: "/usr/local/bin/deno",
        version: "deno 2.2.0",
      },
      python: { present: false },
      python3: {
        present: true,
        path: "/usr/bin/python3",
        version: "Python 3.11.9",
      },
      git: {
        present: true,
        path: "/usr/bin/git",
        version: "git version 2.45.1",
      },
    },
  });
});

Deno.test("classifyHarnessPolicyEventFailure records denied tool usage", () => {
  const failure = classifyHarnessPolicyEventFailure(
    createHarnessPolicyEvent({
      severity: "denied",
      mode: "enforce-explicit",
      toolId: "write_file",
      toolCallId: "call-1",
      detail: "write_file requires direct-command authorization",
      at: "2026-04-22T23:10:00.000Z",
    }),
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "tool_not_allowed",
    source: "policy_event",
    detail: "write_file requires direct-command authorization",
    at: "2026-04-22T23:10:00.000Z",
    toolId: "write_file",
    toolCallId: "call-1",
  });
});

Deno.test("classifyBashToolFailure uses the capability snapshot to explain missing python", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeSandboxRuntime(),
    "/workspace",
    "2026-04-22T23:20:00.000Z",
  );

  const failure = classifyBashToolFailure(
    { command: "python script.py" },
    {
      outputId: createToolOutputId("run-1", "bash", 1),
      stdout: "",
      stderr: "/bin/sh: python: command not found",
      exitCode: 127,
      cwd: "/workspace",
    },
    "2026-04-22T23:20:01.000Z",
    snapshot,
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "missing_binary",
    source: "tool_output",
    detail: "python is not available in the sandbox. python3 is available.",
    at: "2026-04-22T23:20:01.000Z",
    toolId: "bash",
    outputId: createToolOutputId("run-1", "bash", 1),
    command: "python script.py",
    commandName: "python",
    exitCode: 127,
  });
});

Deno.test("classifyHarnessRunError maps timeouts and path escapes deterministically", () => {
  assertEquals(
    classifyHarnessRunError(
      new ProcessTimeoutError("docker run ...", 5000),
      {
        at: "2026-04-22T23:30:00.000Z",
        toolId: "bash",
      },
    ).kind,
    "timeout",
  );
  assertEquals(
    classifyHarnessRunError(
      new Error("path escapes workspace root: ../../etc/passwd"),
      {
        at: "2026-04-22T23:30:01.000Z",
        toolId: "read_file",
      },
    ).kind,
    "workspace_path_confusion",
  );
});

Deno.test("selectPrimaryHarnessFailure prefers the highest-signal failure kind", () => {
  const primary = selectPrimaryHarnessFailure([
    createHarnessFailureRecord({
      kind: "unknown",
      source: "run_error",
      detail: "gateway boom",
      at: "2026-04-22T23:40:00.000Z",
    }),
    createHarnessFailureRecord({
      kind: "missing_binary",
      source: "tool_output",
      detail: "python is not available in the sandbox",
      at: "2026-04-22T23:40:01.000Z",
      toolId: "bash",
    }),
    createHarnessFailureRecord({
      kind: "tool_not_allowed",
      source: "policy_event",
      detail: "write_file requires direct-command authorization",
      at: "2026-04-22T23:40:02.000Z",
      toolId: "write_file",
    }),
  ]);

  assertEquals(primary?.kind, "tool_not_allowed");
});
