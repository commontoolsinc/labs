import { assertEquals } from "@std/assert";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import {
  CAPABILITY_PROBE_SENTINEL,
  classifyBashToolFailure,
  classifyBuiltinToolFailure,
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
  SandboxRuntimeDescription,
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

class FakeFabricSandboxRuntime extends FakeSandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: {
        runtimeRequested: true,
        runtimeName: "runsc-cfc",
        workspaceMountPath: "/workspace",
        mounts: [
          { kind: "workspace", sandboxPath: "/workspace", readOnly: false },
          { kind: "fabric-fuse", sandboxPath: "/fabric", readOnly: false },
        ],
      },
    };
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
    cfc: {
      enforcementMode: "enforce-explicit",
      absenceBehavior: "permissive-if-absent",
      substrateStatus: "not-attested",
      runManifest: { present: false },
      sandbox: {
        kind: "docker-runsc-cfc",
        defaultWorkingDirectory: "/workspace",
        cfc: {
          runtimeRequested: true,
          workspaceMountPath: "/workspace",
        },
      },
      mounts: {
        workspace: {
          kind: "workspace",
          status: "configured",
          sandboxPath: "/workspace",
          readOnly: false,
        },
        fabric: {
          kind: "fabric-fuse",
          status: "not-configured",
          sandboxPath: "/fabric",
        },
      },
      protectedXattrs: {
        expectedSandboxVisible: false,
        sandboxVisibility: "not-probed",
      },
    },
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

Deno.test("collectHarnessCapabilitySnapshot reports configured Fabric mounts", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeFabricSandboxRuntime(),
    "/workspace",
    "2026-04-29T23:00:00.000Z",
  );

  assertEquals(snapshot.cfc.mounts, {
    workspace: {
      kind: "workspace",
      status: "configured",
      sandboxPath: "/workspace",
      readOnly: false,
    },
    fabric: {
      kind: "fabric-fuse",
      status: "configured",
      sandboxPath: "/fabric",
      readOnly: false,
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

Deno.test("classifyBashToolFailure prefers the missing subcommand from shell output", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeSandboxRuntime(),
    "/workspace",
    "2026-04-23T18:20:00.000Z",
  );

  const failure = classifyBashToolFailure(
    { command: "echo ok && python script.py" },
    {
      outputId: createToolOutputId("run-2", "bash", 1),
      stdout: "ok",
      stderr: "/bin/sh: python: command not found",
      exitCode: 127,
      cwd: "/workspace",
    },
    "2026-04-23T18:20:01.000Z",
    snapshot,
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "missing_binary",
    source: "tool_output",
    detail: "python is not available in the sandbox. python3 is available.",
    at: "2026-04-23T18:20:01.000Z",
    toolId: "bash",
    outputId: createToolOutputId("run-2", "bash", 1),
    command: "echo ok && python script.py",
    commandName: "python",
    exitCode: 127,
  });
});

Deno.test("classifyBuiltinToolFailure records host shell failures without sandbox capability claims", () => {
  const failure = classifyBuiltinToolFailure(
    "bash-no-sandbox",
    { command: "agent-browser --help" },
    {
      outputId: createToolOutputId("run-host", "bash-no-sandbox", 1),
      stdout: "",
      stderr: "bash: agent-browser: command not found",
      exitCode: 127,
      cwd: "/workspace",
    },
    "2026-04-23T18:25:00.000Z",
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "missing_binary",
    source: "tool_output",
    detail: "agent-browser was not found while executing a shell command.",
    at: "2026-04-23T18:25:00.000Z",
    toolId: "bash-no-sandbox",
    outputId: createToolOutputId("run-host", "bash-no-sandbox", 1),
    command: "agent-browser --help",
    commandName: "agent-browser",
    exitCode: 127,
  });
});

Deno.test("classifyBuiltinToolFailure records denied browser host commands", () => {
  const failure = classifyBuiltinToolFailure(
    "bash-no-sandbox",
    { command: "git status" },
    {
      outputId: createToolOutputId("run-host", "bash-no-sandbox", 1),
      stdout: "",
      stderr:
        "bash-no-sandbox command denied: git is not allowed in the browser host profile",
      exitCode: 126,
      cwd: "/workspace",
    },
    "2026-04-23T18:26:00.000Z",
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "tool_not_allowed",
    source: "tool_output",
    detail:
      "bash-no-sandbox command denied: git is not allowed in the browser host profile",
    at: "2026-04-23T18:26:00.000Z",
    toolId: "bash-no-sandbox",
    outputId: createToolOutputId("run-host", "bash-no-sandbox", 1),
    command: "git status",
    exitCode: 126,
  });
});

Deno.test("classifyBuiltinToolFailure handles delegate_task outputs defensively", () => {
  assertEquals(
    classifyBuiltinToolFailure(
      "delegate_task",
      {},
      {
        type: "cf-harness.delegate-task-output",
        outputId: createToolOutputId("run-delegate", "delegate_task", 1),
      },
      "2026-04-23T18:30:00.000Z",
    ),
    undefined,
  );

  assertEquals(
    classifyBuiltinToolFailure(
      "delegate_task",
      {},
      {
        type: "cf-harness.delegate-task-output",
        outputId: createToolOutputId("run-delegate", "delegate_task", 1),
        subagent: {
          type: "cf-harness.subagent-result",
          childRunId: "run-delegate.subagent.1",
          status: "failed",
          summary: "child failed",
          model: "gpt-5.4",
          modelTurns: 1,
          runState: {
            status: "failed",
            cfcEnforcementMode: "disabled",
            policyEventCounts: { total: 0, warnings: 0, denied: 0 },
            failureCount: 1,
          },
          manifest: {
            type: "cf-harness.subagent-run-manifest",
            version: 1,
            parentRunId: "run-delegate",
            parentToolCallId: "call-delegate",
            childRunId: "run-delegate.subagent.1",
            profile: "default",
            depth: 1,
            cfcEnforcementMode: "disabled",
            model: "gpt-5.4",
            allowedToolIds: ["bash", "read_file", "write_file"],
            hostToolIds: [],
            maxModelTurns: 8,
            returnPolicy: {
              type: "cf-harness.subagent-return-policy",
              channel: "summary-and-sanitized-state",
              includeSummary: true,
              includeSanitizedRunState: true,
              includeManifest: true,
              includeTranscript: false,
              includeRawFailureRecords: false,
            },
            createdAt: "2026-04-23T18:30:00.000Z",
            inputSummary: {
              type: "cf-harness.subagent-input-summary",
              goalBytes: 4,
              goalDigest: "sha256:test",
            },
          },
        },
      },
      "2026-04-23T18:30:01.000Z",
    ),
    {
      type: "cf-harness.failure-record",
      kind: "harness_error",
      source: "tool_output",
      detail: "subagent run-delegate.subagent.1 failed: child failed",
      at: "2026-04-23T18:30:01.000Z",
      toolId: "delegate_task",
      outputId: createToolOutputId("run-delegate", "delegate_task", 1),
    },
  );
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
  assertEquals(
    classifyHarnessRunError(
      new Error(
        "chat completion transport request failed after 2 attempts for https://llm.stage.commontools.dev/v1/chat/completions: error sending request from 100.87.21.105:52328 for https://llm.stage.commontools.dev/v1/chat/completions (10.128.15.193:443): client error (SendRequest): connection error: timed out",
      ),
      {
        at: "2026-04-22T23:30:02.000Z",
      },
    ).kind,
    "timeout",
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
