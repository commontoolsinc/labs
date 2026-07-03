import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { normalize } from "@std/path/posix";
import type { HarnessArtifactStore } from "../src/artifacts.ts";
import { CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE } from "../src/contracts/cfc-invocation-context.ts";
import { createHarnessCfcPolicySnapshot } from "../src/contracts/cfc-policy-snapshot.ts";
import { createHarnessPolicyEvent } from "../src/contracts/policy.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import type { HarnessSkillResourceReads } from "../src/contracts/skill.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import { RESERVED_ARTIFACT_PATH_DETAIL } from "../src/tools/reserved-artifacts.ts";
import { resolveDockerRunscSandboxConfig } from "../src/sandbox/docker-runsc.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";
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

class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = [];

  constructor(
    private readonly results: ProcessRunResult[] = [{
      stdout: "",
      stderr: "",
      exitCode: 0,
    }],
  ) {}

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request);
    return Promise.resolve(
      this.results.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
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

Deno.test("CfHarnessEngine accepts a default sandbox image override", () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    sandboxImage: "registry.example/cf:deno2",
  });

  assertEquals(
    engine.sandbox.describe?.()?.cfc?.image,
    "registry.example/cf:deno2",
  );
});

Deno.test("CfHarnessEngine constructs in enforce mode without CFC transports", () => {
  // Construction must stay cheap and inspectable; the transport floor is only
  // enforced once the run starts — at diagnostics init (capability probes) or
  // the first tool call, whichever comes first (see the run-start tests below).
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-strict",
  });
  assertEquals(engine.getRunState().cfcEnforcementMode, "enforce-strict");
});

Deno.test("CfHarnessEngine refuses to run a tool in enforce mode without CFC transports", async () => {
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-explicit",
  });
  await assertRejects(
    () => engine.invokeBuiltinTool("bash", { command: "echo hi" }),
    Error,
    "requires the runsc sandbox to wire",
  );
});

Deno.test("CfHarnessEngine refuses to run capability probes in enforce mode without CFC transports", async () => {
  // The prompt loop initializes diagnostics before the first model turn, and
  // the capability probes execute scripts inside the sandbox — so the
  // transport floor must fire before any sandbox execution, not only at the
  // first builtin tool call. The probe error swallowing inside diagnostics
  // init must not absorb the floor violation into a failure record.
  const runner = new FakeProcessRunner();
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-explicit",
    processRunner: runner,
  });
  await assertRejects(
    () => engine.ensureDiagnosticsInitialized(),
    Error,
    "requires the runsc sandbox to wire",
  );
  // Nothing reached the docker lifecycle: the run failed closed before any
  // sandbox execution.
  assertEquals(runner.calls.length, 0);
});

Deno.test("CfHarnessEngine runs a tool in enforce mode when CFC transports are wired", async () => {
  const cfcResultDir = await Deno.makeTempDir({ prefix: "cf-harness-result-" });
  const cfcInvocationContextDir = await Deno.makeTempDir({
    prefix: "cf-harness-ctx-",
  });
  const runner = new FakeProcessRunner([
    { stdout: "container-1\n", stderr: "", exitCode: 0 },
    { stdout: "hi\n", stderr: "", exitCode: 0 },
    { stdout: "0\n", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-explicit",
    cfcResultDir,
    cfcInvocationContextDir,
    processRunner: runner,
  });
  // The guard does not fire; execution reaches the (faked) docker lifecycle
  // (the exact mediated output is covered elsewhere — here we only assert the
  // transport floor lets the run proceed and an outputId is produced).
  const result = await engine.invokeBuiltinTool("bash", { command: "echo hi" });
  assertEquals(typeof result.output.outputId, "string");
});

Deno.test("CfHarnessEngine does not apply the CFC transport floor to an injected sandbox runtime", async () => {
  // An injected sandboxRuntime is the thing that actually executes and carries
  // its own enforcement guarantees. The engine must not validate the *resolved
  // config's* transports against it: that config is unused here and may describe
  // a different sandbox, so doing so would falsely reject an otherwise valid
  // enforce-mode run. (Regression for the run-start transport floor.)
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-strict",
    // A docker-runsc-cfc config with no CFC sidecar transports wired.
    sandbox: resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
    }),
    sandboxRuntime: new FakeSandboxRuntime(),
  });
  const result = await engine.invokeBuiltinTool("bash", { command: "echo hi" });
  assertEquals(typeof result.output.outputId, "string");
});

Deno.test("CfHarnessEngine lets bash-no-sandbox host commands handle missing workspace paths", async () => {
  const workspaceHostPath = await Deno.makeTempDir({
    prefix: "cf-harness-engine-missing-",
  });
  const runner = new FakeProcessRunner([{
    stdout: "",
    stderr: "ls: missing.txt: No such file or directory\n",
    exitCode: 1,
  }]);
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath,
    sandboxRuntime: new FakeSandboxRuntime(),
    processRunner: runner,
    cfcEnforcementMode: "observe",
    now: () => "2026-04-29T23:20:00.000Z",
  });

  const result = await engine.invokeBuiltinTool("bash-no-sandbox", {
    command: "ls missing.txt",
  });

  assertEquals(runner.calls, [{
    command: "ls",
    args: ["missing.txt"],
    cwd: workspaceHostPath,
    clearEnv: true,
    env: { PATH: runner.calls[0]!.env!.PATH },
    timeoutMs: 30_000,
  }]);
  assertEquals(result.output, {
    outputId: "run-1:bash-no-sandbox:1",
    stdout: "",
    stderr: "ls: missing.txt: No such file or directory\n",
    exitCode: 1,
    cwd: "/workspace",
  });
});

Deno.test("CfHarnessEngine denies bash-no-sandbox missing paths below escaping symlinks", async () => {
  const workspaceHostPath = await Deno.makeTempDir({
    prefix: "cf-harness-engine-workspace-",
  });
  const outsideHostPath = await Deno.makeTempDir({
    prefix: "cf-harness-engine-outside-",
  });
  await Deno.symlink(
    outsideHostPath,
    `${workspaceHostPath}/outside-link`,
    { type: "dir" },
  );
  const runner = new FakeProcessRunner();
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath,
    sandboxRuntime: new FakeSandboxRuntime(),
    processRunner: runner,
    cfcEnforcementMode: "observe",
    now: () => "2026-04-29T23:20:00.000Z",
  });

  const result = await engine.invokeBuiltinTool("bash-no-sandbox", {
    command: "ls outside-link/missing.txt",
  });

  assertEquals(runner.calls, []);
  assertEquals(result.output, {
    outputId: "run-1:bash-no-sandbox:1",
    stdout: "",
    stderr:
      "bash-no-sandbox command denied: path outside-link/missing.txt must resolve within or below the workspace",
    exitCode: 126,
    cwd: "/workspace",
  });
});

Deno.test("CfHarnessEngine reserves artifact roots through host realpath mapping", async () => {
  const workspaceHostPath = await Deno.makeTempDir({
    prefix: "cf-harness-engine-artifacts-",
  });
  try {
    const artifactRoot = `${workspaceHostPath}/.cf-harness-artifacts`;
    const artifactLink = `${workspaceHostPath}/artifact-link`;
    await Deno.mkdir(artifactRoot, { recursive: true });
    await Deno.symlink(artifactRoot, artifactLink, { type: "dir" });
    const sandbox = new FakeSandboxRuntime();
    const hostRunner = new FakeProcessRunner();
    const engine = new CfHarnessEngine({
      runId: "run-artifact-reserved",
      workspaceHostPath,
      artifactRoot,
      sandboxRuntime: sandbox,
      processRunner: hostRunner,
      cfcEnforcementMode: "observe",
      now: (() => {
        const timestamps = [
          "2026-05-01T17:55:00.000Z",
          "2026-05-01T17:55:01.000Z",
          "2026-05-01T17:55:02.000Z",
          "2026-05-01T17:55:03.000Z",
          "2026-05-01T17:55:04.000Z",
          "2026-05-01T17:55:05.000Z",
          "2026-05-01T17:55:06.000Z",
        ];
        return () => timestamps.shift() ?? "2026-05-01T17:55:07.000Z";
      })(),
    });

    const readResult = await engine.invokeBuiltinTool("read_file", {
      path: "artifact-link/run-state.json",
    });
    const lsResult = await engine.invokeBuiltinTool("bash-no-sandbox", {
      command: "ls artifact-link",
    });

    assertEquals(readResult.output, {
      outputId: createToolOutputId(
        "run-artifact-reserved",
        "read_file",
        1,
      ),
      path: "/workspace/artifact-link/run-state.json",
      ok: false,
      error: {
        type: "cf-harness.structured-file-tool-error",
        code: "permission_denied",
        message: "permission denied: /workspace/artifact-link/run-state.json",
        path: "/workspace/artifact-link/run-state.json",
        detail: RESERVED_ARTIFACT_PATH_DETAIL,
      },
    });
    assertEquals(lsResult.output, {
      outputId: createToolOutputId(
        "run-artifact-reserved",
        "bash-no-sandbox",
        2,
      ),
      stdout: "",
      stderr:
        "bash-no-sandbox command denied: path artifact-link is reserved for cf-harness artifacts",
      exitCode: 126,
      cwd: "/workspace",
    });
    assertEquals(hostRunner.calls, []);
    assertEquals(sandbox.shellRequests.length, 1);
    assertEquals(
      sandbox.shellRequests.every((request) =>
        request.command.includes(CAPABILITY_PROBE_SENTINEL)
      ),
      true,
    );
  } finally {
    await Deno.remove(workspaceHostPath, { recursive: true });
  }
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

Deno.test("CfHarnessEngine derives prompt-slot labels for model-authored sandbox invocation inputs", async () => {
  const promptSlotBinding = {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: { type: "test.prompt-slot", subject: "engine-label-test" },
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "test",
    eventId: "event-engine-label",
  } as const;
  const sandbox = new FakeSandboxRuntime([
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const engine = new CfHarnessEngine({
    sandboxRuntime: sandbox,
    runId: "run-prompt-slot-labels",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-17T19:05:00.000Z",
        "2026-04-17T19:05:01.000Z",
        "2026-04-17T19:05:02.000Z",
        "2026-04-17T19:05:03.000Z",
        "2026-04-17T19:05:04.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-17T19:05:05.000Z";
    })(),
  });

  engine.setPromptSlotBinding(promptSlotBinding);
  await engine.invokeBuiltinTool("bash", {
    command: "printf hello",
    cwd: "task-dir",
  });
  await engine.invokeBuiltinTool("write_file", {
    path: "notes.md",
    content: "hello from prompt",
  });

  const expectedAtom = {
    type: CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE,
    version: 1,
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "test",
    eventId: "event-engine-label",
  };
  assertEquals(
    engine.getRunState().cfcInvocationContexts?.map((context) => ({
      toolId: context.toolId,
      labels: context.cfcInputLabels,
    })),
    [
      {
        toolId: "bash",
        labels: {
          version: 1,
          entries: [
            {
              path: ["command"],
              label: { confidentiality: [expectedAtom] },
            },
            {
              path: ["cwd"],
              label: { confidentiality: [expectedAtom] },
            },
          ],
        },
      },
      {
        toolId: "write_file",
        labels: {
          version: 1,
          entries: [
            {
              path: ["args"],
              label: { confidentiality: [expectedAtom] },
            },
            {
              path: ["stdin"],
              label: { confidentiality: [expectedAtom] },
            },
          ],
        },
      },
    ],
  );
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
    persistPolicyTrace() {
      return Promise.resolve(`${runRoot}/policy-trace.json`);
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

Deno.test("CfHarnessEngine persists skill resource read artifacts", async () => {
  const persistedStates: HarnessRunState[] = [];
  const persistedReads: HarnessSkillResourceReads[] = [];
  const runRoot = "/tmp/cf-harness-artifacts/run-skill-resource-read";
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
      return Promise.resolve(`${runRoot}/policy-snapshot.json`);
    },
    persistPolicyTrace() {
      return Promise.resolve(`${runRoot}/policy-trace.json`);
    },
    persistRunReport() {
      return Promise.resolve(`${runRoot}/run-report.json`);
    },
    persistSkillResourceReads(reads) {
      persistedReads.push(structuredClone(reads));
      return Promise.resolve(`${runRoot}/skill-resource-reads.json`);
    },
    persistToolOutput() {
      return Promise.resolve(`${runRoot}/tool-output.json`);
    },
  };
  const engine = new CfHarnessEngine({
    artifactStore,
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-skill-resource-read",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-05-01T17:00:00.000Z",
        "2026-05-01T17:00:01.000Z",
      ];
      return () => timestamps.shift() ?? "2026-05-01T17:00:02.000Z";
    })(),
  });

  const path = await engine.recordSkillResourceRead({
    type: "cf-harness.skill-resource-read",
    outputId: "run-skill-resource-read:read_skill_resource:1",
    runId: "run-skill-resource-read",
    skillName: "pattern-dev",
    path: "references/guide.md",
    status: "read",
    readAt: "2026-05-01T17:00:01.000Z",
    cfcPromptRole: "context",
    diagnostics: [],
  });

  assertEquals(path, `${runRoot}/skill-resource-reads.json`);
  assertEquals(persistedReads, [{
    type: "cf-harness.skill-resource-reads",
    version: 1,
    generatedAt: "2026-05-01T17:00:01.000Z",
    reads: [{
      type: "cf-harness.skill-resource-read",
      outputId: "run-skill-resource-read:read_skill_resource:1",
      runId: "run-skill-resource-read",
      skillName: "pattern-dev",
      path: "references/guide.md",
      status: "read",
      readAt: "2026-05-01T17:00:01.000Z",
      cfcPromptRole: "context",
      diagnostics: [],
    }],
  }]);
  assertEquals(
    engine.getRunState().skillResourceReadsPath,
    `${runRoot}/skill-resource-reads.json`,
  );
  assertEquals(persistedStates.at(-1)?.skillResourceReadsPath, path);
});

Deno.test("CfHarnessEngine timestamps CFC invocation contexts with mutation time", async () => {
  const persistedStates: HarnessRunState[] = [];
  const runRoot = "/tmp/cf-harness-artifacts/run-cfc-invocation-time";
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
      return Promise.resolve(`${runRoot}/policy-snapshot.json`);
    },
    persistPolicyTrace() {
      return Promise.resolve(`${runRoot}/policy-trace.json`);
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
    sandboxRuntime: new FakeSandboxRuntime([{
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    }]),
    runId: "run-cfc-invocation-time",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-17T21:00:00.000Z",
        "2026-04-17T21:00:01.000Z",
        "2026-04-17T21:00:02.000Z",
        "2026-04-17T21:00:03.000Z",
        "2026-04-17T21:00:04.000Z",
        "2026-04-17T21:00:05.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-17T21:00:06.000Z";
    })(),
  });

  await engine.invokeBuiltinTool("read_file", { path: "notes/todo.txt" });

  const invocationState = persistedStates.find((state) =>
    state.cfcInvocationContexts?.length === 1 &&
    state.toolOutputs.length === 0
  );
  assertEquals(invocationState?.updatedAt, "2026-04-17T21:00:04.000Z");
  assertEquals(
    invocationState?.cfcInvocationContexts?.[0]?.createdAt,
    "2026-04-17T21:00:04.000Z",
  );
  assertEquals(engine.getRunState().updatedAt, "2026-04-17T21:00:05.000Z");
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
  const legacyRunState = {
    runId: "run-legacy",
    status: "completed",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:01.000Z",
    cfcEnforcementMode: "observe",
    policyEvents: [],
    toolOutputs: [],
    failureRecords: [],
  } satisfies Omit<HarnessRunState, "currentDir">;

  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState: legacyRunState,
      }),
    Error,
    "older cf-harness runs cannot be resumed",
  );
});
