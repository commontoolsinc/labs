/**
 * Agent CLI — Interactive REPL for the CFC agent system.
 *
 * The CLI maintains a stack of agent sessions. The main agent has a
 * restricted visibility policy; sub-agents spawned with !sub have
 * relaxed policies but taint their outputs.
 *
 * Ballot mechanism: the parent provides predetermined response strings
 * to the sub-agent. The sub-agent selects one with !select. The content
 * keeps InjectionFree (it was authored by the parent), but loses
 * InfluenceClean (the sub-agent's choice may have been influenced).
 *
 * Commands:
 *   <any shell command>  — Execute via cfc-shell, output filtered by policy
 *   !sub [policy]        — Spawn sub-agent (policy: "sub" or "restricted")
 *   !end                 — End current sub-agent, return to parent
 *   !select <path> <key> — Select a ballot option (sub-agent only)
 *   !ballot              — Show available ballot options
 *   !label <path>        — Inspect a file's label
 *   !policy              — Show current agent's policy
 *   !history             — Show execution history
 *   !events              — Show event log
 *   !help                — Show help
 *   !quit / !exit        — Exit
 */

import { AgentSession } from "./agent-session.ts";
import { AgentPolicy, policies } from "./policy.ts";
import { VFS } from "../vfs.ts";

/** Format a label concisely for display */
function formatLabel(
  label: { confidentiality: any[]; integrity: any[] },
): string {
  const conf = label.confidentiality.length > 0
    ? label.confidentiality.map((c: any[]) =>
      c.map((a: any) => {
        if (a.kind === "Space") return `Space:${a.id}`;
        return a.kind;
      }).join("|")
    ).join(" ∧ ")
    : "public";
  const integ = label.integrity.length > 0
    ? label.integrity.map((a: any) => {
      if (a.kind === "TransformedBy") return `TransformedBy:${a.command}`;
      if (a.kind === "Origin") return `Origin`;
      if (a.kind === "EndorsedBy") return `EndorsedBy:${a.principal}`;
      return a.kind;
    }).join(", ")
    : "none";
  return `{conf: ${conf}, int: ${integ}}`;
}

export class AgentCLI {
  private stack: AgentSession[] = [];
  private running = false;

  constructor(options?: { vfs?: VFS; policy?: AgentPolicy }) {
    const root = new AgentSession({
      policy: options?.policy ?? policies.main(),
      vfs: options?.vfs,
    });
    this.stack.push(root);
  }

  get current(): AgentSession {
    return this.stack[this.stack.length - 1];
  }

  get prompt(): string {
    if (this.stack.length === 1) {
      return "agent> ";
    }
    const depth = this.stack.length - 1;
    const prefix = "sub-agent" + (depth > 1 ? `[${depth}]` : "");
    return `${prefix}> `;
  }

  async processLine(line: string): Promise<string> {
    const trimmed = line.trim();
    if (!trimmed) return "";

    if (trimmed === "!help") return this.helpText();
    if (trimmed === "!quit" || trimmed === "!exit") {
      this.running = false;
      return "Goodbye.\n";
    }
    if (trimmed === "!history") return this.formatHistory();
    if (trimmed === "!events") return this.formatEvents();
    if (trimmed === "!policy") return this.formatPolicy();

    if (trimmed === "!end") {
      return this.handleEnd();
    }

    if (trimmed.startsWith("!sub")) {
      return this.handleSub(trimmed);
    }

    if (trimmed.startsWith("!label ")) {
      return this.handleLabel(trimmed);
    }

    if (trimmed.startsWith("!select ")) {
      return this.handleSelect(trimmed);
    }

    if (trimmed === "!ballot") {
      return this.handleBallotInfo();
    }

    // Execute through agent session
    const result = await this.current.exec(trimmed);

    let output = "";
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += result.stderr;

    if (result.filtered) {
      // Already shows [FILTERED: ...] in stdout
    } else if (result.exitCode !== 0) {
      output += `(exit: ${result.exitCode})\n`;
    }

    output += `  label: ${formatLabel(result.label)}\n`;
    return output;
  }

  private handleSub(trimmed: string): string {
    const parts = trimmed.split(/\s+/);
    const policyName = parts[1] || "sub";

    try {
      const policy = policyName === "restricted"
        ? policies.restricted()
        : policies.sub();
      const child = this.current.spawnSubAgent(policy);
      this.stack.push(child);

      return `Sub-agent ${child.id} started with policy: ${child.policy.name}\n` +
        `Policy: ${child.policy.description}\n` +
        `Use "!select <path> <key>" to select from provided ballot.\n`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}\n`;
    }
  }

  private handleEnd(): string {
    if (this.stack.length <= 1) {
      return "Error: no sub-agent to end (already at root)\n";
    }

    const child = this.stack.pop()!;
    const exitLabel = child.end();

    return `Sub-agent ${child.id} ended.\n` +
      `  Exit label: ${formatLabel(exitLabel)}\n` +
      `  Returning to ${this.current.id} (${this.current.policy.name})\n`;
  }

  private handleLabel(trimmed: string): string {
    const path = trimmed.slice("!label ".length).trim();
    if (!path) return "Usage: !label <path>\n";

    try {
      const { label } = this.current.shell.vfs.readFileText(path);
      return `${path}: ${formatLabel(label)}\n`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}\n`;
    }
  }

  private handleSelect(trimmed: string): string {
    const match = trimmed.match(/^!select\s+(\S+)\s+(\S+)/);
    if (!match) return "Usage: !select <path> <key>\n";

    const path = match[1];
    const key = match[2];

    try {
      this.current.select(path, key);
      return `Selected "${key}" for ${path}\n`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}\n`;
    }
  }

  private handleBallotInfo(): string {
    let output = "Available ballots:\n";
    // Check all ballots on the current session
    // (We expose this through the CLI for visibility)
    const result = this.current.getBallot("/tmp/result.txt");
    if (!result) {
      return "No ballots available. Parent must provide a ballot first.\n";
    }
    output += `  ${result.path}: [${Object.keys(result.options).join(", ")}]\n`;
    return output;
  }

  private formatPolicy(): string {
    const p = this.current.policy;
    const req = p.requiredIntegrity.length > 0
      ? p.requiredIntegrity.map((a) => a.kind).join(", ")
      : "(none -- can see everything)";
    return `Agent: ${this.current.id}\n` +
      `Policy: ${p.name}\n` +
      `Description: ${p.description}\n` +
      `Required integrity (${p.mode}): ${req}\n` +
      `Can spawn sub-agents: ${p.canSpawnSubAgents}\n` +
      `Stack depth: ${this.stack.length}\n`;
  }

  async run(): Promise<void> {
    this.running = true;
    console.log("CFC Agent Shell — Label-aware agent execution environment");
    console.log("Type !help for commands.\n");

    while (this.running) {
      const input = prompt(this.prompt);
      if (input === null) break;

      const output = await this.processLine(input);
      if (output) {
        const encoder = new TextEncoder();
        await Deno.stdout.write(encoder.encode(output));
      }
    }
  }

  private helpText(): string {
    return `CFC Agent Shell Commands:
  <command>              Execute shell command (output filtered by policy)
  !sub [policy]          Spawn sub-agent ("sub" or "restricted")
  !end                   End current sub-agent, return to parent
  !select <path> <key>   Select from ballot (sub-agent only)
  !ballot                Show available ballot options
  !label <path>          Inspect a file's label
  !policy                Show current agent's policy
  !history               Show execution history
  !events                Show event log
  !help                  Show this help
  !quit                  Exit

Policies:
  main-agent:     Can only see injection-free data
  sub-agent:      Can see everything, selects from ballot
  restricted:     Can see everything, cannot spawn sub-agents

Ballot Mechanism:
  The parent provides predetermined response strings via provideBallot().
  The sub-agent selects one with "!select <path> <key>".
  The selected content keeps InjectionFree (parent authored it).
  InfluenceClean is stripped (sub-agent's choice may be influenced).
  The parent can then read the result — no trust in sub-agent needed.

Label Atoms:
  InjectionFree    Content doesn't contain prompt injection
  InfluenceClean   Value wasn't influenced by injection
  UserInput        Originated from user input
  LLMGenerated     Produced by an LLM
  Origin           From a specific URL
  TransformedBy    Processed by a command
`;
  }

  private formatHistory(): string {
    const hist = this.current.getHistory();
    if (hist.length === 0) return "No history.\n";

    return hist.map((h, i) => {
      const f = h.result.filtered ? " [FILTERED]" : "";
      return `${i + 1}. ${h.call.command} → exit ${h.result.exitCode}${f}`;
    }).join("\n") + "\n";
  }

  private formatEvents(): string {
    const events = this.current.getEvents();
    if (events.length === 0) return "No events.\n";

    return events.map((e) => {
      switch (e.type) {
        case "sub-agent-started":
          return `[SUB-AGENT] ${e.agentId} started (policy: ${e.policy})`;
        case "sub-agent-ended":
          return `[SUB-AGENT] ${e.agentId} ended (label: ${
            formatLabel(e.exitLabel)
          })`;
        case "ballot-provided":
          return `[BALLOT] provided to ${e.agentId} at ${e.path}: [${
            e.options.join(", ")
          }]`;
        case "ballot-selected":
          return `[BALLOT] ${e.agentId} selected "${e.key}" at ${e.path}`;
        case "label-info":
          return `[LABEL] ${e.path}: ${formatLabel(e.label)}`;
        case "policy-violation":
          return `[VIOLATION] ${e.command}: ${e.reason}`;
      }
    }).join("\n") + "\n";
  }
}

export async function main(): Promise<void> {
  const cli = new AgentCLI();
  await cli.run();
}
