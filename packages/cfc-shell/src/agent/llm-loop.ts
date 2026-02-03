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
import { type AgentPolicy, filterOutput, policies } from "./policy.ts";
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

const EXEC_TOOL: ToolDef = {
  description: "Execute a command in the CFC sandbox shell. " +
    "This is NOT bash — only built-in commands are available: " +
    "cat, head, tail, wc, diff, grep, sed, sort, uniq, cut, tr, jq, " +
    "base64, echo, printf, ls, pwd, cd, cp, mv, rm, mkdir, touch, tee, " +
    "chmod, curl, date, test, true, false, sleep, read, which, xargs. " +
    "Pipes (|) and redirects (>, >>) work. Shell variables ($VAR) work. " +
    "Do NOT use bash-specific syntax (if/then/fi, for/do/done, while, " +
    "functions, $(...), [[ ]], arithmetic). Keep commands simple — one " +
    "pipeline per call. If a command fails, simplify rather than adding " +
    "bash scripting.",
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
};

const TASK_SCHEMA = {
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
        "Short fixed literal strings the sub-agent may return verbatim. " +
        "Each ballot must be a single short word or phrase with NO " +
        'placeholders, brackets, or variable parts. Good: ["YES", "NO", ' +
        '"SAFE", "UNSAFE"]. Bad: ["YES - [description]", "NO - standard ' +
        'Google logo"]. Put all instructions and detail in the task field ' +
        "instead — ballots are just the allowed return values.",
    },
  },
  required: ["task"],
};

const TASK_DESC_MAIN =
  "Delegate a task to a sub-agent with a relaxed visibility " +
  "policy. The sub-agent can see data that this agent cannot (e.g., " +
  "untrusted network content). Use this when your exec output is " +
  "filtered due to security policy. Always provide short ballots " +
  '(e.g., ["YES", "NO"]) — put all detail in the task description, ' +
  "not in the ballot strings. The sub-agent's response is declassified " +
  "by checking it against ballots and captured command outputs.";

const TASK_DESC_SUB =
  "Delegate a subtask to another agent. Useful for breaking up work " +
  "that would consume too much context, or for parallel exploration. " +
  "The sub-agent shares the same filesystem and can see all data.";

/** Build tool definitions based on agent context. */
function agentTools(
  hasVisibilityRestrictions: boolean,
): Record<string, ToolDef> {
  return {
    exec: EXEC_TOOL,
    task: {
      description: hasVisibilityRestrictions ? TASK_DESC_MAIN : TASK_DESC_SUB,
      inputSchema: TASK_SCHEMA,
    },
  };
}

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
  /** Called when a sub-agent response is rejected and retried */
  onTaskRetry?: (attempt: number, depth: number) => void;
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
    onTaskRetry,
  } = options;

  const messages: Message[] = [
    ...(options.history ?? []),
    { role: "user", content: userMessage },
  ];

  let iterations = 0;
  let conversationLabel = labels.userInput();

  const tools = agentTools(agent.policy.requiredIntegrity.length > 0);

  while (iterations < maxIterations) {
    // Call LLM
    const response = await llm.sendRequest({
      messages,
      model,
      system,
      tools,
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
            onTaskRetry,
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
    onTaskRetry?: (attempt: number, depth: number) => void;
  },
): Promise<{ text: string; label: Label }> {
  const policy = policyName === "restricted"
    ? policies.restricted()
    : policies.sub();

  // The task text was composed by the parent LLM, so the child inherits
  // the parent agent's initial label (carries InjectionFree integrity).
  const child = parentAgent.spawnSubAgent(policy, parentAgent.initialLabel);

  try {
    const childDepth = parentDepth + 1;
    loopOptions.onTaskStart?.(task, policyName, childDepth);

    // Build a system prompt for the sub-agent. When the parent has
    // visibility restrictions, instruct the sub-agent to be careful
    // about what it returns (its response will be declassified).
    const parentRestricted = parentAgent.policy.requiredIntegrity.length > 0;
    const childSystem = parentRestricted
      ? buildSubAgentSystemPrompt(loopOptions.system, ballots)
      : loopOptions.system;

    const MAX_RETRIES = 3;
    let history: Message[] | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await runAgentLoop(
        attempt === 0 ? task : buildRetryMessage(ballots),
        {
          ...loopOptions,
          system: childSystem,
          agent: child,
          depth: childDepth,
          history,
        },
      );

      // Preview whether declassification would succeed without calling
      // declassifyReturn (which calls child.end() on the no-match path).
      const wouldPass = previewDeclassify(
        child,
        result.response,
        ballots,
        parentAgent.policy,
      );

      if (wouldPass || attempt === MAX_RETRIES) {
        // Commit: call the real declassifyReturn (may end the child)
        const declassified = parentAgent.declassifyReturn(
          child,
          result.response,
          ballots,
        );

        const filtered = filterOutput(
          declassified.content,
          declassified.label,
          parentAgent.policy,
        );

        const isFiltered = filtered.filtered ?? false;
        const labelDesc = declassified.label.integrity.length > 0
          ? declassified.label.integrity.map((a) => a.kind).join(", ")
          : "none";
        const content = isFiltered
          ? `[FILTERED: ${filtered.reason ?? "policy"}]`
          : filtered.content;

        loopOptions.onTaskEnd?.(
          content,
          declassified.label,
          isFiltered,
          childDepth,
        );

        const raw = `${content}\n[integrity: ${labelDesc}]`;
        return {
          text: prefixLines(raw, childDepth),
          label: declassified.label,
        };
      }

      // Response would be filtered — retry with correction
      loopOptions.onTaskRetry?.(attempt + 1, childDepth);
      history = result.messages;
    }

    // Unreachable, but satisfy TypeScript
    const exitLabel = child.end();
    return {
      text: prefixLines("[FILTERED: max retries exceeded]", childDepth + 1),
      label: exitLabel,
    };
  } catch (e) {
    child.end();
    return {
      text: `Error in sub-agent: ${e instanceof Error ? e.message : String(e)}`,
      label: labels.userInput(),
    };
  }
}

// ---------------------------------------------------------------------------
// Sub-agent system prompt
// ---------------------------------------------------------------------------

/**
 * Preview whether a sub-agent's response would pass declassification
 * and the parent's visibility filter, WITHOUT calling declassifyReturn
 * (which has side effects like ending the child session).
 */
function previewDeclassify(
  child: AgentSession,
  text: string,
  ballots: string[],
  parentPolicy: AgentPolicy,
): boolean {
  const trimmed = text.trim();

  // 1. Ballot match → InjectionFree → always passes
  if (ballots.some((b) => b.trim() === trimmed)) return true;

  // 2. Stdout match → adopts that output's label
  for (const { result } of child.getHistory()) {
    if (!result.filtered && result.stdout.trim() === trimmed) {
      return !filterOutput(trimmed, result.label, parentPolicy).filtered;
    }
  }

  // 3. No match → accumulated label (falls back to child's initialLabel
  //    when history is empty, i.e. the sub-agent never ran any tools)
  const history = child.getHistory();
  const accLabel = history.length > 0
    ? labels.joinAll(history.map((h) => h.result.label))
    : child.initialLabel;
  return !filterOutput(text, accLabel, parentPolicy).filtered;
}

/**
 * Build a correction message when the sub-agent's response would be
 * filtered by the parent's policy. Tells the agent to try again with
 * a safe response, and re-includes ballots if available.
 */
function buildRetryMessage(ballots: string[]): string {
  if (ballots.length > 0) {
    const ballotList = ballots.map((b) => `  "${b}"`).join("\n");
    return (
      "BLOCKED: Your previous response was rejected by the security policy. " +
      "You MUST respond with ONLY one of these exact strings and nothing else — " +
      "no explanation, no quotes, no extra text:\n\n" +
      ballotList
    );
  }

  return (
    "BLOCKED: Your previous response was rejected by the security policy " +
    "because it contained tainted content. Respond with ONLY the safe " +
    "result itself, no summary or any other extra data."
  );
}

/**
 * Build a system prompt for a sub-agent whose parent has visibility
 * restrictions. Instructs the agent to not leak tainted content and to
 * respond precisely with safe output. If ballots are provided, lists
 * them as pre-approved safe responses.
 */
function buildSubAgentSystemPrompt(
  baseSystem: string | undefined,
  ballots: string[],
): string {
  const lines = [
    baseSystem ?? "",
    "",
    "IMPORTANT: You are a sub-agent. Your parent agent has a restricted " +
    "visibility policy and CANNOT see untrusted/tainted content directly. " +
    "Your response will be checked before the parent can see it.",
    "",
    "Rules for your final response:",
    "- Do NOT include raw untrusted content (HTML, scripts, user-generated text) in your response.",
    "- Summarize, extract specific facts, or report structured results instead.",
    "- Follow the task instructions precisely — your response should answer exactly what was asked.",
    "- If the parent provided specific safe output strings, prefer responding with one of those exactly.",
  ];

  if (ballots.length > 0) {
    lines.push("");
    lines.push(
      "Pre-approved safe responses (respond with one of these exactly if appropriate):",
    );
    for (const b of ballots) {
      lines.push(`  - "${b}"`);
    }
  }

  return lines.join("\n");
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
