/**
 * Tests for the LLM Agent Loop
 */

import { assertEquals } from "jsr:@std/assert";
import {
  runAgentLoop,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
  type Message,
  type ContentPart,
} from "../src/agent/llm-loop.ts";
import { AgentSession, policies } from "../src/agent/mod.ts";
import { VFS } from "../src/vfs.ts";
import { labels } from "../src/labels.ts";

/**
 * Mock LLM client that returns pre-configured responses in order.
 */
class MockLLM implements LLMClient {
  private responses: LLMResponse[] = [];
  readonly requests: LLMRequest[] = [];

  /** Queue a response */
  addResponse(response: LLMResponse): void {
    this.responses.push(response);
  }

  /** Queue a text-only response (no tool calls) */
  addTextResponse(text: string): void {
    this.responses.push({
      role: "assistant",
      content: text,
      id: `mock-${this.responses.length}`,
    });
  }

  /** Queue a tool-call response */
  addToolCallResponse(command: string): void {
    this.responses.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${this.responses.length}`,
          toolName: "exec",
          input: { command },
        },
      ],
      id: `mock-${this.responses.length}`,
    });
  }

  async sendRequest(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("MockLLM: no more responses queued");
    }
    return response;
  }
}

function createAgent(vfs?: VFS): AgentSession {
  return new AgentSession({
    policy: policies.main(),
    vfs: vfs ?? new VFS(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("simple text response — no tool calls", async () => {
  const llm = new MockLLM();
  llm.addTextResponse("Hello! I can help you with that.");

  const agent = createAgent();
  const result = await runAgentLoop("Hi", {
    llm,
    agent,
    model: "test:mock",
  });

  assertEquals(result.response, "Hello! I can help you with that.");
  assertEquals(result.iterations, 0);
  assertEquals(result.messages.length, 2); // user + assistant
  assertEquals(llm.requests.length, 1);
  assertEquals(llm.requests[0].tools !== undefined, true);
});

Deno.test("single tool call then text response", async () => {
  const vfs = new VFS();
  vfs.writeFile("/hello.txt", "world", labels.userInput());

  const llm = new MockLLM();
  llm.addToolCallResponse("cat /hello.txt");
  llm.addTextResponse("The file contains: world");

  const agent = createAgent(vfs);
  const result = await runAgentLoop("What's in /hello.txt?", {
    llm,
    agent,
    model: "test:mock",
  });

  assertEquals(result.response, "The file contains: world");
  assertEquals(result.iterations, 1);
  // user + assistant(tool-call) + tool(result) + assistant(text)
  assertEquals(result.messages.length, 4);
});

Deno.test("multiple sequential tool calls", async () => {
  const vfs = new VFS();
  vfs.writeFile("/a.txt", "alpha", labels.userInput());
  vfs.writeFile("/b.txt", "beta", labels.userInput());

  const llm = new MockLLM();
  llm.addToolCallResponse("cat /a.txt");
  llm.addToolCallResponse("cat /b.txt");
  llm.addTextResponse("File a has alpha, file b has beta.");

  const agent = createAgent(vfs);
  const result = await runAgentLoop("Read both files", {
    llm,
    agent,
    model: "test:mock",
  });

  assertEquals(result.response, "File a has alpha, file b has beta.");
  assertEquals(result.iterations, 2);
});

Deno.test("tool result callback is invoked", async () => {
  const vfs = new VFS();
  vfs.writeFile("/test.txt", "data", labels.userInput());

  const llm = new MockLLM();
  llm.addToolCallResponse("cat /test.txt");
  llm.addTextResponse("Done.");

  const agent = createAgent(vfs);
  const toolResults: Array<{ command: string; exitCode: number }> = [];

  await runAgentLoop("Read the file", {
    llm,
    agent,
    model: "test:mock",
    onToolResult: (cmd, res) => {
      toolResults.push({ command: cmd, exitCode: res.exitCode });
    },
  });

  assertEquals(toolResults.length, 1);
  assertEquals(toolResults[0].command, "cat /test.txt");
  assertEquals(toolResults[0].exitCode, 0);
});

Deno.test("system prompt is forwarded to LLM", async () => {
  const llm = new MockLLM();
  llm.addTextResponse("OK");

  const agent = createAgent();
  await runAgentLoop("Hi", {
    llm,
    agent,
    model: "test:mock",
    system: "You are a helpful assistant.",
  });

  assertEquals(llm.requests[0].system, "You are a helpful assistant.");
});

Deno.test("max iterations prevents infinite loop", async () => {
  const llm = new MockLLM();
  // Always return a tool call — should be cut off by maxIterations
  for (let i = 0; i < 10; i++) {
    llm.addToolCallResponse("echo loop");
  }

  const agent = createAgent();
  const result = await runAgentLoop("Loop forever", {
    llm,
    agent,
    model: "test:mock",
    maxIterations: 3,
  });

  assertEquals(result.iterations, 3);
});

Deno.test("unknown tool name returns error", async () => {
  const llm = new MockLLM();
  llm.addResponse({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call-bad",
        toolName: "unknown_tool",
        input: { foo: "bar" },
      },
    ],
    id: "mock-bad-tool",
  });
  llm.addTextResponse("I see the error.");

  const agent = createAgent();
  const result = await runAgentLoop("Do something", {
    llm,
    agent,
    model: "test:mock",
  });

  // The tool result should contain an error about unknown tool
  const toolMsg = result.messages.find((m) => m.role === "tool");
  assertEquals(toolMsg !== undefined, true);
  const parts = toolMsg!.content as ContentPart[];
  const resultPart = parts.find(
    (p) => p.type === "tool-result",
  ) as ContentPart & { type: "tool-result" };
  assertEquals(resultPart.output.value.includes("unknown tool"), true);
});

Deno.test("policy filtering is visible in tool results", async () => {
  const vfs = new VFS();
  // Write a file with low-integrity label (no InjectionFree)
  const llmLabel = labels.llmGenerated("gpt-4");
  vfs.writeFile("/tainted.txt", "injected content", llmLabel);

  const llm = new MockLLM();
  llm.addToolCallResponse("cat /tainted.txt");
  llm.addTextResponse("I see filtered output.");

  // Main policy requires InjectionFree
  const agent = createAgent(vfs);

  const toolResults: Array<{ filtered: boolean }> = [];
  await runAgentLoop("Read the tainted file", {
    llm,
    agent,
    model: "test:mock",
    onToolResult: (_cmd, res) => {
      toolResults.push({ filtered: res.filtered });
    },
  });

  assertEquals(toolResults.length, 1);
  assertEquals(toolResults[0].filtered, true);
});

Deno.test("exec tool result is sent back to LLM", async () => {
  const vfs = new VFS();
  // Use a file with InjectionFree so it passes the main agent filter
  vfs.writeFile("/msg.txt", "hello world", labels.userInput());

  const llm = new MockLLM();
  llm.addToolCallResponse("cat /msg.txt");
  llm.addTextResponse("Got it.");

  const agent = createAgent(vfs);
  const result = await runAgentLoop("Read the message", {
    llm,
    agent,
    model: "test:mock",
  });

  // The tool result message should exist in history
  const toolMsg = result.messages.find((m) => m.role === "tool");
  assertEquals(toolMsg !== undefined, true);
  const parts = toolMsg!.content as ContentPart[];
  const resultPart = parts.find((p) => p.type === "tool-result") as ContentPart & { type: "tool-result" };
  // Output includes either the content or a filtered notice + exit code
  assertEquals(resultPart.output.value.includes("exit code"), true);
});
