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
 * Ballot mechanism: the parent provides a set of predetermined response strings
 * ("ballot") to a sub-agent. The sub-agent selects one. Because the CONTENT
 * was authored by the trusted parent, it keeps InjectionFree. Only
 * InfluenceClean is stripped — the sub-agent's choice of which option may
 * have been influenced by injection in the data it processed.
 *
 * This is structurally sound: no trust in the sub-agent's claims is needed.
 * The content literally cannot contain injection because the parent wrote it.
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

/** A ballot: a set of predetermined responses the sub-agent can select from. */
export interface Ballot {
  /** The path where the selected result will be written */
  path: string;
  /** Map of option keys to their content strings */
  options: Record<string, string>;
  /** Label to apply to the selected option (InjectionFree, no InfluenceClean) */
  label: Label;
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
  /** Ballots provided by the parent, keyed by output path */
  private ballots: Map<string, Ballot> = new Map();

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

    // Special commands
    if (command.startsWith("!sub")) {
      return this.handleSubAgent(callId, command);
    }
    if (command.startsWith("!select ")) {
      return this.handleSelect(callId, command);
    }
    if (command.startsWith("!ballot")) {
      return this.handleBallotInfo(callId);
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
   * Provide a ballot to a sub-agent: a set of predetermined response strings.
   *
   * The parent (caller) provides the options. Because the content of each
   * option was authored by the trusted parent, the selected option will
   * carry InjectionFree integrity. InfluenceClean is stripped because the
   * sub-agent's choice may have been influenced by injection in the data
   * it processed.
   *
   * @param child The sub-agent to provide the ballot to
   * @param path  Where the selected result will be written
   * @param options Map of key → content (e.g. { "safe": "Content is safe", "unsafe": "Content is unsafe" })
   */
  provideBallot(
    child: AgentSession,
    path: string,
    options: Record<string, string>,
  ): void {
    if (!this.children.includes(child)) {
      throw new Error("Can only provide ballots to own sub-agents");
    }

    // The ballot label: InjectionFree (content is predetermined by parent),
    // but NOT InfluenceClean (the selection is influenced by sub-agent's context).
    // Also carries accumulated confidentiality if the parent has any.
    const ballotLabel: Label = {
      confidentiality: [],
      integrity: [{ kind: "InjectionFree" }],
    };

    const ballot: Ballot = { path, options, label: ballotLabel };
    child.ballots.set(path, ballot);

    this.events.push({
      type: "ballot-provided",
      agentId: child.id,
      path,
      options: Object.keys(options),
    });
  }

  /**
   * Select a ballot option. Only sub-agents with a ballot can call this.
   *
   * The system writes the predetermined content (from the parent) to the
   * ballot path with InjectionFree integrity. The sub-agent's choice only
   * determines WHICH predetermined string is written — the content itself
   * is structurally safe.
   */
  select(path: string, key: string): void {
    const ballot = this.ballots.get(path);
    if (!ballot) {
      throw new Error(`No ballot for path: ${path}`);
    }
    if (!(key in ballot.options)) {
      throw new Error(
        `Invalid ballot key: "${key}". Valid keys: ${
          Object.keys(ballot.options).join(", ")
        }`,
      );
    }

    const content = ballot.options[key];

    // Write with the ballot's label (InjectionFree, no InfluenceClean)
    this.shell.vfs.writeFile(path, content, ballot.label);

    this.events.push({
      type: "ballot-selected",
      agentId: this.id,
      path,
      key,
    });
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

  /** Get ballot keys available for a path */
  getBallot(path: string): Ballot | undefined {
    return this.ballots.get(path);
  }

  // ---- Private helpers ----

  private handleSubAgent(
    callId: string,
    command: string,
  ): ToolResult {
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

    const parts = command.trim().split(/\s+/);
    const policyName = parts[1] || "sub";
    const policy = policyName === "restricted"
      ? policies.restricted()
      : policies.sub();

    const child = this.spawnSubAgent(policy);
    return {
      id: callId,
      stdout:
        `Sub-agent ${child.id} started with policy: ${child.policy.name}\n` +
        `Policy: ${child.policy.description}\n` +
        `Use "!select <path> <key>" to select from provided ballot.\n`,
      stderr: "",
      exitCode: 0,
      label: labels.bottom(),
      filtered: false,
    };
  }

  private handleSelect(
    callId: string,
    command: string,
  ): ToolResult {
    // Parse: !select <path> <key>
    const match = command.match(/^!select\s+(\S+)\s+(\S+)/);
    if (!match) {
      return {
        id: callId,
        stdout: "Usage: !select <path> <key>\n",
        stderr: "",
        exitCode: 1,
        label: labels.bottom(),
        filtered: false,
      };
    }

    const path = match[1];
    const key = match[2];

    try {
      this.select(path, key);
      return {
        id: callId,
        stdout: `Selected "${key}" for ${path}\n`,
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

  private handleBallotInfo(callId: string): ToolResult {
    if (this.ballots.size === 0) {
      return {
        id: callId,
        stdout: "No ballots available.\n",
        stderr: "",
        exitCode: 0,
        label: labels.bottom(),
        filtered: false,
      };
    }

    let output = "Available ballots:\n";
    for (const [path, ballot] of this.ballots) {
      output += `  ${path}: [${Object.keys(ballot.options).join(", ")}]\n`;
    }

    return {
      id: callId,
      stdout: output,
      stderr: "",
      exitCode: 0,
      label: labels.bottom(),
      filtered: false,
    };
  }

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
  }> {
    const tmpFile = `/tmp/.agent-capture-${this.id}-${Date.now()}`;

    try {
      const result = await execute(
        `(${command}) > ${tmpFile} 2>/dev/null`,
        this.shell,
      );

      // Accumulate taint: join the result label into the session PC so that
      // subsequent commands reflect any taint from data this command touched.
      // E.g., after `cat untrusted.txt`, the PC loses InjectionFree.
      const prevPC = this.shell.pcLabel;
      this.shell.popPC();
      this.shell.pushPC(labels.join(prevPC, result.label));

      let stdout = "";
      let outputLabel = result.label;
      try {
        const captured = this.shell.vfs.readFileText(tmpFile);
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

      try {
        this.shell.vfs.rm(tmpFile);
      } catch {
        // ignore
      }

      return {
        stdout,
        stderr: "",
        exitCode: result.exitCode,
        label: outputLabel,
      };
    } catch (e) {
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
