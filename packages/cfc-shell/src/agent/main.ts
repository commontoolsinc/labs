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
  type Message,
  runAgentLoop,
} from "./llm-loop.ts";
import { VFS } from "../vfs.ts";
import {
  boxEnd,
  boxStart,
  createStreamFormatter,
  fmtCommand,
  fmtOutput,
  fmtPrefixed,
  fmtStatus,
} from "./tui.ts";

// ---------------------------------------------------------------------------
// Minimal fetch-based LLM client (no dependency on @commontools/llm)
// ---------------------------------------------------------------------------

class FetchLLMClient implements LLMClient {
  private baseUrl: string;
  /** Called for each streaming text delta. Set externally to route through TUI. */
  onDelta?: (text: string) => void;

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
            this.onDelta?.(event.textDelta);
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

You have two tools:
- exec: Run a shell command in a sandboxed environment with a virtual filesystem. The shell supports: cat, echo, grep, sed, jq, wc, sort, head, tail, ls, pwd, cd, cp, mv, rm, mkdir, test, curl, true, false, pipes, and redirects.
- task: Delegate work to a sub-agent that can see data you cannot. Your visibility policy filters out untrusted content (e.g., network-fetched HTML), but a sub-agent has a relaxed policy and can read it. The sub-agent's response is declassified before you see it: if it matches one of your ballots (safe return strings you provide), it's trusted. If it matches a captured command output (like wc -l), it inherits that output's label. Use task when you need to inspect or process untrusted data and report back a safe summary.

Rules:
- ALWAYS call the exec tool when the user asks you to do something. Do not just explain — execute.
- You can chain commands with pipes: echo "hello" | grep hello
- You can redirect output: echo "data" > /tmp/file.txt
- If output is filtered, the content didn't meet the security policy — use the task tool to delegate to a sub-agent that can see it.
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
  history?: Message[],
): Promise<Message[]> {
  // Track current depth for streaming text formatting
  let currentDepth = 0;
  const streamFmt = createStreamFormatter(() => currentDepth);

  // Route streaming deltas through the TUI formatter
  llm.onDelta = (text: string) => {
    const formatted = streamFmt.format(text);
    if (formatted) {
      const encoder = new TextEncoder();
      Deno.stdout.writeSync(encoder.encode(formatted));
    }
  };

  const result = await runAgentLoop(input, {
    llm,
    agent,
    model,
    system: SYSTEM_PROMPT,
    history,
    onToolCall: async (toolName, input, depth) => {
      // Blank line separator at depth 0; inside a box, newline only if
      // we're not already at line start (avoids gaps in the frame).
      const atLn = streamFmt.isAtLineStart();
      const sep = depth > 0 ? (atLn ? "" : "\n") : "\n\n";
      if (toolName === "task") {
        const task = String(input.task ?? "");
        const ballots = Array.isArray(input.ballots)
          ? (input.ballots as string[]).map(String)
          : [];
        const ballotsStr = ballots.length > 0
          ? ` [ballots: ${ballots.map((b) => `"${b}"`).join(", ")}]`
          : "";
        await write(
          `${sep}${fmtPrefixed("#", task + ballotsStr, depth)}\n`,
        );
      } else {
        const cmd = String(input.command ?? "");
        await write(`${sep}${fmtCommand(cmd, depth)}\n`);
      }
      streamFmt.setAtLineStart();
    },
    onToolResult: async (_cmd, res, depth) => {
      if (res.filtered) {
        await write(`${fmtStatus(`[filtered: ${res.filterReason}]`, depth)}\n`);
      } else if (res.stdout) {
        await write(`${fmtOutput(res.stdout, depth)}\n`);
      }
      if (res.exitCode !== 0) {
        await write(`${fmtStatus(`[exit code: ${res.exitCode}]`, depth)}\n`);
      }
      streamFmt.setAtLineStart();
    },
    onTaskStart: async (_task, policy, depth) => {
      currentDepth = depth;
      streamFmt.reset();
      await write(`\n${boxStart(`sub-agent (${policy} policy)`, depth)}\n`);
      streamFmt.setAtLineStart();
    },
    onTaskEnd: async (response, label, filtered, depth) => {
      const labelDesc = label.integrity.length > 0
        ? label.integrity.map((a) => a.kind).join(", ")
        : "none";
      const prefix = filtered ? "[FILTERED] " : "";
      const summary = `${prefix}"${response.slice(0, 60)}${
        response.length > 60 ? "…" : ""
      }" [integrity: ${labelDesc}]`;
      const endSep = streamFmt.isAtLineStart() ? "" : "\n";
      await write(`${endSep}${boxEnd(summary, depth)}\n`);
      currentDepth = depth - 1;
      streamFmt.reset();
      streamFmt.setAtLineStart();
    },
    onTaskRetry: async (attempt, depth) => {
      await write(
        `${fmtStatus(`[response blocked — retry ${attempt}/3]`, depth)}\n`,
      );
      streamFmt.reset();
      streamFmt.setAtLineStart();
    },
    onAssistantMessage: () => {
      streamFmt.reset();
    },
  });

  // Text was already streamed to stdout by readStream
  await write("\n");
  return result.messages;
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

  let history: Message[] = [];

  while (true) {
    const input = prompt(">");
    if (input === null || input.trim() === "exit") {
      await write("\nGoodbye.\n");
      break;
    }
    if (!input.trim()) continue;

    try {
      history = await runOnce(input, agent, llm, model, write, history);
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
