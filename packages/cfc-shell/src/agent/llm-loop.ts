/**
 * LLM Agent Loop — drives an AgentSession via LLM tool-calling.
 *
 * The loop is simple:
 *   1. Send conversation history + tool definitions to LLM
 *   2. If LLM responds with tool calls, execute them via AgentSession.exec()
 *   3. Feed results back as tool-result messages
 *   4. Repeat until LLM responds with text only (no tool calls)
 *
 * The LLM client interface is minimal and injectable — no direct dependency
 * on @commontools/llm. Pass in a real LLMClient or a mock.
 */

import { AgentSession } from "./agent-session.ts";
import { ToolResult } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Minimal LLM types (mirrors @commontools/api + @commontools/llm)
// ---------------------------------------------------------------------------

/** A content part in a message */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } };

/** A message in the conversation */
export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[];
}

/** Tool definition for the LLM */
export interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Request to the LLM */
export interface LLMRequest {
  messages: readonly Message[];
  model: string;
  system?: string;
  tools?: Record<string, ToolDef>;
  maxTokens?: number;
}

/** Response from the LLM */
export interface LLMResponse {
  role: "assistant";
  content: string | ContentPart[];
  id: string;
}

/** Minimal LLM client interface — implement or adapt from @commontools/llm */
export interface LLMClient {
  sendRequest(request: LLMRequest): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// Tool definition for `exec`
// ---------------------------------------------------------------------------

const EXEC_TOOL: Record<string, ToolDef> = {
  exec: {
    description:
      "Execute a shell command in the CFC sandbox. " +
      "The command string is interpreted by the CFC shell which supports " +
      "pipes, redirects, variables, and common Unix commands (cat, grep, sed, " +
      "jq, echo, etc.). Output is security-filtered based on the agent's " +
      "visibility policy.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
      },
      required: ["command"],
    },
  },
};

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

export interface AgentLoopOptions {
  /** LLM client to use */
  llm: LLMClient;
  /** Agent session (provides exec + policy filtering) */
  agent: AgentSession;
  /** Model name (e.g. "anthropic:claude-sonnet-4-5") */
  model: string;
  /** System prompt */
  system?: string;
  /** Maximum number of loop iterations (tool-call rounds). Default: 20 */
  maxIterations?: number;
  /** Called after each exec with the tool result */
  onToolResult?: (command: string, result: ToolResult) => void;
  /** Called with each assistant message */
  onAssistantMessage?: (message: LLMResponse) => void;
}

export interface AgentLoopResult {
  /** The final text response from the LLM */
  response: string;
  /** Full conversation history */
  messages: Message[];
  /** Number of tool-call iterations */
  iterations: number;
}

/**
 * Run the agent loop: user message → LLM → tool calls → exec → repeat.
 */
export async function runAgentLoop(
  userMessage: string,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    llm,
    agent,
    model,
    system,
    maxIterations = 20,
    onToolResult,
    onAssistantMessage,
  } = options;

  const messages: Message[] = [
    { role: "user", content: userMessage },
  ];

  let iterations = 0;

  while (iterations < maxIterations) {
    // Call LLM
    const response = await llm.sendRequest({
      messages,
      model,
      system,
      tools: EXEC_TOOL,
    });

    onAssistantMessage?.(response);

    // Add assistant message to history
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // Extract tool calls
    const toolCalls = extractToolCalls(response.content);

    if (toolCalls.length === 0) {
      // No tool calls — LLM is done, extract final text
      const responseText = extractText(response.content);
      return { response: responseText, messages, iterations };
    }

    iterations++;

    // Execute each tool call and collect results
    const resultParts: ContentPart[] = [];

    for (const tc of toolCalls) {
      if (tc.toolName !== "exec") {
        resultParts.push({
          type: "tool-result",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: { type: "text", value: `Error: unknown tool "${tc.toolName}"` },
        });
        continue;
      }

      const command = String(tc.input.command ?? "");
      const result = await agent.exec(command);

      onToolResult?.(command, result);

      // Format output for the LLM
      let outputText = result.stdout;
      if (result.stderr) {
        outputText += (outputText ? "\n" : "") + `[stderr] ${result.stderr}`;
      }
      if (result.filtered) {
        outputText += (outputText ? "\n" : "") +
          `[filtered: ${result.filterReason ?? "policy"}]`;
      }
      outputText += `\n[exit code: ${result.exitCode}]`;

      resultParts.push({
        type: "tool-result",
        toolCallId: tc.toolCallId,
        toolName: "exec",
        output: { type: "text", value: outputText },
      });
    }

    // Add tool results as a single tool message
    messages.push({
      role: "tool",
      content: resultParts,
    });
  }

  // Hit max iterations — return what we have
  const lastAssistant = [...messages].reverse().find(
    (m) => m.role === "assistant",
  );
  const responseText = lastAssistant
    ? extractText(lastAssistant.content)
    : "[Agent loop reached maximum iterations]";

  return { response: responseText, messages, iterations };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToolCalls(
  content: string | ContentPart[],
): Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }> {
  if (typeof content === "string") return [];
  return content
    .filter((p): p is ContentPart & { type: "tool-call" } => p.type === "tool-call")
    .map((p) => ({
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      input: p.input,
    }));
}

function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
    .map((p) => p.text)
    .join("");
}
