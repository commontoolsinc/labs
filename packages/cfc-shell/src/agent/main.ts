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
  type ContentPart,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
  runAgentLoop,
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
      body: JSON.stringify({ ...request, cache: false, stream: true }),
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
          }
          if (event.type === "text-delta") {
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

    return {
      role: "assistant",
      content: content.length > 0 ? content : text,
      id,
    };
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  `You are a shell assistant. You MUST use the exec tool to run commands — never just describe what you would do.

You have one tool: exec. It runs a shell command in a sandboxed environment with a virtual filesystem. The shell supports: cat, echo, grep, sed, jq, wc, sort, head, tail, ls, pwd, cd, cp, mv, rm, mkdir, test, curl, true, false, pipes, and redirects.

Rules:
- ALWAYS call the exec tool when the user asks you to do something. Do not just explain — execute.
- You can chain commands with pipes: echo "hello" | grep hello
- You can redirect output: echo "data" > /tmp/file.txt
- If output is filtered, the content didn't meet the security policy — this is expected for untrusted data.
- After executing, briefly explain what happened.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): { prompt?: string } {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-p" || args[i] === "--prompt") && i + 1 < args.length) {
      return { prompt: args[i + 1] };
    }
  }
  return {};
}

async function runOnce(
  input: string,
  agent: AgentSession,
  llm: LLMClient,
  model: string,
  write: (s: string) => Promise<unknown>,
): Promise<void> {
  let eventCursor = agent.getEvents().length;

  await runAgentLoop(input, {
    llm,
    agent,
    model,
    system: SYSTEM_PROMPT,
    onToolCall: async (_toolName, input) => {
      await write(`\n  $ ${input.command}\n`);
    },
    onToolResult: async (_cmd, res) => {
      const events = agent.getEvents();
      for (let i = eventCursor; i < events.length; i++) {
        const ev = events[i];
        if (ev.type === "sub-agent-started") {
          await write(`  [sub-agent started: ${ev.policy}]\n`);
        } else if (ev.type === "sub-agent-ended") {
          await write(`  [sub-agent ended]\n`);
        }
      }
      eventCursor = events.length;

      if (res.filtered) {
        await write(`  [filtered: ${res.filterReason}]\n`);
      } else if (res.stdout) {
        const lines = res.stdout.split("\n").map((l) => `  ${l}`).join("\n");
        await write(`${lines}\n`);
      }
      if (res.exitCode !== 0) {
        await write(`  [exit code: ${res.exitCode}]\n`);
      }
    },
  });

  // Text was already streamed to stdout by readStream
  await write("\n");
}

async function main(): Promise<void> {
  const { prompt: oneShot } = parseArgs(Deno.args);
  const model = Deno.env.get("MODEL") ?? "anthropic:claude-sonnet-4-5";
  const llm = new FetchLLMClient();
  const vfs = new VFS();
  const agent = new AgentSession({ policy: policies.main(), vfs });

  const encoder = new TextEncoder();
  const write = (s: string) => Deno.stdout.write(encoder.encode(s));

  if (oneShot) {
    try {
      await runOnce(oneShot, agent, llm, model, write);
    } catch (e) {
      await write(`[error: ${e instanceof Error ? e.message : String(e)}]\n`);
      Deno.exit(1);
    }
    return;
  }

  await write("CFC LLM Agent\n");
  await write(`Model: ${model}\n`);
  await write("Type your message. Ctrl-D or 'exit' to quit.\n\n");

  while (true) {
    const input = prompt("user>");
    if (input === null || input.trim() === "exit") {
      await write("\nGoodbye.\n");
      break;
    }
    if (!input.trim()) continue;

    await write("\n---\n");

    try {
      await runOnce(input, agent, llm, model, write);
      await write("\n");
    } catch (e) {
      await write(
        `\n[error: ${e instanceof Error ? e.message : String(e)}]\n\n`,
      );
    }
  }
}

if (import.meta.main) {
  await main();
}
