import { assertEquals, assertRejects } from "@std/assert";
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

  async run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.shellRequests.push(request);
    if (this.shellError) {
      throw this.shellError;
    }
    return this.shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

Deno.test("CfHarnessPromptLoop runs a tool call and returns the final assistant response", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
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
    fetchFn: async (_input, init) => {
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
      return new Response(JSON.stringify(payload), { status: 200 });
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

Deno.test("CfHarnessPromptLoop completes a direct assistant response without tool calls", async () => {
  const loop = new CfHarnessPromptLoop({
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
    fetchFn: async () =>
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
  });

  const result = await loop.runPrompt({
    prompt: "Say hi.",
  });

  assertEquals(result.finalAssistantText, "No tool call needed.");
  assertEquals(result.runState.status, "completed");
  assertEquals(result.runState.toolOutputs, []);
});

Deno.test("CfHarnessPromptLoop fails when the model exceeds the configured turn cap", async () => {
  const loop = new CfHarnessPromptLoop({
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime([
        { stdout: "hello", stderr: "", exitCode: 0 },
      ]),
      runId: "run-max-turns",
      model: "gpt-5.4",
    }),
    maxModelTurns: 1,
    fetchFn: async () =>
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
  });

  await assertRejects(
    () => loop.runPrompt({ prompt: "Loop forever." }),
    Error,
    "prompt loop exceeded max model turns (1)",
  );
  assertEquals(loop.engine.getRunState().status, "failed");
});

Deno.test("CfHarnessPromptLoop can resume from a persisted transcript", async () => {
  const fetchCalls: RequestInit[] = [];
  const loop = new CfHarnessPromptLoop({
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-resume",
      model: "gpt-5.4",
    }),
    fetchFn: async (_input, init) => {
      fetchCalls.push(init ?? {});
      return new Response(
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
});
