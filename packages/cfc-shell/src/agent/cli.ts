/**
 * Agent CLI — Interactive REPL for the CFC agent system.
 *
 * The CLI maintains a stack of agent sessions. The main agent has a
 * restricted visibility policy; sub-agents spawned with !sub have
 * relaxed policies but taint their outputs.
 *
 * Commands:
 *   <any shell command>  — Execute via cfc-shell, output filtered by policy
 *   !sub [policy]        — Spawn sub-agent (policy: "sub" or "restricted")
 *   !end                 — End current sub-agent, return to parent
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

/** Prefix each line with >> markers to indicate sub-agent nesting depth. */
function prefixLines(text: string, depth: number): string {
  if (depth <= 0) return text;
  const prefix = ">> ".repeat(depth);
  return text.split("\n").map((line) => line ? `${prefix}${line}` : line).join(
    "\n",
  );
}

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

    // Prefix output with >> markers for sub-agent depth
    const subDepth = this.stack.length - 1;
    if (subDepth > 0) {
      output = prefixLines(output, subDepth);
    }

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
        `Policy: ${child.policy.description}\n`;
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
  !label <path>          Inspect a file's label
  !policy                Show current agent's policy
  !history               Show execution history
  !events                Show event log
  !help                  Show this help
  !quit                  Exit

Policies:
  main-agent:     Can only see injection-free data
  sub-agent:      Can see everything (for processing untrusted data)
  restricted:     Can see everything, cannot spawn sub-agents

In the LLM loop, use the "task" tool to delegate work to sub-agents.
The sub-agent's response is declassified by matching against ballots
(parent-authored safe strings) and captured command outputs.

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
        case "sub-agent-return":
          return `[SUB-AGENT] ${e.agentId} return (ballot: ${e.ballotMatch}, output: ${e.outputMatch})`;
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
