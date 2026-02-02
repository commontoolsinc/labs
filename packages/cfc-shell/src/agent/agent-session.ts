/**
 * Agent Session — wraps a ShellSession with visibility policy enforcement.
 *
 * When an agent executes a command, the output is captured and filtered
 * based on the agent's policy before being returned. Sub-agents share
 * the same VFS and environment but can have relaxed policies.
 *
 * Key invariant: an agent NEVER sees raw content that violates its policy.
 * The system mediates all data flow between the shell and the agent.
 *
 * Return channel: sub-agents return results to the parent via returnResult().
 * The system labels the returned data with { kind: "TransformedBy", command: agentId },
 * which the parent's policy accepts as an alternative to InjectionFree.
 * Confidentiality from data the sub-agent read is preserved (no leaks).
 */

import { Atom, Label, labels } from "../labels.ts";
import { ShellSession, createSession } from "../session.ts";
import { execute } from "../interpreter.ts";
import { VFS } from "../vfs.ts";
import { createDefaultRegistry } from "../commands/mod.ts";
import { createEnvironment, Environment, CommandResult } from "../commands/context.ts";
import { AgentPolicy, checkVisibility, filterOutput, policies } from "./policy.ts";
import { ToolCall, ToolResult, AgentEvent } from "./protocol.ts";

/** Unique ID generator */
let agentCounter = 0;
function nextAgentId(): string {
  return `agent-${++agentCounter}`;
}

/** Unique tool call ID generator */
let toolCallCounter = 0;
function nextToolCallId(): string {
  return `tc-${++toolCallCounter}`;
}

export interface AgentSessionOptions {
  policy?: AgentPolicy;
  vfs?: VFS;
  env?: Environment;
  /** Parent agent (for sub-agent hierarchy) */
  parent?: AgentSession;
}

export class AgentSession {
  readonly id: string;
  readonly policy: AgentPolicy;
  readonly shell: ShellSession;
  readonly parent: AgentSession | null;
  private children: AgentSession[] = [];
  private events: AgentEvent[] = [];
  private history: { call: ToolCall; result: ToolResult }[] = [];

  constructor(options: AgentSessionOptions = {}) {
    this.id = nextAgentId();
    this.policy = options.policy ?? policies.main();
    this.parent = options.parent ?? null;

    // Share VFS with parent if this is a sub-agent, otherwise create new
    const vfs = options.vfs ?? (options.parent?.shell.vfs) ?? new VFS();
    const env =
      options.env ??
      (options.parent
        ? cloneEnvironment(options.parent.shell.env)
        : createEnvironment({
            HOME: { value: "/home/agent", label: labels.userInput() },
            PATH: { value: "/usr/bin:/bin", label: labels.userInput() },
            USER: { value: "agent", label: labels.userInput() },
          }));

    this.shell = createSession({
      vfs,
      env,
      registry: createDefaultRegistry(),
      requestIntent: async () => {
        // Sub-agents auto-approve intents; main agents deny by default
        // (in a real system, this would prompt the user)
        return this.parent !== null;
      },
    });
  }

  /**
   * Execute a command and capture stdout, filtering per policy.
   * This is the main entry point for the agent protocol.
   */
  async exec(command: string): Promise<ToolResult> {
    const callId = nextToolCallId();

    // Special commands
    if (command.startsWith("!sub")) {
      return this.handleSubAgent(callId, command);
    }
    if (command.startsWith("!return ")) {
      return this.handleReturn(callId, command);
    }
    if (command.startsWith("!label ")) {
      return this.handleLabelInspect(callId, command);
    }
    if (command.startsWith("!policy")) {
      return this.handlePolicyInfo(callId);
    }

    // Execute the command and capture output
    const captured = await this.captureExec(command);

    // Filter the output based on policy
    const {
      content: filteredStdout,
      filtered,
      reason,
    } = filterOutput(captured.stdout, captured.label, this.policy);

    const toolResult: ToolResult = {
      id: callId,
      stdout: filteredStdout,
      stderr: captured.stderr,
      exitCode: captured.exitCode,
      label: captured.label,
      filtered,
      filterReason: reason,
    };

    this.history.push({
      call: { id: callId, command },
      result: toolResult,
    });

    return toolResult;
  }

  /**
   * Read a file through the policy filter.
   * Returns filtered content if the label doesn't satisfy the policy.
   */
  readFile(
    path: string,
  ): { content: string; label: Label; filtered: boolean; reason?: string } {
    const { value, label } = this.shell.vfs.readFileText(path);
    const { content, filtered, reason } = filterOutput(
      value,
      label,
      this.policy,
    );
    return { content, label, filtered, reason };
  }

  /**
   * Spawn a sub-agent with a relaxed policy.
   * The sub-agent shares the VFS (can read/write same files).
   */
  spawnSubAgent(policy?: AgentPolicy): AgentSession {
    if (!this.policy.canSpawnSubAgents) {
      throw new Error(
        "This agent's policy does not allow spawning sub-agents",
      );
    }

    const child = new AgentSession({
      policy: policy ?? policies.sub(),
      parent: this,
    });

    this.children.push(child);
    this.events.push({
      type: "sub-agent-started",
      agentId: child.id,
      policy: child.policy.name,
    });

    return child;
  }

  /**
   * Return a result to the parent agent via the structural return channel.
   *
   * Writes content to the specified path with:
   * - TransformedBy:{agentId} integrity (satisfies parent's "any" policy)
   * - Confidentiality accumulated from everything this sub-agent has read
   *
   * This is the ONLY way for a sub-agent's work to become visible to the parent
   * when the underlying data lacked InjectionFree. The system labels it structurally —
   * no explicit endorsement step needed.
   */
  returnResult(path: string, content: string): void {
    if (!this.parent) {
      throw new Error("Only sub-agents can use the return channel");
    }

    // Compute accumulated confidentiality from all data this agent has seen
    const resultLabels = this.history.map((h) => h.result.label);
    const accumulatedConfidentiality =
      resultLabels.length > 0
        ? labels.joinAll(resultLabels).confidentiality
        : [];

    // Label the returned data with TransformedBy + accumulated confidentiality
    const returnLabel: Label = {
      confidentiality: accumulatedConfidentiality,
      integrity: [{ kind: "TransformedBy", command: this.id }],
    };

    this.shell.vfs.writeFile(path, content, returnLabel);

    this.events.push({
      type: "return-result",
      agentId: this.id,
      path,
      label: returnLabel,
    });
  }

  /**
   * End this sub-agent session, returning to parent.
   * Returns the label representing the taint accumulated during this session.
   */
  end(): Label {
    // The accumulated taint is the join of all result labels
    const resultLabels = this.history.map((h) => h.result.label);
    const accumulatedLabel =
      resultLabels.length > 0 ? labels.joinAll(resultLabels) : labels.bottom();

    if (this.parent) {
      this.parent.events.push({
        type: "sub-agent-ended",
        agentId: this.id,
        exitLabel: accumulatedLabel,
      });
    }

    return accumulatedLabel;
  }

  /** Get the event log */
  getEvents(): readonly AgentEvent[] {
    return this.events;
  }

  /** Get the execution history */
  getHistory(): readonly { call: ToolCall; result: ToolResult }[] {
    return this.history;
  }

  // ---- Private helpers ----

  private async handleSubAgent(
    callId: string,
    command: string,
  ): Promise<ToolResult> {
    if (!this.policy.canSpawnSubAgents) {
      return {
        id: callId,
        stdout: "Error: policy does not allow spawning sub-agents\n",
        stderr: "",
        exitCode: 1,
        label: labels.bottom(),
        filtered: false,
      };
    }

    // Parse: !sub [policy-name]
    const parts = command.trim().split(/\s+/);
    const policyName = parts[1] || "sub";
    const policy =
      policyName === "restricted" ? policies.restricted() : policies.sub();

    const child = this.spawnSubAgent(policy);
    return {
      id: callId,
      stdout:
        `Sub-agent ${child.id} started with policy: ${child.policy.name}\n` +
        `Policy: ${child.policy.description}\n` +
        `Use commands normally. Use "!return <path> <content>" to return results.\n`,
      stderr: "",
      exitCode: 0,
      label: labels.bottom(),
      filtered: false,
    };
  }

  private async handleReturn(
    callId: string,
    command: string,
  ): Promise<ToolResult> {
    // Parse: !return <path> <content...>
    const match = command.match(/^!return\s+(\S+)\s+(.*)/s);
    if (!match) {
      return {
        id: callId,
        stdout:
          "Usage: !return <path> <content>\n" +
          "Example: !return /tmp/result.txt safe summary here\n",
        stderr: "",
        exitCode: 1,
        label: labels.bottom(),
        filtered: false,
      };
    }

    const path = match[1];
    const content = match[2];

    try {
      this.returnResult(path, content);
      return {
        id: callId,
        stdout: `Returned result to ${path} (labeled TransformedBy:${this.id})\n`,
        stderr: "",
        exitCode: 0,
        label: labels.bottom(),
        filtered: false,
      };
    } catch (e) {
      return {
        id: callId,
        stdout: `Error: ${e instanceof Error ? e.message : String(e)}\n`,
        stderr: "",
        exitCode: 1,
        label: labels.bottom(),
        filtered: false,
      };
    }
  }

  private async handleLabelInspect(
    callId: string,
    command: string,
  ): Promise<ToolResult> {
    // Parse: !label <path>
    const parts = command.trim().split(/\s+/);
    const path = parts[1];

    if (!path) {
      return {
        id: callId,
        stdout: "Usage: !label <path>\n",
        stderr: "",
        exitCode: 1,
        label: labels.bottom(),
        filtered: false,
      };
    }

    try {
      const { label } = this.shell.vfs.readFileText(path);
      const conf =
        label.confidentiality.length > 0
          ? label.confidentiality
              .map((c) => c.map((a) => a.kind).join("|"))
              .join(" \u2227 ")
          : "(public)";
      const integ =
        label.integrity.length > 0
          ? label.integrity.map((a) => a.kind).join(", ")
          : "(none)";

      this.events.push({ type: "label-info", path, label });

      return {
        id: callId,
        stdout: `Label for ${path}:\n  Confidentiality: ${conf}\n  Integrity: ${integ}\n`,
        stderr: "",
        exitCode: 0,
        label: labels.bottom(), // label info is always visible
        filtered: false,
      };
    } catch (e) {
      return {
        id: callId,
        stdout: `Error: ${e instanceof Error ? e.message : String(e)}\n`,
        stderr: "",
        exitCode: 1,
        label: labels.bottom(),
        filtered: false,
      };
    }
  }

  private handlePolicyInfo(callId: string): ToolResult {
    const req =
      this.policy.requiredIntegrity.length > 0
        ? this.policy.requiredIntegrity.map((a) => a.kind).join(", ")
        : "(none -- can see everything)";

    return {
      id: callId,
      stdout:
        `Agent: ${this.id}\n` +
        `Policy: ${this.policy.name}\n` +
        `Description: ${this.policy.description}\n` +
        `Required integrity (${this.policy.mode}): ${req}\n` +
        `Can spawn sub-agents: ${this.policy.canSpawnSubAgents}\n`,
      stderr: "",
      exitCode: 0,
      label: labels.bottom(),
      filtered: false,
    };
  }

  /**
   * Execute a command and capture stdout/stderr with labels.
   * Redirects stdout to a temp file, executes, then reads back.
   */
  private async captureExec(command: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    label: Label;
  }> {
    const tmpFile = `/tmp/.agent-capture-${this.id}-${Date.now()}`;

    try {
      // Execute with stdout redirect to temp file
      // Wrap in subshell so existing redirects in the command are handled
      // before the capture redirect is applied.
      const result = await execute(
        `(${command}) > ${tmpFile} 2>/dev/null`,
        this.shell,
      );

      // Read the captured output
      let stdout = "";
      let outputLabel = result.label;
      try {
        const captured = this.shell.vfs.readFileText(tmpFile);
        stdout = captured.value;
        outputLabel = captured.label;
      } catch {
        // Command may not have produced output
      }

      // Clean up temp file
      try {
        this.shell.vfs.rm(tmpFile);
      } catch {
        // ignore cleanup errors
      }

      return {
        stdout,
        stderr: "", // TODO: capture stderr separately
        exitCode: result.exitCode,
        label: outputLabel,
      };
    } catch (e) {
      // Clean up on error
      try {
        this.shell.vfs.rm(tmpFile);
      } catch {
        // ignore
      }

      return {
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        exitCode: 1,
        label: labels.bottom(),
      };
    }
  }
}

/**
 * Clone an environment for sub-agent isolation.
 * Sub-agents get a copy so env changes don't leak to parent.
 */
function cloneEnvironment(env: Environment): Environment {
  const clone = createEnvironment();

  // Copy all variables from the parent environment
  const allVars = env.all();
  for (const [name, { value, label }] of allVars) {
    clone.set(name, value, label);
  }

  // Preserve export status
  const exported = env.exported();
  for (const [name] of exported) {
    clone.export(name);
  }

  return clone;
}
