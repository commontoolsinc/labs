/**
 * Agent Protocol — Types for the agent tool-call system.
 *
 * An agent interacts with the shell by proposing tool calls (shell commands).
 * The system executes them, checks labels, and filters output based on the
 * agent's visibility policy before returning results.
 */

import { Label } from "../labels.ts";

/** A tool call proposed by the agent */
export interface ToolCall {
  id: string;
  command: string; // shell command string
}

/** Result of executing a tool call */
export interface ToolResult {
  id: string;
  stdout: string; // possibly filtered
  stderr: string;
  exitCode: number;
  label: Label; // label of the output
  filtered: boolean; // true if stdout was redacted
  filterReason?: string; // why it was filtered
}

/** A message in the agent conversation */
export type AgentMessage =
  | { role: "agent"; toolCall: ToolCall }
  | { role: "system"; toolResult: ToolResult }
  | { role: "system"; event: AgentEvent };

/** System events (sub-agent lifecycle, policy violations, etc.) */
export type AgentEvent =
  | { type: "sub-agent-started"; agentId: string; policy: string }
  | { type: "sub-agent-ended"; agentId: string; exitLabel: Label }
  | { type: "policy-violation"; command: string; reason: string; label: Label }
  | { type: "return-result"; agentId: string; path: string; label: Label }
  | { type: "label-info"; path: string; label: Label };
