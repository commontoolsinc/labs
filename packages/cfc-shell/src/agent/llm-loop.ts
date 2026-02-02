/**
 * LLM Agent Loop — drives an AgentSession via LLM tool-calling.
 *
 * The loop is simple:
 *   1. Send conversation history + tool definitions to LLM
 *   2. If LLM responds with tool calls, execute them via AgentSession.exec()
 *      or dispatch sub-agent tasks via the `task` tool
 *   3. Feed results back as tool-result messages
 *   4. Repeat until LLM responds with text only (no tool calls)
 *
 * The LLM client interface is minimal and injectable — no direct dependency
 * on @commontools/llm. Pass in a real LLMClient or a mock.
 */

import { AgentSession } from "./agent-session.ts";
import { filterOutput, policies } from "./policy.ts";
import { ToolResult } from "./protocol.ts";
import { type Label, labels } from "../labels.ts";

// ---------------------------------------------------------------------------
// Minimal LLM types (mirrors @commontools/api + @commontools/llm)
// ---------------------------------------------------------------------------

/** A content part in a message */
export type ContentPart =
  | { type: "text"; text: string }
  | {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }
  | {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text"; value: string };
  };

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
// Tool definitions for `exec` and `task`
// ---------------------------------------------------------------------------

const AGENT_TOOLS: Record<string, ToolDef> = {
  exec: {
    description: "Execute a shell command in the CFC sandbox. " +
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
  task: {
    description: "Delegate a task to a sub-agent with a relaxed visibility " +
      "policy. The sub-agent can see data that this agent cannot (e.g., " +
      "untrusted network content). The sub-agent's final text response is " +
      "declassified by checking it against ballots (safe return strings you " +
      "provide) and captured command outputs. If the response matches a " +
      "ballot, it is endorsed as InjectionFree. If it matches a command " +
      "output (e.g., the result of `wc -l`), it inherits that output's label.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Instructions for the sub-agent",
        },
        policy: {
          type: "string",
          enum: ["sub", "restricted"],
          description:
            'Sub-agent policy. "sub" (default) can see everything. "restricted" can see everything but cannot spawn further sub-agents.',
        },
        ballots: {
          type: "array",
          items: { type: "string" },
          description:
            "Safe return strings. If the sub-agent responds with one of these exactly, it is endorsed as InjectionFree (you authored it).",
        },
      },
      required: ["task"],
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
  /** Prior conversation history to prepend (for multi-turn sessions) */
  history?: Message[];
  /** Nesting depth (0 = root agent). Used for output prefixing. */
  depth?: number;
  /** Called before each tool execution (depth: 0 = root agent) */
  onToolCall?: (
    toolName: string,
    input: Record<string, unknown>,
    depth: number,
  ) => void;
  /** Called after each exec with the tool result (depth: 0 = root agent) */
  onToolResult?: (command: string, result: ToolResult, depth: number) => void;
  /** Called with each assistant message */
  onAssistantMessage?: (message: LLMResponse) => void;
  /** Called when a sub-agent task starts */
  onTaskStart?: (
    task: string,
    policy: string,
    depth: number,
  ) => void;
  /** Called when a sub-agent task ends */
  onTaskEnd?: (
    response: string,
    label: Label,
    filtered: boolean,
    depth: number,
  ) => void;
}

export interface AgentLoopResult {
  /** The final text response from the LLM */
  response: string;
  /** Full conversation history */
  messages: Message[];
  /** Number of tool-call iterations */
  iterations: number;
  /** Label representing what the LLM has seen (taint of conversation context) */
  label: Label;
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
    depth = 0,
    onToolCall,
    onToolResult,
    onAssistantMessage,
    onTaskStart,
    onTaskEnd,
  } = options;

  const messages: Message[] = [
    ...(options.history ?? []),
    { role: "user", content: userMessage },
  ];

  let iterations = 0;
  let conversationLabel = labels.userInput();

  while (iterations < maxIterations) {
    // Call LLM
    const response = await llm.sendRequest({
      messages,
      model,
      system,
      tools: AGENT_TOOLS,
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
      return {
        response: responseText,
        messages,
        iterations,
        label: conversationLabel,
      };
    }

    iterations++;

    // Execute each tool call and collect results
    const resultParts: ContentPart[] = [];

    for (const tc of toolCalls) {
      if (tc.toolName === "exec") {
        onToolCall?.(tc.toolName, tc.input, depth);
        const command = String(tc.input.command ?? "");
        const result = await agent.exec(command);

        onToolResult?.(command, result, depth);
        conversationLabel = labels.join(conversationLabel, result.label);

        resultParts.push({
          type: "tool-result",
          toolCallId: tc.toolCallId,
          toolName: "exec",
          output: { type: "text", value: formatExecResult(result, depth) },
        });
      } else if (tc.toolName === "task") {
        onToolCall?.(tc.toolName, tc.input, depth);
        const taskText = String(tc.input.task ?? "");
        const policyName = String(tc.input.policy ?? "sub");
        const ballots = Array.isArray(tc.input.ballots)
          ? (tc.input.ballots as string[]).map(String)
          : [];

        const taskResult = await executeTask(
          agent,
          taskText,
          policyName,
          ballots,
          depth,
          {
            llm,
            model,
            system,
            maxIterations,
            onToolCall,
            onToolResult,
            onAssistantMessage,
            onTaskStart,
            onTaskEnd,
          },
        );
        conversationLabel = labels.join(conversationLabel, taskResult.label);

        resultParts.push({
          type: "tool-result",
          toolCallId: tc.toolCallId,
          toolName: "task",
          output: { type: "text", value: taskResult.text },
        });
      } else {
        resultParts.push({
          type: "tool-result",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: {
            type: "text",
            value: `Error: unknown tool "${tc.toolName}"`,
          },
        });
      }
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

  return {
    response: responseText,
    messages,
    iterations,
    label: conversationLabel,
  };
}

// ---------------------------------------------------------------------------
// Task tool implementation
// ---------------------------------------------------------------------------

async function executeTask(
  parentAgent: AgentSession,
  task: string,
  policyName: string,
  ballots: string[],
  parentDepth: number,
  loopOptions: {
    llm: LLMClient;
    model: string;
    system?: string;
    maxIterations?: number;
    onToolCall?: (
      toolName: string,
      input: Record<string, unknown>,
      depth: number,
    ) => void;
    onToolResult?: (command: string, result: ToolResult, depth: number) => void;
    onAssistantMessage?: (message: LLMResponse) => void;
    onTaskStart?: (task: string, policy: string, depth: number) => void;
    onTaskEnd?: (
      response: string,
      label: Label,
      filtered: boolean,
      depth: number,
    ) => void;
  },
): Promise<{ text: string; label: Label }> {
  const policy = policyName === "restricted"
    ? policies.restricted()
    : policies.sub();

  const child = parentAgent.spawnSubAgent(policy);

  try {
    const childDepth = parentDepth + 1;
    loopOptions.onTaskStart?.(task, policyName, childDepth);

    const result = await runAgentLoop(task, {
      ...loopOptions,
      agent: child,
      depth: childDepth,
    });

    // Declassify the sub-agent's response
    const declassified = parentAgent.declassifyReturn(
      child,
      result.response,
      ballots,
    );

    // Filter declassified result through parent's visibility policy
    const filtered = filterOutput(
      declassified.content,
      declassified.label,
      parentAgent.policy,
    );

    const labelDesc = declassified.label.integrity.length > 0
      ? declassified.label.integrity.map((a) => a.kind).join(", ")
      : "none";

    const isFiltered = filtered.filtered ?? false;
    const content = isFiltered
      ? `[FILTERED: ${filtered.reason ?? "policy"}]`
      : filtered.content;

    loopOptions.onTaskEnd?.(
      content,
      declassified.label,
      isFiltered,
      childDepth,
    );

    // LLM sees >> prefixed text; TUI display is handled by callbacks
    const raw = `${content}\n[integrity: ${labelDesc}]`;
    return { text: prefixLines(raw, childDepth), label: declassified.label };
  } catch (e) {
    child.end();
    return {
      text: `Error in sub-agent: ${e instanceof Error ? e.message : String(e)}`,
      label: labels.userInput(),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatExecResult(result: ToolResult, depth: number): string {
  let outputText = result.stdout;
  if (result.stderr) {
    outputText += (outputText ? "\n" : "") + `[stderr] ${result.stderr}`;
  }
  if (result.filtered) {
    outputText += (outputText ? "\n" : "") +
      `[filtered: ${result.filterReason ?? "policy"}]`;
  }
  outputText += `\n[exit code: ${result.exitCode}]`;
  return depth > 0 ? prefixLines(outputText, depth) : outputText;
}

/** Prefix each line with >> markers to indicate sub-agent nesting depth. */
function prefixLines(text: string, depth: number): string {
  if (depth <= 0) return text;
  const prefix = ">> ".repeat(depth);
  return text.split("\n").map((line) => line ? `${prefix}${line}` : line).join(
    "\n",
  );
}

function extractToolCalls(
  content: string | ContentPart[],
): Array<
  { toolCallId: string; toolName: string; input: Record<string, unknown> }
> {
  if (typeof content === "string") return [];
  return content
    .filter((p): p is ContentPart & { type: "tool-call" } =>
      p.type === "tool-call"
    )
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
