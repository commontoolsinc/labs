import { assertEquals, assertRejects } from "@std/assert";
import { normalize } from "@std/path/posix";
import type { HarnessArtifactStore } from "../src/artifacts.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../src/contracts/prompt-slot.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";

const directPromptSlotBinding: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "direct-test" },
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "test",
  subject: "direct-test",
  eventId: "event-direct",
};

const contextPromptSlotBinding: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "context-test" },
  role: "context",
  kernelName: "cf-harness",
  surface: "test",
  subject: "context-test",
  eventId: "event-context",
};

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

class FailingArtifactStore implements HarnessArtifactStore {
  readonly artifactRoot = "/tmp/cf-harness-artifacts";
  readonly runRoot = "/tmp/cf-harness-artifacts/run-error";
  runStatePersistCount = 0;

  persistRunState(): Promise<string> {
    this.runStatePersistCount += 1;
    if (this.runStatePersistCount >= 3) {
      return Promise.reject(new Error("persist boom"));
    }
    return Promise.resolve(`${this.runRoot}/run-state.json`);
  }

  persistTranscript(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/transcript.json`);
  }

  persistCapabilitySnapshot(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/capabilities.json`);
  }

  persistRunReport(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/run-report.json`);
  }

  persistToolOutput(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/tool-output.json`);
  }
}

Deno.test("CfHarnessPromptLoop runs a tool call and returns the final assistant response", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime([
        { stdout: "hello from file", stderr: "", exitCode: 0 },
      ]),
      runId: "run-loop",
      model: "gpt-5.4",
      now: (() => {
        const timestamps = [
          "2026-04-15T20:00:00.000Z",
          "2026-04-15T20:00:01.000Z",
          "2026-04-15T20:00:02.000Z",
          "2026-04-15T20:00:03.000Z",
          "2026-04-15T20:00:04.000Z",
          "2026-04-15T20:00:05.000Z",
        ];
        return () => timestamps.shift() ?? "2026-04-15T20:00:06.000Z";
      })(),
    }),
    fetchFn: (_input, init) => {
      fetchCalls.push(init ?? {});
      const payload = fetchCalls.length === 1
        ? {
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
        }
        : {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "The todo file says hello from file.",
            },
          }],
        };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    },
  });

  const result = await loop.runPrompt({
    systemPrompt: "You are a test harness.",
    prompt: "Read the todo file and summarize it.",
  });

  assertEquals(
    result.finalAssistantText,
    "The todo file says hello from file.",
  );
  assertEquals(result.modelTurns, 2);
  assertEquals(result.runState.endedAt, "2026-04-15T20:00:06.000Z");
  assertEquals(result.runState.terminalReason, "assistant_completed");
  assertEquals(result.transcript, [
    { role: "system", content: "You are a test harness." },
    { role: "user", content: "Read the todo file and summarize it." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "notes/todo.txt" }),
        },
      }],
    },
    {
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      content: JSON.stringify({
        outputId: createToolOutputId("run-loop", "read_file", 1),
        path: "/workspace/notes/todo.txt",
        content: "hello from file",
      }),
      resultRef: {
        type: "cf-harness.tool-result-ref",
        outputId: createToolOutputId("run-loop", "read_file", 1),
        toolId: "read_file",
        runId: "run-loop",
      },
    },
    {
      role: "assistant",
      content: "The todo file says hello from file.",
    },
  ]);
  assertEquals(result.runState.status, "completed");
  assertEquals(result.runState.policyEvents, []);

  const firstRequest = JSON.parse(String(fetchCalls[0]?.body)) as {
    tools: Array<{ function: { name: string } }>;
  };
  const secondRequest = JSON.parse(String(fetchCalls[1]?.body)) as {
    messages: Array<{ role: string; tool_call_id?: string; content: string }>;
  };

  assertEquals(
    firstRequest.tools.map((tool) => tool.function.name),
    ["bash", "read_file", "write_file", "delegate_task"],
  );
  assertEquals(
    secondRequest.messages.at(-1),
    {
      role: "tool",
      tool_call_id: "call-1",
      content: JSON.stringify({
        outputId: createToolOutputId("run-loop", "read_file", 1),
        path: "/workspace/notes/todo.txt",
        content: "hello from file",
      }),
    },
  );
});

Deno.test("CfHarnessPromptLoop surfaces recoverable file-tool failures to the model", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime([
        {
          stdout: "",
          stderr: "file not found: /workspace/notes/missing.txt",
          exitCode: 10,
        },
      ]),
      runId: "run-recoverable-file-error",
      model: "gpt-5.4",
      now: (() => {
        const timestamps = [
          "2026-04-15T20:05:00.000Z",
          "2026-04-15T20:05:01.000Z",
          "2026-04-15T20:05:02.000Z",
          "2026-04-15T20:05:03.000Z",
          "2026-04-15T20:05:04.000Z",
          "2026-04-15T20:05:05.000Z",
        ];
        return () => timestamps.shift() ?? "2026-04-15T20:05:06.000Z";
      })(),
    }),
    fetchFn: (_input, init) => {
      fetchCalls.push(init ?? {});
      const payload = fetchCalls.length === 1
        ? {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-missing",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({
                    path: "notes/missing.txt",
                  }),
                },
              }],
            },
          }],
        }
        : {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "The file is not present.",
            },
          }],
        };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    },
  });

  const result = await loop.runPrompt({
    prompt: "Read the missing file and tell me what happened.",
  });

  const recoverableOutput = {
    outputId: createToolOutputId(
      "run-recoverable-file-error",
      "read_file",
      1,
    ),
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
  };

  assertEquals(result.finalAssistantText, "The file is not present.");
  assertEquals(result.modelTurns, 2);
  assertEquals(result.runState.status, "completed");
  assertEquals(result.runState.terminalReason, "assistant_completed");
  assertEquals(result.runState.primaryFailure?.kind, "file_not_found");
  assertEquals(result.transcript.at(-2), {
    role: "tool",
    toolCallId: "call-missing",
    toolName: "read_file",
    content: JSON.stringify(recoverableOutput),
    resultRef: {
      type: "cf-harness.tool-result-ref",
      outputId: createToolOutputId(
        "run-recoverable-file-error",
        "read_file",
        1,
      ),
      toolId: "read_file",
      runId: "run-recoverable-file-error",
    },
  });

  const secondRequest = JSON.parse(String(fetchCalls[1]?.body)) as {
    messages: Array<{ role: string; tool_call_id?: string; content: string }>;
  };
  assertEquals(secondRequest.messages.at(-1), {
    role: "tool",
    tool_call_id: "call-missing",
    content: JSON.stringify(recoverableOutput),
  });
});

Deno.test("CfHarnessPromptLoop only advertises allowed tools when a tool allowlist is configured", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    allowedToolIds: ["read_file"],
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-allowed-tools",
      model: "gpt-5.4",
    }),
    fetchFn: (_input, init) => {
      fetchCalls.push(init ?? {});
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "No tool call needed.",
              },
            }],
          }),
          { status: 200 },
        ),
      );
    },
  });

  await loop.runPrompt({ prompt: "Say hi." });

  const request = JSON.parse(String(fetchCalls[0]?.body)) as {
    tools: Array<{ function: { name: string } }>;
  };
  assertEquals(
    request.tools.map((tool) => tool.function.name),
    ["read_file"],
  );
});

Deno.test("CfHarnessPromptLoop delegates one fresh child run and returns a summary-only result", async () => {
  const requestBodies: Array<{
    messages: Array<{ role: string; content: string }>;
    tools: Array<{ function: { name: string } }>;
  }> = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-delegate",
      model: "gpt-5.4",
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
                id: "call-delegate",
                type: "function",
                function: {
                  name: "delegate_task",
                  arguments: JSON.stringify({
                    goal: "Inspect src/example.ts",
                    context: "Return only findings.",
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
              content: "Child inspected the file and found no issues.",
            },
          }],
        }
        : {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "Parent received the child summary.",
            },
          }],
        };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    },
  });

  const result = await loop.runPrompt({
    prompt: "Delegate a focused inspection.",
  });

  assertEquals(result.finalAssistantText, "Parent received the child summary.");
  assertEquals(
    requestBodies[0].tools.map((tool) => tool.function.name),
    ["bash", "read_file", "write_file", "delegate_task"],
  );
  assertEquals(
    requestBodies[1].tools.map((tool) => tool.function.name),
    ["bash", "read_file", "write_file"],
  );
  assertEquals(
    requestBodies[1].messages.map((message) => message.role),
    ["system", "user"],
  );
  assertEquals(
    requestBodies[1].messages[1].content.includes(
      "Delegate a focused inspection.",
    ),
    false,
  );
  assertEquals(
    requestBodies[1].messages[1].content.includes("Inspect src/example.ts"),
    true,
  );
  const toolMessage = result.transcript.at(-2);
  if (toolMessage?.role !== "tool") {
    throw new Error("expected delegate_task tool message");
  }
  const output = JSON.parse(toolMessage.content) as {
    type: string;
    outputId: string;
    subagent: {
      childRunId: string;
      status: string;
      summary: string;
      modelTurns: number;
      manifest: {
        parentRunId: string;
        parentToolCallId: string;
        allowedToolIds: string[];
        inputSummary: {
          goalBytes: number;
          goalDigest: string;
          contextBytes: number;
          contextDigest: string;
        };
      };
    };
  };
  assertEquals(output.type, "cf-harness.delegate-task-output");
  assertEquals(
    output.outputId,
    createToolOutputId(
      "run-delegate",
      "delegate_task",
      1,
    ),
  );
  assertEquals(output.subagent.childRunId, "run-delegate.subagent.1");
  assertEquals(output.subagent.status, "completed");
  assertEquals(
    output.subagent.summary,
    "Child inspected the file and found no issues.",
  );
  assertEquals(output.subagent.modelTurns, 1);
  assertEquals(output.subagent.manifest.parentRunId, "run-delegate");
  assertEquals(output.subagent.manifest.parentToolCallId, "call-delegate");
  assertEquals(output.subagent.manifest.allowedToolIds, [
    "bash",
    "read_file",
    "write_file",
  ]);
  assertEquals(output.subagent.manifest.inputSummary.goalBytes, 22);
  assertEquals(output.subagent.manifest.inputSummary.contextBytes, 21);
  assertEquals(
    output.subagent.manifest.inputSummary.goalDigest.startsWith("sha256:"),
    true,
  );
  assertEquals(
    output.subagent.manifest.inputSummary.contextDigest.startsWith("sha256:"),
    true,
  );
  assertEquals(result.runState.subagentRuns?.length, 1);
  assertEquals(
    result.runState.subagentRuns?.[0]?.childRunId,
    "run-delegate.subagent.1",
  );
  assertEquals(
    result.runState.subagentRuns?.[0]?.summary,
    "Child inspected the file and found no issues.",
  );
});

Deno.test("CfHarnessPromptLoop completes a direct assistant response without tool calls", async () => {
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-direct",
      model: "gpt-5.4",
      now: (() => {
        const timestamps = [
          "2026-04-15T20:10:00.000Z",
          "2026-04-15T20:10:01.000Z",
          "2026-04-15T20:10:02.000Z",
        ];
        return () => timestamps.shift() ?? "2026-04-15T20:10:03.000Z";
      })(),
    }),
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "No tool call needed.",
              },
            }],
          }),
          { status: 200 },
        ),
      ),
  });

  const result = await loop.runPrompt({
    prompt: "Say hi.",
    promptSlotBinding: directPromptSlotBinding,
  });

  assertEquals(result.finalAssistantText, "No tool call needed.");
  assertEquals(result.runState.promptSlotBinding, directPromptSlotBinding);
  assertEquals(result.runState.status, "completed");
  assertEquals(result.runState.policyEvents, []);
  assertEquals(result.runState.toolOutputs, []);
});

Deno.test("CfHarnessPromptLoop fails when the model exceeds the configured turn cap", async () => {
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime([
        { stdout: "hello", stderr: "", exitCode: 0 },
      ]),
      runId: "run-max-turns",
      model: "gpt-5.4",
    }),
    maxModelTurns: 1,
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
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
          }),
          { status: 200 },
        ),
      ),
  });

  await assertRejects(
    () => loop.runPrompt({ prompt: "Loop forever." }),
    Error,
    "prompt loop exceeded max model turns (1)",
  );
  assertEquals(loop.engine.getRunState().status, "failed");
  assertEquals(loop.engine.getRunState().terminalReason, "max_model_turns");
  assertEquals(loop.engine.getRunState().policyEvents, []);
});

Deno.test("CfHarnessPromptLoop preserves the original error when failure persistence also fails", async () => {
  const artifactStore = new FailingArtifactStore();
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      artifactStore,
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-persist-error",
      model: "gpt-5.4",
    }),
    fetchFn: () => Promise.reject(new Error("gateway boom")),
  });

  await assertRejects(
    () => loop.runPrompt({ prompt: "Fail in the gateway." }),
    Error,
    "gateway boom",
  );
  assertEquals(artifactStore.runStatePersistCount, 3);
  assertEquals(loop.engine.getRunState().status, "failed");
});

Deno.test("CfHarnessPromptLoop can resume from a persisted transcript", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-resume",
      model: "gpt-5.4",
    }),
    fetchFn: (_input, init) => {
      fetchCalls.push(init ?? {});
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Resumed summary.",
              },
            }],
          }),
          { status: 200 },
        ),
      );
    },
  });

  const result = await loop.runTranscript({
    transcript: [
      { role: "user", content: "Read the file." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "notes/todo.txt" }),
          },
        }],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        content: JSON.stringify({
          outputId: createToolOutputId("run-resume", "read_file", 1),
          path: "/workspace/notes/todo.txt",
          content: "hello from file",
        }),
        resultRef: {
          type: "cf-harness.tool-result-ref",
          outputId: createToolOutputId("run-resume", "read_file", 1),
          toolId: "read_file",
          runId: "run-resume",
        },
      },
    ],
  });

  assertEquals(result.finalAssistantText, "Resumed summary.");
  assertEquals(result.modelTurns, 1);
  const request = JSON.parse(String(fetchCalls[0]?.body)) as {
    messages: Array<{ role: string; tool_call_id?: string; content: string }>;
  };
  assertEquals(request.messages.at(-1), {
    role: "tool",
    tool_call_id: "call-1",
    content: JSON.stringify({
      outputId: createToolOutputId("run-resume", "read_file", 1),
      path: "/workspace/notes/todo.txt",
      content: "hello from file",
    }),
  });
  assertEquals(result.runState.policyEvents, []);
});

Deno.test("CfHarnessPromptLoop records observe-mode warnings and still executes the tool", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime([
        { stdout: "warned\n", stderr: "", exitCode: 0 },
      ]),
      runId: "run-observe-warning",
      model: "gpt-5.4",
      cfcEnforcementMode: "observe",
      now: (() => {
        const timestamps = [
          "2026-04-15T22:30:00.000Z",
          "2026-04-15T22:30:01.000Z",
          "2026-04-15T22:30:02.000Z",
          "2026-04-15T22:30:03.000Z",
          "2026-04-15T22:30:04.000Z",
          "2026-04-15T22:30:05.000Z",
        ];
        return () => timestamps.shift() ?? "2026-04-15T22:30:06.000Z";
      })(),
    }),
    fetchFn: (_input, init) => {
      fetchCalls.push(init ?? {});
      const payload = fetchCalls.length === 1
        ? {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-observe",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: "echo warned" }),
                },
              }],
            },
          }],
        }
        : {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "Observed with warning.",
            },
          }],
        };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    },
  });

  const result = await loop.runPrompt({
    prompt: "Run a shell command.",
  });

  assertEquals(result.finalAssistantText, "Observed with warning.");
  assertEquals(result.runState.policyEvents, [{
    type: "cf-harness.policy-event",
    severity: "warning",
    mode: "observe",
    toolId: "bash",
    toolCallId: "call-observe",
    toolInputSummary: {
      type: "cf-harness.tool-input-summary",
      toolId: "bash",
      commandBytes: 11,
      commandDigest:
        "sha256:17bc0d7e89ddefaf38bce5f3bedcd6309b9453c5d85dafd24d1243bb1e505e8c",
    },
    detail: "bash would require direct-command authorization in enforce modes",
    at: "2026-04-15T22:30:04.000Z",
  }]);
  assertEquals(
    JSON.stringify(result.runState.policyEvents[0]?.toolInputSummary)
      .includes("echo warned"),
    false,
  );
  assertEquals(result.runState.failureRecords, []);
  assertEquals(
    result.transcript.at(-2),
    {
      role: "tool",
      toolCallId: "call-observe",
      toolName: "bash",
      content: JSON.stringify({
        outputId: createToolOutputId("run-observe-warning", "bash", 1),
        stdout: "warned\n",
        stderr: "",
        exitCode: 0,
        cwd: "/workspace",
      }),
      resultRef: {
        type: "cf-harness.tool-result-ref",
        outputId: createToolOutputId("run-observe-warning", "bash", 1),
        toolId: "bash",
        runId: "run-observe-warning",
      },
    },
  );
});

Deno.test("CfHarnessPromptLoop returns observation-denied tool content in enforce-explicit mode", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-enforce-explicit",
      model: "gpt-5.4",
      cfcEnforcementMode: "enforce-explicit",
      now: (() => {
        const timestamps = [
          "2026-04-15T22:40:00.000Z",
          "2026-04-15T22:40:01.000Z",
          "2026-04-15T22:40:02.000Z",
          "2026-04-15T22:40:03.000Z",
        ];
        return () => timestamps.shift() ?? "2026-04-15T22:40:04.000Z";
      })(),
    }),
    fetchFn: (_input, init) => {
      fetchCalls.push(init ?? {});
      const payload = fetchCalls.length === 1
        ? {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-denied",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "notes/out.txt",
                    content: "nope",
                    mode: "replace",
                  }),
                },
              }],
            },
          }],
        }
        : {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content:
                "Write denied; direct-command authorization is required.",
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

  assertEquals(
    result.finalAssistantText,
    "Write denied; direct-command authorization is required.",
  );
  assertEquals(result.runState.toolOutputs, []);
  assertEquals(result.runState.policyEvents, [{
    type: "cf-harness.policy-event",
    severity: "denied",
    mode: "enforce-explicit",
    toolId: "write_file",
    toolCallId: "call-denied",
    toolInputSummary: {
      type: "cf-harness.tool-input-summary",
      toolId: "write_file",
      path: "notes/out.txt",
      mode: "replace",
      contentBytes: 4,
      contentDigest:
        "sha256:ca3704aa0b06f5954c79ee837faa152d84d6b2d42838f0637a15eda8337dbdce",
    },
    detail:
      "write_file requires direct-command authorization in enforce-explicit",
    observationDenied: {
      type: "cf-harness.observation-denied",
      reason: "not-authorized",
      detail:
        "write_file requires direct-command authorization in enforce-explicit",
    },
    at: "2026-04-15T22:40:04.000Z",
  }]);
  assertEquals(
    JSON.stringify(result.runState.policyEvents[0]?.toolInputSummary)
      .includes("nope"),
    false,
  );
  assertEquals(result.runState.primaryFailure?.kind, "tool_not_allowed");
  assertEquals(
    result.transcript.at(-2),
    {
      role: "tool",
      toolCallId: "call-denied",
      toolName: "write_file",
      content: JSON.stringify({
        type: "cf-harness.observation-denied",
        reason: "not-authorized",
        detail:
          "write_file requires direct-command authorization in enforce-explicit",
      }),
    },
  );
});

Deno.test("CfHarnessPromptLoop denies tool calls outside the configured allowlist", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    allowedToolIds: ["read_file"],
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-tool-allowlist-denied",
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
      now: (() => {
        const timestamps = [
          "2026-04-16T23:20:00.000Z",
          "2026-04-16T23:20:01.000Z",
          "2026-04-16T23:20:02.000Z",
          "2026-04-16T23:20:03.000Z",
        ];
        return () => timestamps.shift() ?? "2026-04-16T23:20:04.000Z";
      })(),
    }),
    fetchFn: (_input, init) => {
      fetchCalls.push(init ?? {});
      const payload = fetchCalls.length === 1
        ? {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-bash-denied",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: "pwd" }),
                },
              }],
            },
          }],
        }
        : {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "bash was not available in this run.",
            },
          }],
        };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    },
  });

  const result = await loop.runPrompt({
    prompt: "Run pwd.",
  });

  assertEquals(
    result.finalAssistantText,
    "bash was not available in this run.",
  );
  assertEquals(result.runState.toolOutputs, []);
  assertEquals(result.runState.policyEvents, [{
    type: "cf-harness.policy-event",
    severity: "denied",
    mode: "disabled",
    toolId: "bash",
    toolCallId: "call-bash-denied",
    toolInputSummary: {
      type: "cf-harness.tool-input-summary",
      toolId: "bash",
      commandBytes: 3,
      commandDigest:
        "sha256:a1159e9df3670d549d04524532629f5477ceb7deec9b45e47e8c009506ecb2c8",
    },
    detail: "bash is not allowed in this run",
    observationDenied: {
      type: "cf-harness.observation-denied",
      reason: "not-authorized",
      detail: "bash is not allowed in this run",
    },
    at: "2026-04-16T23:20:04.000Z",
  }]);
  assertEquals(result.runState.primaryFailure?.kind, "tool_not_allowed");
  assertEquals(
    result.transcript.at(-2),
    {
      role: "tool",
      toolCallId: "call-bash-denied",
      toolName: "bash",
      content: JSON.stringify({
        type: "cf-harness.observation-denied",
        reason: "not-authorized",
        detail: "bash is not allowed in this run",
      }),
    },
  );
});

Deno.test("CfHarnessPromptLoop includes read_file input summaries on strict-mode denials", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-read-file-strict",
      model: "gpt-5.4",
      cfcEnforcementMode: "enforce-strict",
    }),
    fetchFn: (_input, init) => {
      fetchCalls.push(init ?? {});
      const payload = fetchCalls.length === 1
        ? {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-read-denied",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({
                    path: "notes/private.txt",
                    maxBytes: 512,
                  }),
                },
              }],
            },
          }],
        }
        : {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "Read denied.",
            },
          }],
        };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    },
  });

  const result = await loop.runPrompt({
    prompt: "Read the private note.",
  });

  assertEquals(result.finalAssistantText, "Read denied.");
  assertEquals(result.runState.toolOutputs, []);
  assertEquals(result.runState.policyEvents[0]?.toolInputSummary, {
    type: "cf-harness.tool-input-summary",
    toolId: "read_file",
    path: "notes/private.txt",
    maxBytes: 512,
  });
  assertEquals(
    result.runState.policyEvents[0]?.detail,
    "read_file requires direct-command authorization in enforce-strict",
  );
});

Deno.test("CfHarnessPromptLoop includes prompt slot context on policy events", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-policy-context",
      model: "gpt-5.4",
      cfcEnforcementMode: "enforce-explicit",
    }),
    fetchFn: (_input, init) => {
      fetchCalls.push(init ?? {});
      const payload = fetchCalls.length === 1
        ? {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-policy-context",
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
        }
        : {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "Denied with context.",
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
    promptSlotBinding: contextPromptSlotBinding,
  });

  assertEquals(result.finalAssistantText, "Denied with context.");
  assertEquals(result.runState.promptSlotBinding, contextPromptSlotBinding);
  assertEquals(
    result.runState.policyEvents[0]?.promptSlot,
    contextPromptSlotBinding,
  );
  assertEquals(result.runState.policyEvents[0]?.toolInputSummary, {
    type: "cf-harness.tool-input-summary",
    toolId: "write_file",
    path: "notes/out.txt",
    mode: "replace",
    contentBytes: 4,
    contentDigest:
      "sha256:ca3704aa0b06f5954c79ee837faa152d84d6b2d42838f0637a15eda8337dbdce",
  });
  assertEquals(
    result.runState.policyEvents[0]?.detail,
    "write_file requires direct-command authorization in enforce-explicit",
  );
});
