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
 * Declassification mechanism: when a sub-agent returns its final text response,
 * the parent runs a declassifier that checks whether the text matches:
 *   1. A ballot string (parent-authored) → InjectionFree
 *   2. A captured exec stdout → adopt that output's label
 *   3. Neither → return with the sub-agent's accumulated label
 *
 * This is structurally sound: no trust in the sub-agent's claims is needed.
 * The declassifier verifies that content matches known-safe values.
 */

import { type Label, labels } from "../labels.ts";
import { createSession, ShellSession } from "../session.ts";
import { execute } from "../interpreter.ts";
import { VFS } from "../vfs.ts";
import { createDefaultRegistry } from "../commands/mod.ts";
import { createEnvironment, type Environment } from "../commands/context.ts";
import { type AgentPolicy, filterOutput, policies } from "./policy.ts";
import { AgentEvent, ToolCall, ToolResult } from "./protocol.ts";

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
    const env = options.env ??
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
      requestIntent: () => {
        // Sub-agents auto-approve intents; main agents deny by default
        return Promise.resolve(this.parent !== null);
      },
    });

    // Agent commands originate from user requests — initialize PC with userInput
    // so that literals and shell-generated output retain InjectionFree integrity.
    // After each command, the PC is updated with the result's label so taint
    // from untrusted data accumulates across exec() calls.
    this.shell.pushPC(labels.userInput());
  }

  /**
   * Execute a command and capture stdout, filtering per policy.
   * This is the main entry point for the agent protocol.
   */
  async exec(command: string): Promise<ToolResult> {
    const callId = nextToolCallId();

    // Diagnostic commands
    if (command.startsWith("!label ")) {
      return this.handleLabelInspect(callId, command);
    }
    if (command.startsWith("!policy")) {
      return this.handlePolicyInfo(callId);
    }

    // Execute the command and capture output
    const captured = await this.captureExec(command);

    // Filter stdout and stderr based on policy
    const {
      content: filteredStdout,
      filtered: stdoutFiltered,
      reason: stdoutReason,
    } = filterOutput(captured.stdout, captured.label, this.policy);
    const { content: filteredStderr } = filterOutput(
      captured.stderr,
      captured.stderrLabel,
      this.policy,
    );

    const toolResult: ToolResult = {
      id: callId,
      stdout: filteredStdout,
      stderr: filteredStderr,
      exitCode: captured.exitCode,
      label: captured.label,
      filtered: stdoutFiltered,
      filterReason: stdoutReason,
    };

    this.history.push({
      call: { id: callId, command },
      result: toolResult,
    });

    return toolResult;
  }

  /**
   * Read a file through the policy filter.
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
   * Declassify a sub-agent's return text by checking it against known-safe values.
   *
   * 1. Exact ballot match → InjectionFree (parent authored it)
   * 2. Exact match against any captured stdout → adopt that output's label
   * 3. No match → return with child's accumulated label
   */
  declassifyReturn(
    child: AgentSession,
    text: string,
    ballots: string[],
  ): { content: string; label: Label } {
    if (!this.children.includes(child)) {
      throw new Error("Can only declassify returns from own sub-agents");
    }

    const trimmed = text.trim();

    // 1. Exact ballot match → InjectionFree
    if (ballots.some((b) => b.trim() === trimmed)) {
      this.events.push({
        type: "sub-agent-return",
        agentId: child.id,
        ballotMatch: true,
        outputMatch: false,
      });
      return {
        content: trimmed,
        label: {
          confidentiality: [],
          integrity: [{ kind: "InjectionFree" }],
        },
      };
    }

    // 2. Exact match against any captured stdout → adopt that output's label
    for (const { result } of child.getHistory()) {
      if (!result.filtered && result.stdout.trim() === trimmed) {
        this.events.push({
          type: "sub-agent-return",
          agentId: child.id,
          ballotMatch: false,
          outputMatch: true,
        });
        return { content: trimmed, label: result.label };
      }
    }

    // 3. No match → return with child's accumulated label
    const exitLabel = child.end();
    this.events.push({
      type: "sub-agent-return",
      agentId: child.id,
      ballotMatch: false,
      outputMatch: false,
    });
    return { content: text, label: exitLabel };
  }

  /**
   * End this sub-agent session, returning to parent.
   */
  end(): Label {
    const resultLabels = this.history.map((h) => h.result.label);
    const accumulatedLabel = resultLabels.length > 0
      ? labels.joinAll(resultLabels)
      : labels.bottom();

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

  private handleLabelInspect(
    callId: string,
    command: string,
  ): ToolResult {
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
      const conf = label.confidentiality.length > 0
        ? label.confidentiality
          .map((c) => c.map((a) => a.kind).join("|"))
          .join(" \u2227 ")
        : "(public)";
      const integ = label.integrity.length > 0
        ? label.integrity.map((a) => a.kind).join(", ")
        : "(none)";

      this.events.push({ type: "label-info", path, label });

      return {
        id: callId,
        stdout:
          `Label for ${path}:\n  Confidentiality: ${conf}\n  Integrity: ${integ}\n`,
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

  private handlePolicyInfo(callId: string): ToolResult {
    const req = this.policy.requiredIntegrity.length > 0
      ? this.policy.requiredIntegrity.map((a) => a.kind).join(", ")
      : "(none -- can see everything)";

    return {
      id: callId,
      stdout: `Agent: ${this.id}\n` +
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
   */
  private async captureExec(command: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    label: Label;
    stderrLabel: Label;
  }> {
    const ts = Date.now();
    const outFile = `/tmp/.agent-out-${this.id}-${ts}`;
    const errFile = `/tmp/.agent-err-${this.id}-${ts}`;

    try {
      const result = await execute(
        `(${command}) > ${outFile} 2>${errFile}`,
        this.shell,
      );

      // Accumulate taint: join the result label into the session PC so that
      // subsequent commands reflect any taint from data this command touched.
      // E.g., after `cat untrusted.txt`, the PC loses InjectionFree.
      const prevPC = this.shell.pcLabel;
      this.shell.popPC();
      this.shell.pushPC(labels.join(prevPC, result.label));

      let stdout = "";
      let stderr = "";
      let outputLabel = result.label;
      try {
        const captured = this.shell.vfs.readFileText(outFile);
        stdout = captured.value;
        // The file's label comes from actual stream writes; result.label
        // includes fixedOutputFormat endorsements. Use whichever has
        // InjectionFree — the file label tracks actual data flow, while
        // result.label carries structural endorsements.
        const fileHasIF = captured.label.integrity.some(
          (a) => a.kind === "InjectionFree",
        );
        const resultHasIF = result.label.integrity.some(
          (a) => a.kind === "InjectionFree",
        );
        if (fileHasIF || resultHasIF) {
          outputLabel = fileHasIF ? captured.label : result.label;
        } else {
          outputLabel = captured.label;
        }
      } catch {
        // Command may not have produced output
      }
      let stderrLabel = result.label;
      try {
        const errCaptured = this.shell.vfs.readFileText(errFile);
        stderr = errCaptured.value;
        stderrLabel = errCaptured.label;
      } catch {
        // No stderr
      }

      try {
        this.shell.vfs.rm(outFile);
      } catch { /* ignore */ }
      try {
        this.shell.vfs.rm(errFile);
      } catch { /* ignore */ }

      return {
        stdout,
        stderr,
        exitCode: result.exitCode,
        label: outputLabel,
        stderrLabel,
      };
    } catch (e) {
      try {
        this.shell.vfs.rm(outFile);
      } catch { /* ignore */ }
      try {
        this.shell.vfs.rm(errFile);
      } catch {
        // ignore
      }

      return {
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        exitCode: 1,
        label: labels.bottom(),
        stderrLabel: labels.bottom(),
      };
    }
  }
}

function cloneEnvironment(env: Environment): Environment {
  const clone = createEnvironment();
  const allVars = env.all();
  for (const [name, { value, label }] of allVars) {
    clone.set(name, value, label);
  }
  const exported = env.exported();
  for (const [name] of exported) {
    clone.export(name);
  }
  return clone;
}
