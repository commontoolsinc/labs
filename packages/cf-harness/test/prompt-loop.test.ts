import { assertEquals, assertRejects } from "@std/assert";
import type { HarnessArtifactStore } from "../src/artifacts.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";

class FakeSandboxRuntime implements SandboxRuntime {
  readonly kind = "docker-runsc-cfc" as const;
  readonly shellRequests: SandboxShellRequest[] = [];

  constructor(
    private readonly shellResults: SandboxCommandResult[] = [],
    private readonly shellError?: Error,
  ) {}

  resolvePath(path: string): string {
    return path.startsWith("/") ? path : `/workspace/${path}`;
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.shellRequests.push(request);
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
    ["bash", "read_file", "write_file"],
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
  });

  assertEquals(result.finalAssistantText, "No tool call needed.");
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
    detail: "bash would require direct-command authorization in enforce modes",
    at: "2026-04-15T22:30:02.000Z",
  }]);
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
    detail:
      "write_file requires direct-command authorization in enforce-explicit",
    observationDenied: {
      type: "cf-harness.observation-denied",
      reason: "not-authorized",
      detail:
        "write_file requires direct-command authorization in enforce-explicit",
    },
    at: "2026-04-15T22:40:02.000Z",
  }]);
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
    detail: "bash is not allowed in this run",
    observationDenied: {
      type: "cf-harness.observation-denied",
      reason: "not-authorized",
      detail: "bash is not allowed in this run",
    },
    at: "2026-04-16T23:20:02.000Z",
  }]);
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
