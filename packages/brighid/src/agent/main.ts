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

type ReadLineInterface = {
  question(prompt: string): Promise<string>;
  close(): void;
};

// ---------------------------------------------------------------------------
// Minimal fetch-based LLM client (no dependency on @commontools/llm)
// ---------------------------------------------------------------------------

class FetchLLMClient implements LLMClient {
  private endpoint: string;
  private apiKey?: string;
  onDelta?: (text: string) => void;

  constructor(apiUrl?: string) {
    const base = apiUrl ?? Deno.env.get("API_URL") ??
      "https://llm.stage.commontools.dev";
    this.endpoint = this.resolveEndpoint(base);
    this.apiKey = Deno.env.get("OPENAI_API_KEY") ??
      Deno.env.get("LLM_API_KEY") ??
      Deno.env.get("API_KEY") ??
      Deno.env.get("CFTS_AI_LLM_OPENAI_API_KEY") ??
      undefined;
  }

  async sendRequest(request: LLMRequest): Promise<LLMResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(this.toOpenAIRequest(request)),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw new Error("LLM API response missing choices[0].message");
    }

    const content: ContentPart[] = [];
    const text = this.extractAssistantText(message.content);
    if (text) {
      content.push({ type: "text", text });
      this.onDelta?.(text);
    }

    for (const toolCall of message.tool_calls ?? []) {
      content.push({
        type: "tool-call",
        toolCallId: String(toolCall.id),
        toolName: String(toolCall.function?.name ?? "unknown"),
        input: this.parseToolInput(toolCall.function?.arguments),
      });
    }

    return {
      role: "assistant",
      content: content.length === 1 && content[0].type === "text"
        ? content[0].text
        : content,
      id: String(data.id ?? "unknown"),
    };
  }

  private resolveEndpoint(base: string): string {
    const url = new URL(base);
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/v1/chat/completions";
    }
    return url.toString();
  }

  private toOpenAIRequest(request: LLMRequest): Record<string, unknown> {
    return {
      model: request.model,
      messages: this.toOpenAIMessages(request),
      tools: request.tools
        ? Object.entries(request.tools).map(([name, def]) => ({
          type: "function",
          function: {
            name,
            description: def.description,
            parameters: def.inputSchema,
          },
        }))
        : undefined,
      tool_choice: request.tools ? "auto" : undefined,
      max_tokens: request.maxTokens ?? 4096,
    };
  }

  private toOpenAIMessages(
    request: LLMRequest,
  ): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];

    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }

    for (const message of request.messages) {
      if (typeof message.content === "string") {
        messages.push({ role: message.role, content: message.content });
        continue;
      }

      if (message.role === "assistant") {
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        const toolCalls = message.content
          .filter((part) => part.type === "tool-call")
          .map((part) => ({
            id: part.toolCallId,
            type: "function",
            function: {
              name: part.toolName,
              arguments: JSON.stringify(part.input),
            },
          }));

        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
        continue;
      }

      if (message.role === "tool") {
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          messages.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: part.output.value,
          });
        }
        continue;
      }

      messages.push({
        role: message.role,
        content: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      });
    }

    return messages;
  }

  private extractAssistantText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .filter((part): part is { type: string; text?: string } =>
        typeof part === "object" && part !== null
      )
      .map((part) => part.type === "text" ? (part.text ?? "") : "")
      .join("");
  }

  private parseToolInput(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "string" || raw.trim() === "") {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  `You are Brighid, a shell assistant. You MUST use the exec tool to run commands — never just describe what you would do.

You have two tools:
- exec: Run a command in the Brighid sandbox shell. Ordinary shell-like commands run through the real sandboxed backend by default. Only current-shell state commands such as cd, export, unset, env, printenv, read, source, test, and [ remain supervisor-side.
- task: Delegate work to a sub-agent that can see data you cannot. Your visibility policy filters out untrusted content (e.g., network-fetched HTML), but a sub-agent has a relaxed policy and can read it. For classification tasks (yes/no questions), provide ballots — short fixed strings the sub-agent can return. For open-ended tasks (summaries, explanations, discoveries), omit ballots entirely — the response will pass through if all data the sub-agent accessed was clean (no curl/network data).

Rules:
- ALWAYS call the exec tool when the user asks you to do something. Do not just explain — execute.
- You can chain commands with pipes: echo "hello" | grep hello
- You can redirect output: echo "data" > /tmp/file.txt
- Plain shell-like commands already use the real sandbox backend. Use bash -c or bash <script> when you need explicit shell composition or multi-command syntax.
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
        const ballotsLine = ballots.length > 0
          ? `\n${
            fmtStatus(
              `[ballots: ${ballots.map((b) => `"${b}"`).join(", ")}]`,
              depth,
            )
          }`
          : "";
        await write(
          `${sep}${fmtPrefixed("#", task, depth)}${ballotsLine}\n`,
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

  if (result.response) {
    await write(`${result.response}\n`);
  } else {
    await write("\n");
  }
  return result.messages;
}

async function main(): Promise<void> {
  const { prompt: oneShot } = parseArgs(Deno.args);
  const model = Deno.env.get("MODEL") ?? "claude-sonnet-4-6";
  const llm = new FetchLLMClient();
  const vfs = new VFS();
  const agent = new AgentSession({
    policy: policies.main(),
    vfs,
    registryMode: "real-shell",
  });

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

  await write("Brighid\n");
  await write(`Model: ${model}\n`);
  await write("Type your message. Ctrl-D or 'exit' to quit.\n\n");

  let history: Message[] = [];

  const rl = await createReadline();

  try {
    while (true) {
      const line = await readLine(rl, "> ");
      if (line === null || line.trim() === "exit") {
        await write("\nGoodbye.\n");
        break;
      }
      if (!line.trim()) continue;

      try {
        history = await runOnce(line, agent, llm, model, write, history);
        await write("\n");
      } catch (e) {
        await write(
          `\n[error: ${e instanceof Error ? e.message : String(e)}]\n\n`,
        );
      }
    }
  } finally {
    rl.close();
  }
}

async function readLine(
  rl: ReadLineInterface,
  promptText: string,
): Promise<string | null> {
  try {
    return await rl.question(promptText);
  } catch (error) {
    if (
      error instanceof Error && error.message.includes("readline was closed")
    ) {
      return null;
    }
    throw error;
  }
}

async function createReadline(): Promise<ReadLineInterface> {
  const [{ default: readline }, { stdin: input, stdout: output }] =
    await Promise.all([
      import("node:readline/promises"),
      import("node:process"),
    ]);

  return readline.createInterface({
    input,
    output,
    historySize: 1000,
    removeHistoryDuplicates: true,
  });
}

if (import.meta.main) {
  await main();
}
