import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import {
  createFileSystemHarnessArtifactStore,
  readHarnessRunArtifacts,
  readHarnessRunReport,
  readHarnessRunState,
  readHarnessTranscript,
} from "../src/artifacts.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
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
    return Promise.resolve(
      this.shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

Deno.test({
  name:
    "CfHarnessEngine persists run state and tool output artifacts when artifactRoot is configured",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-artifacts-",
    });
    try {
      const engine = new CfHarnessEngine({
        artifactRoot,
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: "hello\n", stderr: "", exitCode: 0 },
        ]),
        runId: "run-artifacts",
        cfcEnforcementMode: "observe",
        now: (() => {
          const timestamps = [
            "2026-04-15T21:00:00.000Z",
            "2026-04-15T21:00:01.000Z",
            "2026-04-15T21:00:02.000Z",
            "2026-04-15T21:00:03.000Z",
            "2026-04-15T21:00:04.000Z",
          ];
          return () => timestamps.shift() ?? "2026-04-15T21:00:05.000Z";
        })(),
      });

      const result = await engine.invokeBuiltinTool("bash", {
        command: "echo hello",
      });
      const runRoot = join(artifactRoot, "run-artifacts");
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );
      const capabilitySnapshotPath = join(runRoot, "capabilities.json");

      assertEquals(
        result.resultRef.artifactPath,
        join(
          runRoot,
          "tool-outputs",
          "run-artifacts_bash_1-bash.json",
        ),
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(result.resultRef.artifactPath!)),
        {
          outputId: createToolOutputId("run-artifacts", "bash", 1),
          stdout: "hello\n",
          stderr: "",
          exitCode: 0,
          cwd: "/workspace",
        },
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(capabilitySnapshotPath)),
        persistedState.capabilitySnapshot,
      );
      assertEquals(persistedState, {
        runId: "run-artifacts",
        status: "completed",
        createdAt: "2026-04-15T21:00:00.000Z",
        updatedAt: "2026-04-15T21:00:05.000Z",
        endedAt: "2026-04-15T21:00:05.000Z",
        terminalReason: "tool_completed",
        cfcEnforcementMode: "observe",
        currentDir: "/workspace",
        artifactRoot: runRoot,
        capabilitySnapshot: {
          type: "cf-harness.capability-snapshot",
          at: "2026-04-15T21:00:01.000Z",
          cfc: {
            enforcementMode: "observe",
            absenceBehavior: "observe-only",
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
        },
        capabilitiesPath: capabilitySnapshotPath,
        policyEvents: [],
        toolOutputs: [result.resultRef],
        failureRecords: [],
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name: "CfHarnessEngine persists Loom run manifest artifacts",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-manifest-",
    });
    const runManifest = {
      type: "cf-harness.loom-run-manifest" as const,
      version: 1 as const,
      source: "loom" as const,
      wishId: "W-519",
      cfc: { enforcementMode: "observe" as const },
    };
    try {
      const engine = new CfHarnessEngine({
        artifactRoot,
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: "ok\n", stderr: "", exitCode: 0 },
        ]),
        runId: "run-with-manifest",
        runManifest,
        runManifestPath: "/tmp/original-loom-run-manifest.json",
      });

      await engine.invokeBuiltinTool("bash", { command: "echo ok" });

      const runRoot = join(artifactRoot, "run-with-manifest");
      const manifestPath = join(runRoot, "run-manifest.json");
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );

      assertEquals(
        JSON.parse(await Deno.readTextFile(manifestPath)),
        runManifest,
      );
      assertEquals(persistedState.cfcEnforcementMode, "observe");
      assertEquals(persistedState.runManifest, runManifest);
      assertEquals(persistedState.runManifestPath, manifestPath);
      assertEquals(persistedState.capabilitySnapshot?.cfc.runManifest, {
        present: true,
        type: "cf-harness.loom-run-manifest",
        path: manifestPath,
      });
      assertEquals(
        persistedState.capabilitySnapshot?.cfc.substrateStatus,
        "manifest-present",
      );
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "CfHarnessPromptLoop persists the transcript when artifactRoot is configured",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-transcript-",
    });
    try {
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime([
            { stdout: "hello from file", stderr: "", exitCode: 0 },
          ]),
          runId: "run-loop-persisted",
          model: "gpt-5.4",
          now: (() => {
            const timestamps = [
              "2026-04-15T21:10:00.000Z",
              "2026-04-15T21:10:01.000Z",
              "2026-04-15T21:10:02.000Z",
              "2026-04-15T21:10:03.000Z",
              "2026-04-15T21:10:04.000Z",
              "2026-04-15T21:10:05.000Z",
              "2026-04-15T21:10:06.000Z",
            ];
            return () => timestamps.shift() ?? "2026-04-15T21:10:07.000Z";
          })(),
        }),
        fetchFn: (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string }>;
          };
          const payload = body.messages.some((message) =>
              message.role === "tool"
            )
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Persisted summary.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "notes/todo.txt" }),
                    },
                  }],
                },
              }],
            };
          return Promise.resolve(
            new Response(JSON.stringify(payload), { status: 200 }),
          );
        },
      });

      const result = await loop.runPrompt({
        prompt: "Summarize the todo file.",
      });

      const runRoot = join(artifactRoot, "run-loop-persisted");
      const transcriptPath = join(runRoot, "transcript.json");
      const runReportPath = join(runRoot, "run-report.json");
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );
      const persistedReport = await readHarnessRunReport(runReportPath);

      assertEquals(result.runState.transcriptPath, transcriptPath);
      assertEquals(result.runState.runReportPath, runReportPath);
      assertEquals(
        await readHarnessTranscript(transcriptPath),
        result.transcript,
      );
      assertEquals(persistedState.transcriptPath, transcriptPath);
      assertEquals(persistedState.runReportPath, runReportPath);
      assertEquals(persistedState.artifactRoot, runRoot);
      assertEquals(persistedState.endedAt, "2026-04-15T21:10:07.000Z");
      assertEquals(persistedState.terminalReason, "assistant_completed");
      assertEquals(persistedState.policyEvents, []);
      assertEquals(persistedState.failureRecords, []);
      assertEquals(
        persistedState.capabilitySnapshot?.commands.python3.present,
        true,
      );
      assertEquals(persistedReport.type, "cf-harness.run-report");
      assertEquals(persistedReport.runId, "run-loop-persisted");
      assertEquals(persistedReport.status, "completed");
      assertEquals(persistedReport.model, "gpt-5.4");
      assertEquals(persistedReport.modelTurns, 2);
      assertEquals(persistedReport.finalAssistantText, "Persisted summary.");
      assertEquals(persistedReport.policyEventCounts, {
        total: 0,
        warnings: 0,
        denied: 0,
      });
      assertEquals(persistedReport.toolActivity.length, 1);
      assertEquals(persistedReport.toolActivity[0], {
        type: "cf-harness.tool-activity",
        runId: "run-loop-persisted",
        sequence: 1,
        startedAt: "2026-04-15T21:10:05.000Z",
        endedAt: "2026-04-15T21:10:07.000Z",
        toolCallId: "call-1",
        toolId: "read_file",
        effectClass: "read",
        cfcEnforcementMode: "enforce-explicit",
        policyDecision: "allowed",
        executionStatus: "completed",
        toolInputSummary: {
          type: "cf-harness.tool-input-summary",
          toolId: "read_file",
          path: "notes/todo.txt",
        },
        resultRef: result.runState.toolOutputs[0],
      });
      assertEquals(
        persistedReport.timeline.map((entry) => entry.kind),
        [
          "run_started",
          "transcript_message",
          "transcript_message",
          "tool_activity",
          "transcript_message",
          "transcript_message",
          "run_finished",
        ],
      );
      assertEquals(
        persistedReport.timeline
          .filter((entry) => entry.kind === "transcript_message")
          .map((entry) => entry.role),
        ["user", "assistant", "tool", "assistant"],
      );
      assertEquals(
        persistedReport.timeline.find((entry) =>
          entry.kind === "tool_activity"
        ),
        {
          type: "cf-harness.timeline-entry",
          sequence: 4,
          kind: "tool_activity",
          at: "2026-04-15T21:10:05.000Z",
          endedAt: "2026-04-15T21:10:07.000Z",
          toolActivitySequence: 1,
          toolCallId: "call-1",
          toolId: "read_file",
          policyDecision: "allowed",
          executionStatus: "completed",
        },
      );
      assertEquals(
        persistedReport.timeline[persistedReport.timeline.length - 1],
        {
          type: "cf-harness.timeline-entry",
          sequence: 7,
          kind: "run_finished",
          at: "2026-04-15T21:10:07.000Z",
          status: "completed",
          terminalReason: "assistant_completed",
        },
      );
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "CfHarnessPromptLoop persists subagent refs, child artifacts, and report timeline",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-subagent-",
    });
    try {
      const promptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "test.prompt-slot", subject: "subagent-artifact-test" },
        role: "direct-command",
        kernelName: "cf-harness",
        surface: "test",
        subject: "subagent-artifact-test",
        eventId: "event-subagent-artifact",
      } as const;
      const requestBodies: Array<{
        messages: Array<{ role: string; content: string }>;
        tools: Array<{ function: { name: string } }>;
      }> = [];
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: "run-subagent-persisted",
          model: "gpt-5.4",
          cfcEnforcementMode: "enforce-explicit",
        }),
        fetchFn: (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string; content: string }>;
            tools: Array<{ function: { name: string } }>;
          };
          requestBodies.push(body);
          const payload = requestBodies.length === 1
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-subagent-persisted",
                    type: "function",
                    function: {
                      name: "delegate_task",
                      arguments: JSON.stringify({
                        goal: "Inspect persisted child artifacts.",
                        context: "Return a short summary.",
                      }),
                    },
                  }],
                },
              }],
            }
            : requestBodies.length === 2
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Child artifact summary.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Parent artifact summary.",
                },
              }],
            };
          return Promise.resolve(
            new Response(JSON.stringify(payload), { status: 200 }),
          );
        },
      });

      const result = await loop.runPrompt({
        prompt: "Delegate and persist the child run.",
        promptSlotBinding,
      });

      const runRoot = join(artifactRoot, "run-subagent-persisted");
      const childRunRoot = join(
        artifactRoot,
        "run-subagent-persisted.subagent.1",
      );
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );
      const persistedReport = await readHarnessRunReport(
        join(runRoot, "run-report.json"),
      );
      const childState = await readHarnessRunState(
        join(childRunRoot, "run-state.json"),
      );
      const childTranscript = await readHarnessTranscript(
        join(childRunRoot, "transcript.json"),
      );
      const delegateToolOutput = JSON.parse(
        await Deno.readTextFile(persistedState.toolOutputs[0].artifactPath!),
      ) as {
        type: string;
        outputId: string;
        subagent: {
          childRunId: string;
          status: string;
          summary: string;
        };
      };

      assertEquals(result.finalAssistantText, "Parent artifact summary.");
      assertEquals(persistedState.subagentRuns?.length, 1);
      const subagentRun = persistedState.subagentRuns?.[0];
      if (subagentRun === undefined) {
        throw new Error("expected persisted subagent run ref");
      }
      assertEquals(subagentRun, result.runState.subagentRuns?.[0]);
      assertEquals(
        subagentRun.outputId,
        createToolOutputId("run-subagent-persisted", "delegate_task", 1),
      );
      assertEquals(subagentRun.parentToolCallId, "call-subagent-persisted");
      assertEquals(
        subagentRun.childRunId,
        "run-subagent-persisted.subagent.1",
      );
      assertEquals(subagentRun.status, "completed");
      assertEquals(subagentRun.summary, "Child artifact summary.");
      assertEquals(subagentRun.manifest.allowedToolIds, [
        "bash",
        "read_file",
        "write_file",
      ]);
      assertEquals(subagentRun.manifest.hostToolIds, []);
      assertEquals(subagentRun.manifest.returnPolicy, {
        type: "cf-harness.subagent-return-policy",
        channel: "summary-and-sanitized-state",
        includeSummary: true,
        includeSanitizedRunState: true,
        includeManifest: true,
        includeTranscript: false,
        includeRawFailureRecords: false,
      });
      assertEquals(
        subagentRun.manifest.inputSummary.goalDigest.startsWith("sha256:"),
        true,
      );
      assertEquals(subagentRun.runState.artifactRoot, childRunRoot);

      assertEquals(childState.runId, "run-subagent-persisted.subagent.1");
      assertEquals(childState.status, "completed");
      assertEquals(childState.artifactRoot, childRunRoot);
      assertEquals(
        childState.transcriptPath,
        join(childRunRoot, "transcript.json"),
      );
      assertEquals(
        childState.runReportPath,
        join(childRunRoot, "run-report.json"),
      );
      assertEquals(childState.terminalReason, "assistant_completed");
      assertEquals(childTranscript.map((message) => message.role), [
        "system",
        "user",
        "assistant",
      ]);
      assertEquals(
        childTranscript[1].content.includes(
          "Inspect persisted child artifacts.",
        ),
        true,
      );
      assertEquals(
        childTranscript[1].content.includes(
          "Delegate and persist the child run.",
        ),
        false,
      );

      assertEquals(delegateToolOutput.type, "cf-harness.delegate-task-output");
      assertEquals(
        delegateToolOutput.subagent.childRunId,
        subagentRun.childRunId,
      );
      assertEquals(delegateToolOutput.subagent.status, "completed");
      assertEquals(
        delegateToolOutput.subagent.summary,
        "Child artifact summary.",
      );

      assertEquals(persistedReport.subagentRuns?.[0], subagentRun);
      assertEquals(persistedReport.toolActivity[0].toolId, "delegate_task");
      assertEquals(persistedReport.toolActivity[0].effectClass, "side-effect");
      assertEquals(
        persistedReport.toolActivity[0].resultRef?.outputId,
        createToolOutputId("run-subagent-persisted", "delegate_task", 1),
      );
      const timelineEntry = persistedReport.timeline.find((entry) =>
        entry.kind === "subagent_run"
      );
      if (timelineEntry === undefined) {
        throw new Error("expected subagent_run timeline entry");
      }
      assertEquals(timelineEntry.toolCallId, "call-subagent-persisted");
      assertEquals(
        timelineEntry.childRunId,
        "run-subagent-persisted.subagent.1",
      );
      assertEquals(timelineEntry.subagentStatus, "completed");
      assertEquals(timelineEntry.status, "completed");
      assertEquals(timelineEntry.terminalReason, "assistant_completed");
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "CfHarnessPromptLoop keeps raw child failure fields out of parent delegate output",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-subagent-failure-",
    });
    const rawChildCommand = "secret-child-command --token=raw-child-detail";
    try {
      const promptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: {
          type: "test.prompt-slot",
          subject: "subagent-failure-artifact-test",
        },
        role: "direct-command",
        kernelName: "cf-harness",
        surface: "test",
        subject: "subagent-failure-artifact-test",
        eventId: "event-subagent-failure-artifact",
      } as const;
      let requestCount = 0;
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime([
            {
              stdout: "",
              stderr: "/bin/sh: secret-child-command: command not found\n",
              exitCode: 127,
            },
          ]),
          runId: "run-subagent-sanitized-failure",
          model: "gpt-5.4",
          cfcEnforcementMode: "enforce-explicit",
        }),
        fetchFn: () => {
          requestCount += 1;
          const payload = requestCount === 1
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-subagent-sanitized-failure",
                    type: "function",
                    function: {
                      name: "delegate_task",
                      arguments: JSON.stringify({
                        goal: "Run a diagnostic command and summarize failure.",
                      }),
                    },
                  }],
                },
              }],
            }
            : requestCount === 2
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-child-bash-failure",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: rawChildCommand,
                      }),
                    },
                  }],
                },
              }],
            }
            : requestCount === 3
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Child summarized the failed diagnostic command.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Parent received the sanitized child summary.",
                },
              }],
            };
          return Promise.resolve(
            new Response(JSON.stringify(payload), { status: 200 }),
          );
        },
      });

      await loop.runPrompt({
        prompt: "Delegate a diagnostic command.",
        promptSlotBinding,
      });

      const runRoot = join(artifactRoot, "run-subagent-sanitized-failure");
      const childRunRoot = join(
        artifactRoot,
        "run-subagent-sanitized-failure.subagent.1",
      );
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );
      const childState = await readHarnessRunState(
        join(childRunRoot, "run-state.json"),
      );
      const delegateToolOutput = JSON.parse(
        await Deno.readTextFile(persistedState.toolOutputs[0].artifactPath!),
      ) as {
        subagent: {
          runState: {
            failureCount: number;
            primaryFailure?: Record<string, unknown>;
          };
        };
      };
      const parentFailure = delegateToolOutput.subagent.runState.primaryFailure;
      if (parentFailure === undefined) {
        throw new Error("expected sanitized parent failure summary");
      }

      assertEquals(delegateToolOutput.subagent.runState.failureCount, 1);
      assertEquals(parentFailure.type, "cf-harness.subagent-failure-summary");
      assertEquals(parentFailure.kind, "missing_binary");
      assertEquals(parentFailure.source, "tool_output");
      assertEquals(parentFailure.toolId, "bash");
      assertEquals(
        parentFailure.outputId,
        createToolOutputId(
          "run-subagent-sanitized-failure.subagent.1",
          "bash",
          1,
        ),
      );
      assertEquals(parentFailure.commandName, "secret-child-command");
      assertEquals(parentFailure.exitCode, 127);
      assertEquals("command" in parentFailure, false);
      assertEquals("detail" in parentFailure, false);
      assertEquals("at" in parentFailure, false);
      assertEquals(
        JSON.stringify(delegateToolOutput).includes(rawChildCommand),
        false,
      );
      assertEquals(
        JSON.stringify(delegateToolOutput).includes("raw-child-detail"),
        false,
      );
      assertEquals(
        parentFailure,
        persistedState.subagentRuns?.[0]?.runState.primaryFailure as
          | Record<string, unknown>
          | undefined,
      );

      assertEquals(childState.primaryFailure?.command, rawChildCommand);
      assertEquals(childState.primaryFailure?.kind, "missing_binary");
      assertEquals(
        childState.primaryFailure?.detail.includes(
          "secret-child-command",
        ),
        true,
      );
      assertEquals(childState.failureRecords?.[0]?.command, rawChildCommand);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name: "CfHarnessEngine persists prompt slot binding in run state artifacts",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-prompt-slot-",
    });
    try {
      const promptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "test.prompt-slot", subject: "artifact-test" },
        role: "direct-command",
        kernelName: "cf-harness",
        surface: "test",
        subject: "artifact-test",
        eventId: "event-artifact",
      } as const;
      const engine = new CfHarnessEngine({
        artifactRoot,
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-prompt-slot",
        cfcEnforcementMode: "observe",
      });

      engine.setPromptSlotBinding(promptSlotBinding);
      await engine.persistRunState();

      const persistedState = await readHarnessRunState(
        join(artifactRoot, "run-prompt-slot", "run-state.json"),
      );
      assertEquals(persistedState.promptSlotBinding, promptSlotBinding);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name: "CfHarnessPromptLoop persists denied tool activity in the run report",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-denied-report-",
    });
    try {
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: "run-denied-report",
          model: "gpt-5.4",
          cfcEnforcementMode: "enforce-explicit",
          now: (() => {
            const timestamps = [
              "2026-04-15T21:20:00.000Z",
              "2026-04-15T21:20:01.000Z",
              "2026-04-15T21:20:02.000Z",
              "2026-04-15T21:20:03.000Z",
              "2026-04-15T21:20:04.000Z",
              "2026-04-15T21:20:05.000Z",
              "2026-04-15T21:20:06.000Z",
              "2026-04-15T21:20:07.000Z",
              "2026-04-15T21:20:08.000Z",
              "2026-04-15T21:20:09.000Z",
            ];
            return () => timestamps.shift() ?? "2026-04-15T21:20:10.000Z";
          })(),
        }),
        fetchFn: (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string }>;
          };
          const payload = body.messages.some((message) =>
              message.role === "tool"
            )
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Write was denied.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-denied-report",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "notes/out.txt",
                        content: "nope",
                      }),
                    },
                  }],
                },
              }],
            };
          return Promise.resolve(
            new Response(JSON.stringify(payload), { status: 200 }),
          );
        },
      });

      const result = await loop.runPrompt({
        prompt: "Write the output file.",
      });

      const runReport = await readHarnessRunReport(
        join(artifactRoot, "run-denied-report", "run-report.json"),
      );

      assertEquals(result.runState.toolOutputs, []);
      assertEquals(runReport.policyEventCounts, {
        total: 1,
        warnings: 0,
        denied: 1,
      });
      assertEquals(runReport.toolActivity, [{
        type: "cf-harness.tool-activity",
        runId: "run-denied-report",
        sequence: 1,
        startedAt: "2026-04-15T21:20:05.000Z",
        endedAt: "2026-04-15T21:20:06.000Z",
        toolCallId: "call-denied-report",
        toolId: "write_file",
        effectClass: "write",
        cfcEnforcementMode: "enforce-explicit",
        policyDecision: "denied",
        executionStatus: "not-run",
        toolInputSummary: {
          type: "cf-harness.tool-input-summary",
          toolId: "write_file",
          path: "notes/out.txt",
          mode: "replace",
          contentBytes: 4,
          contentDigest:
            "sha256:ca3704aa0b06f5954c79ee837faa152d84d6b2d42838f0637a15eda8337dbdce",
        },
        policyEventIndexes: [0],
      }]);
      assertEquals(
        runReport.timeline.map((entry) => entry.kind),
        [
          "run_started",
          "transcript_message",
          "transcript_message",
          "tool_activity",
          "policy_event",
          "failure_record",
          "transcript_message",
          "transcript_message",
          "run_finished",
        ],
      );
      assertEquals(
        runReport.timeline.find((entry) => entry.kind === "policy_event"),
        {
          type: "cf-harness.timeline-entry",
          sequence: 5,
          kind: "policy_event",
          at: "2026-04-15T21:20:06.000Z",
          policyEventIndex: 0,
          severity: "denied",
          toolCallId: "call-denied-report",
          toolId: "write_file",
        },
      );
      assertEquals(
        runReport.timeline.find((entry) => entry.kind === "tool_activity"),
        {
          type: "cf-harness.timeline-entry",
          sequence: 4,
          kind: "tool_activity",
          at: "2026-04-15T21:20:05.000Z",
          endedAt: "2026-04-15T21:20:06.000Z",
          toolActivitySequence: 1,
          toolCallId: "call-denied-report",
          toolId: "write_file",
          policyDecision: "denied",
          executionStatus: "not-run",
        },
      );
      assertEquals(
        runReport.timeline.find((entry) => entry.kind === "failure_record"),
        {
          type: "cf-harness.timeline-entry",
          sequence: 6,
          kind: "failure_record",
          at: "2026-04-15T21:20:06.000Z",
          failureRecordIndex: 0,
          failureKind: "tool_not_allowed",
          source: "policy_event",
          toolId: "write_file",
        },
      );
      assertEquals(JSON.stringify(runReport).includes("nope"), false);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test("createFileSystemHarnessArtifactStore rejects path-traversal run ids", () => {
  assertThrows(
    () =>
      createFileSystemHarnessArtifactStore({
        artifactRoot: "/tmp/cf-harness-artifacts",
        runId: "../escape",
      }),
    Error,
    "runId must be a simple path segment",
  );
});

Deno.test({
  name: "readHarnessRunArtifacts confines transcript loading to the run root",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-read-artifacts-",
    });
    try {
      const runRoot = join(artifactRoot, "run-1");
      const runStatePath = join(runRoot, "run-state.json");
      const defaultTranscriptPath = join(runRoot, "transcript.json");
      const outsideTranscriptPath = join(artifactRoot, "outside.json");

      await Deno.mkdir(runRoot, { recursive: true });
      await Deno.writeTextFile(
        runStatePath,
        JSON.stringify({
          runId: "run-1",
          status: "completed",
          createdAt: "2026-04-17T20:00:00.000Z",
          updatedAt: "2026-04-17T20:00:01.000Z",
          cfcEnforcementMode: "observe",
          transcriptPath: outsideTranscriptPath,
          policyEvents: [],
          toolOutputs: [],
          failureRecords: [],
        }),
      );
      await Deno.writeTextFile(
        defaultTranscriptPath,
        JSON.stringify([{ role: "assistant", content: "inside transcript" }]),
      );
      await Deno.writeTextFile(
        outsideTranscriptPath,
        JSON.stringify([{ role: "assistant", content: "outside transcript" }]),
      );

      const artifacts = await readHarnessRunArtifacts(runRoot);

      assertEquals(artifacts.transcriptPath, defaultTranscriptPath);
      assertEquals(artifacts.transcript, [{
        role: "assistant",
        content: "inside transcript",
      }]);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});
