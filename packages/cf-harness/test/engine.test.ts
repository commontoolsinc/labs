import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { normalize } from "@std/path/posix";
import type { HarnessArtifactStore } from "../src/artifacts.ts";
import { createHarnessCfcPolicySnapshot } from "../src/contracts/cfc-policy-snapshot.ts";
import { createHarnessPolicyEvent } from "../src/contracts/policy.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

class FakeSandboxRuntime implements SandboxRuntime {
  readonly kind = "docker-runsc-cfc" as const;
  readonly shellRequests: SandboxShellRequest[] = [];

  constructor(
    private readonly shellResults: SandboxCommandResult[] = [],
    private readonly shellError?: Error,
  ) {}

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
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
    this.shellRequests.push(request);
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
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
    if (this.shellError) {
      return Promise.reject(this.shellError);
    }
    return Promise.resolve(
      this.shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

Deno.test("CfHarnessEngine builds a default docker-runsc sandbox when given a workspace path", () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    now: () => "2026-04-15T19:00:00.000Z",
  });

  assertEquals(engine.config.sandbox, undefined);
  assertEquals(engine.sandbox.kind, "docker-runsc-cfc");
  assertEquals(engine.getRunState(), {
    runId: engine.getRunState().runId,
    status: "pending",
    createdAt: "2026-04-15T19:00:00.000Z",
    updatedAt: "2026-04-15T19:00:00.000Z",
    cfcEnforcementMode: "enforce-explicit",
    currentDir: "/workspace",
    policyEvents: [],
    toolOutputs: [],
    failureRecords: [],
  });
});

Deno.test("CfHarnessEngine records tool outputs into run state on success", async () => {
  const sandbox = new FakeSandboxRuntime([
    { stdout: "one\n", stderr: "", exitCode: 0 },
    { stdout: "two\n", stderr: "", exitCode: 0 },
  ]);
  const engine = new CfHarnessEngine({
    sandboxRuntime: sandbox,
    runId: "run-1",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:00:00.000Z",
        "2026-04-15T19:00:01.000Z",
        "2026-04-15T19:00:02.000Z",
        "2026-04-15T19:00:03.000Z",
        "2026-04-15T19:00:04.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:00:05.000Z";
    })(),
  });

  const first = await engine.invokeBuiltinTool("bash", { command: "echo one" });
  const second = await engine.invokeBuiltinTool("bash", {
    command: "echo two",
  });

  assertEquals(first.resultRef, {
    type: "cf-harness.tool-result-ref",
    outputId: createToolOutputId("run-1", "bash", 1),
    toolId: "bash",
    runId: "run-1",
  });
  assertEquals(second.resultRef, {
    type: "cf-harness.tool-result-ref",
    outputId: createToolOutputId("run-1", "bash", 2),
    toolId: "bash",
    runId: "run-1",
  });
  assertEquals(engine.getRunState().runId, "run-1");
  assertEquals(engine.getRunState().status, "completed");
  assertEquals(engine.getRunState().createdAt, "2026-04-15T19:00:00.000Z");
  assertEquals(engine.getRunState().updatedAt, "2026-04-15T19:00:05.000Z");
  assertEquals(engine.getRunState().endedAt, "2026-04-15T19:00:05.000Z");
  assertEquals(engine.getRunState().terminalReason, "tool_completed");
  assertEquals(engine.getRunState().cfcEnforcementMode, "observe");
  assertEquals(engine.getRunState().currentDir, "/workspace");
  assertEquals(engine.getRunState().policyEvents, []);
  assertEquals(engine.getRunState().toolOutputs, [
    first.resultRef,
    second.resultRef,
  ]);
  assertEquals(engine.getRunState().failureRecords, []);
  assertEquals(
    engine.getRunState().capabilitySnapshot?.commands.python.present,
    false,
  );
  assertEquals(
    engine.getRunState().capabilitySnapshot?.commands.python3.path,
    "/usr/bin/python3",
  );
});

Deno.test("CfHarnessEngine records prompt slot binding into run state", () => {
  const promptSlotBinding = {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: { type: "test.prompt-slot", subject: "engine-test" },
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "test",
    subject: "engine-test",
    eventId: "event-engine",
  } as const;
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-prompt-slot",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-17T19:00:00.000Z",
        "2026-04-17T19:00:01.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-17T19:00:02.000Z";
    })(),
  });

  engine.setPromptSlotBinding(promptSlotBinding);

  assertEquals(engine.getRunState().promptSlotBinding, promptSlotBinding);
  assertEquals(engine.getRunState().updatedAt, "2026-04-17T19:00:01.000Z");
});

Deno.test("CfHarnessEngine stamps policy snapshot state changes with mutation time", async () => {
  const persistedStates: HarnessRunState[] = [];
  const runRoot = "/tmp/cf-harness-artifacts/run-policy-time";
  const artifactStore: HarnessArtifactStore = {
    artifactRoot: "/tmp/cf-harness-artifacts",
    runRoot,
    persistRunState(state) {
      persistedStates.push(structuredClone(state));
      return Promise.resolve(`${runRoot}/run-state.json`);
    },
    persistTranscript() {
      return Promise.resolve(`${runRoot}/transcript.json`);
    },
    persistCapabilitySnapshot() {
      return Promise.resolve(`${runRoot}/capabilities.json`);
    },
    persistCfcPolicySnapshot() {
      return Promise.reject(new Error("snapshot persist boom"));
    },
    persistRunReport() {
      return Promise.resolve(`${runRoot}/run-report.json`);
    },
    persistToolOutput() {
      return Promise.resolve(`${runRoot}/tool-output.json`);
    },
  };
  const engine = new CfHarnessEngine({
    artifactStore,
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-policy-time",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-17T20:30:00.000Z",
        "2026-04-17T20:30:01.000Z",
        "2026-04-17T20:30:02.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-17T20:30:03.000Z";
    })(),
  });
  const snapshot = createHarnessCfcPolicySnapshot({
    runId: "run-policy-time",
    generatedAt: "2026-04-17T20:00:00.000Z",
    cfcEnforcementMode: "observe",
    cfcEnforcementModeSource: "default",
    promptSlotBindingSource: "absent",
    parentToolAllowance: "restricted",
    allowedToolIds: ["read_file"],
    allowedSubagentProfiles: [],
    subagentProfileConfigs: [],
  });

  const snapshotPath = await engine.persistCfcPolicySnapshot(snapshot);

  assertEquals(snapshotPath, undefined);
  assertEquals(engine.getRunState().cfcPolicySnapshot, snapshot);
  assertEquals(engine.getRunState().cfcPolicySnapshotPath, undefined);
  assertEquals(
    engine.getRunState().failureRecords?.[0]?.source,
    "policy_snapshot",
  );
  assertEquals(
    engine.getRunState().failureRecords?.[0]?.at,
    "2026-04-17T20:30:01.000Z",
  );
  assertEquals(engine.getRunState().updatedAt, "2026-04-17T20:30:02.000Z");
  assertEquals(
    persistedStates.at(-1)?.updatedAt,
    "2026-04-17T20:30:02.000Z",
  );
});

Deno.test("CfHarnessEngine marks the run as failed when a tool invocation errors", async () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime([], new Error("sandbox boom")),
    runId: "run-fail",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:10:00.000Z",
        "2026-04-15T19:10:01.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:10:02.000Z";
    })(),
  });

  await assertRejects(
    () => engine.invokeBuiltinTool("bash", { command: "false" }),
    Error,
    "sandbox boom",
  );

  assertEquals(engine.getRunState().runId, "run-fail");
  assertEquals(engine.getRunState().status, "failed");
  assertEquals(engine.getRunState().createdAt, "2026-04-15T19:10:00.000Z");
  assertEquals(engine.getRunState().updatedAt, "2026-04-15T19:10:02.000Z");
  assertEquals(engine.getRunState().endedAt, "2026-04-15T19:10:02.000Z");
  assertEquals(engine.getRunState().terminalReason, "tool_error");
  assertEquals(engine.getRunState().cfcEnforcementMode, "observe");
  assertEquals(engine.getRunState().currentDir, "/workspace");
  assertEquals(engine.getRunState().policyEvents, []);
  assertEquals(engine.getRunState().toolOutputs, []);
  assertEquals(engine.getRunState().failureRecords?.length, 1);
  assertEquals(engine.getRunState().primaryFailure?.kind, "unknown");
});

Deno.test("CfHarnessEngine records recoverable file-tool failures without failing the run", async () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime([{
      stdout: "",
      stderr: "file not found: /workspace/notes/missing.txt",
      exitCode: 10,
    }]),
    runId: "run-file-missing",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:15:00.000Z",
        "2026-04-15T19:15:01.000Z",
        "2026-04-15T19:15:02.000Z",
        "2026-04-15T19:15:03.000Z",
        "2026-04-15T19:15:04.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:15:05.000Z";
    })(),
  });

  const result = await engine.invokeBuiltinTool("read_file", {
    path: "notes/missing.txt",
  });

  assertEquals(result.output, {
    outputId: createToolOutputId("run-file-missing", "read_file", 1),
    path: "/workspace/notes/missing.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "file_not_found",
      message: "file not found: /workspace/notes/missing.txt",
      path: "/workspace/notes/missing.txt",
      detail: "file not found: /workspace/notes/missing.txt",
      exitCode: 10,
    },
  });
  assertEquals(engine.getRunState().status, "completed");
  assertEquals(engine.getRunState().terminalReason, "tool_completed");
  assertEquals(engine.getRunState().toolOutputs, [result.resultRef]);
  assertEquals(engine.getRunState().failureRecords?.length, 1);
  assertEquals(
    engine.getRunState().failureRecords?.[0]?.kind,
    "file_not_found",
  );
  assertEquals(engine.getRunState().failureRecords?.[0]?.source, "tool_output");
  assertEquals(engine.getRunState().failureRecords?.[0]?.toolId, "read_file");
  assertEquals(
    engine.getRunState().failureRecords?.[0]?.outputId,
    createToolOutputId("run-file-missing", "read_file", 1),
  );
  assertEquals(engine.getRunState().primaryFailure?.kind, "file_not_found");
});

Deno.test("CfHarnessEngine terminalizes interrupted runs even after an intermediate tool completion", async () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime([
      { stdout: "done\n", stderr: "", exitCode: 0 },
    ]),
    runId: "run-interrupted",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:20:00.000Z",
        "2026-04-15T19:20:01.000Z",
        "2026-04-15T19:20:02.000Z",
        "2026-04-15T19:20:03.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:20:04.000Z";
    })(),
  });

  await engine.invokeBuiltinTool("bash", { command: "echo done" });
  assertEquals(engine.getRunState().status, "completed");
  assertEquals(engine.getRunState().terminalReason, "tool_completed");

  await engine.terminalizeInterruptedRun("SIGTERM");

  assertEquals(engine.getRunState().status, "failed");
  assertEquals(engine.getRunState().updatedAt, "2026-04-15T19:20:04.000Z");
  assertEquals(engine.getRunState().endedAt, "2026-04-15T19:20:04.000Z");
  assertEquals(engine.getRunState().terminalReason, "process_interrupted");
  assertEquals(engine.getRunState().failureRecords?.at(-1), {
    type: "cf-harness.failure-record",
    kind: "harness_error",
    source: "run_error",
    detail: "process received SIGTERM before the prompt loop completed",
    at: "2026-04-15T19:20:04.000Z",
  });
  assertEquals(engine.getRunState().primaryFailure?.kind, "harness_error");
});

Deno.test("CfHarnessEngine getRunState returns a deep clone", () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runState: {
      runId: "run-clone",
      status: "completed",
      createdAt: "2026-04-17T20:10:00.000Z",
      updatedAt: "2026-04-17T20:10:01.000Z",
      endedAt: "2026-04-17T20:10:01.000Z",
      terminalReason: "tool_completed",
      cfcEnforcementMode: "observe",
      currentDir: "/workspace",
      policyEvents: [createHarnessPolicyEvent({
        severity: "warning",
        mode: "observe",
        toolId: "bash",
        detail: "warning detail",
        at: "2026-04-17T20:10:01.000Z",
      })],
      toolOutputs: [{
        type: "cf-harness.tool-result-ref",
        outputId: createToolOutputId("run-clone", "bash", 1),
        toolId: "bash",
        runId: "run-clone",
        artifactPath: "/tmp/original.json",
      }],
      failureRecords: [],
    },
  });

  const snapshot = engine.getRunState();
  snapshot.policyEvents[0].detail = "mutated";
  snapshot.toolOutputs[0].artifactPath = "/tmp/mutated.json";

  assertEquals(engine.getRunState(), {
    runId: "run-clone",
    status: "completed",
    createdAt: "2026-04-17T20:10:00.000Z",
    updatedAt: "2026-04-17T20:10:01.000Z",
    endedAt: "2026-04-17T20:10:01.000Z",
    terminalReason: "tool_completed",
    cfcEnforcementMode: "observe",
    currentDir: "/workspace",
    policyEvents: [createHarnessPolicyEvent({
      severity: "warning",
      mode: "observe",
      toolId: "bash",
      detail: "warning detail",
      at: "2026-04-17T20:10:01.000Z",
    })],
    toolOutputs: [{
      type: "cf-harness.tool-result-ref",
      outputId: createToolOutputId("run-clone", "bash", 1),
      toolId: "bash",
      runId: "run-clone",
      artifactPath: "/tmp/original.json",
    }],
    failureRecords: [],
  });
});

Deno.test("CfHarnessEngine rejects legacy run state snapshots without currentDir", () => {
  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState: {
          runId: "run-legacy",
          status: "completed",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:01.000Z",
          cfcEnforcementMode: "observe",
          policyEvents: [],
          toolOutputs: [],
          failureRecords: [],
        } as unknown as HarnessRunState,
      }),
    Error,
    "older cf-harness runs cannot be resumed",
  );
});
