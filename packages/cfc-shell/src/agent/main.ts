/**
 * CFC LLM Agent — Interactive CLI that drives the CFC shell via an LLM.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-write --allow-run --allow-net src/agent/main.ts
 *
 * Environment:
 *   API_URL  — Toolshed URL for the LLM API (default: uses @commontools/llm default)
 *   MODEL    — Model name (default: "anthropic:claude-sonnet-4-5")
 *
 * The agent gets a single tool: `exec`, which runs commands through the
 * label-aware CFC shell. Output is filtered by the main-agent policy
 * (requires InjectionFree integrity).
 */

import { AgentSession, policies } from "./mod.ts";
import {
  runAgentLoop,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
  type ContentPart,
} from "./llm-loop.ts";
import { VFS } from "../vfs.ts";

// ---------------------------------------------------------------------------
// Minimal fetch-based LLM client (no dependency on @commontools/llm)
// ---------------------------------------------------------------------------

class FetchLLMClient implements LLMClient {
  private baseUrl: string;

  constructor(apiUrl?: string) {
    const base = apiUrl ?? Deno.env.get("API_URL") ?? "http://localhost:8000";
    this.baseUrl = new URL("/api/ai/llm", base).toString();
  }

  async sendRequest(request: LLMRequest): Promise<LLMResponse> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    // Handle JSON (cached) responses
    if (response.headers.get("content-type") === "application/json") {
      const data = await response.json();
      return {
        role: "assistant",
        content: data.content,
        id: response.headers.get("x-ct-llm-trace-id") ?? "unknown",
      };
    }

    // Handle streaming NDJSON
    const id = response.headers.get("x-ct-llm-trace-id") ?? "unknown";
    return await this.readStream(response.body!, id);
  }

  private async readStream(
    body: ReadableStream,
    id: string,
  ): Promise<LLMResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCalls: ContentPart[] = [];
    let done = false;

    while (!done) {
      const { value, done: eof } = await reader.read();
      done = eof;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        try {
          const event = JSON.parse(line);
          if (typeof event === "string") {
            text += event;
          } else if (event.type === "text-delta") {
            text += event.textDelta;
            // Print streaming text as it arrives
            const encoder = new TextEncoder();
            await Deno.stdout.write(encoder.encode(event.textDelta));
          } else if (event.type === "tool-call") {
            toolCalls.push({
              type: "tool-call",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.args,
            });
          } else if (event.type === "finish") {
            break;
          }
        } catch {
          // skip unparseable lines
        }
      }
    }

    const content: ContentPart[] = [];
    if (text) content.push({ type: "text", text });
    content.push(...toolCalls);

    return { role: "assistant", content: content.length > 0 ? content : text, id };
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful assistant with access to a sandboxed shell environment.

You have one tool: \`exec\`, which executes a shell command. The shell supports common Unix commands: cat, echo, grep, sed, jq, wc, sort, head, tail, ls, pwd, cd, cp, mv, rm, mkdir, test, true, false, and pipes/redirects.

The shell operates on a virtual filesystem. Files you create persist within the session.

Guidelines:
- Use exec to run commands when the user asks you to do something
- You can chain commands with pipes: echo "hello" | grep hello
- You can redirect output: echo "data" > /tmp/file.txt
- Explain what you're doing and share results
- If a command's output is filtered, it means the content didn't meet the security policy — this is expected for untrusted data`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const model = Deno.env.get("MODEL") ?? "anthropic:claude-sonnet-4-5";
  const llm = new FetchLLMClient();
  const vfs = new VFS();
  const agent = new AgentSession({ policy: policies.main(), vfs });

  const encoder = new TextEncoder();
  const write = (s: string) => Deno.stdout.write(encoder.encode(s));

  await write("CFC LLM Agent\n");
  await write(`Model: ${model}\n`);
  await write("Type your message. Ctrl-D or 'exit' to quit.\n\n");

  while (true) {
    await write("you> ");
    const input = prompt("");
    if (input === null || input.trim() === "exit") {
      await write("\nGoodbye.\n");
      break;
    }
    if (!input.trim()) continue;

    await write("\nassistant> ");

    try {
      const result = await runAgentLoop(input, {
        llm,
        agent,
        model,
        system: SYSTEM_PROMPT,
        onToolResult: async (cmd, res) => {
          let output = `\n  [exec] ${cmd}\n`;
          if (res.filtered) {
            output += `  [filtered: ${res.filterReason}]\n`;
          } else if (res.stdout) {
            // Indent command output
            const lines = res.stdout.split("\n").map((l) => `  ${l}`).join("\n");
            output += `${lines}\n`;
          }
          if (res.exitCode !== 0) {
            output += `  [exit code: ${res.exitCode}]\n`;
          }
          await write(output);
        },
      });

      // If the response wasn't already streamed, print it
      if (result.response && !result.response.startsWith("[")) {
        await write(result.response);
      }
      await write("\n\n");
    } catch (e) {
      await write(`\n[error: ${e instanceof Error ? e.message : String(e)}]\n\n`);
    }
  }
}

if (import.meta.main) {
  await main();
}
