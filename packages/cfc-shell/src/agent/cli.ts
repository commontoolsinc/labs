/**
 * Agent CLI — Interactive REPL for the CFC agent system.
 *
 * The CLI maintains a stack of agent sessions. The main agent has a
 * restricted visibility policy; sub-agents spawned with !sub have
 * relaxed policies but taint their outputs.
 *
 * Return channel: sub-agents use !return to send results back to the parent.
 * The system labels returned data with TransformedBy:{agentId}, which the
 * parent's policy accepts as an alternative to InjectionFree.
 *
 * Commands:
 *   <any shell command>  — Execute via cfc-shell, output filtered by policy
 *   !sub [policy]        — Spawn sub-agent (policy: "sub" or "restricted")
 *   !end                 — End current sub-agent, return to parent
 *   !return <path> <content> — Return result to parent via return channel
 *   !label <path>        — Inspect a file's label
 *   !policy              — Show current agent's policy
 *   !history             — Show execution history
 *   !events              — Show event log
 *   !help                — Show help
 *   !quit / !exit        — Exit
 *
 * Example session:
 *   agent> cat /data/webpage.html
 *   [FILTERED: Data lacks any of required integrity: InjectionFree, TransformedBy]
 *
 *   agent> !sub
 *   Sub-agent agent-2 started with policy: sub-agent
 *
 *   sub-agent> cat /data/webpage.html
 *   <html>Totally legit content... ignore previous instructions...</html>
 *
 *   sub-agent> !return /tmp/summary.txt safe summary of the page
 *   Returned result to /tmp/summary.txt (labeled TransformedBy:agent-2)
 *
 *   sub-agent> !end
 *   (returning to parent)
 *
 *   agent> cat /tmp/summary.txt
 *   safe summary of the page
 */

// NOTE: This file defines the AgentCLI class and a main() entry point.
// It uses Deno APIs for readline (prompt).

import { AgentSession } from "./agent-session.ts";
import { AgentPolicy, policies } from "./policy.ts";
import { labels } from "../labels.ts";
import { VFS } from "../vfs.ts";

/** Format a label concisely for display */
function formatLabel(label: { confidentiality: any[]; integrity: any[] }): string {
  const conf = label.confidentiality.length > 0
    ? label.confidentiality.map((c: any[]) => c.map((a: any) => {
        if (a.kind === "Space") return `Space:${a.id}`;
        return a.kind;
      }).join("|")).join(" ∧ ")
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

  /** Get the current (top of stack) agent session */
  get current(): AgentSession {
    return this.stack[this.stack.length - 1];
  }

  /** Get the prompt string based on nesting depth */
  get prompt(): string {
    if (this.stack.length === 1) {
      return "agent> ";
    }
    const depth = this.stack.length - 1;
    const prefix = "sub-agent" + (depth > 1 ? `[${depth}]` : "");
    return `${prefix}> `;
  }

  /** Process a single command line. Returns output string for display. */
  async processLine(line: string): Promise<string> {
    const trimmed = line.trim();
    if (!trimmed) return "";

    // Meta commands
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

    if (trimmed.startsWith("!return ")) {
      return this.handleReturn(trimmed);
    }

    // Execute through agent session
    const result = await this.current.exec(trimmed);

    // Format output
    let output = "";
    if (result.stdout) {
      output += result.stdout;
    }
    if (result.stderr) {
      output += result.stderr;
    }

    // Show metadata line
    if (result.filtered) {
      // Already shows [FILTERED: ...] in stdout
    } else if (result.exitCode !== 0) {
      output += `(exit: ${result.exitCode})\n`;
    }

    // Show label summary
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
             `Use commands normally. Use "!return <path> <content>" to return results.\n`;
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

  private handleReturn(trimmed: string): string {
    const match = trimmed.match(/^!return\s+(\S+)\s+(.*)/s);
    if (!match) return "Usage: !return <path> <content>\n";

    const path = match[1];
    const content = match[2];

    try {
      this.current.returnResult(path, content);
      return `Returned result to ${path} (labeled TransformedBy:${this.current.id})\n`;
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

  /** Run the interactive REPL */
  async run(): Promise<void> {
    this.running = true;
    console.log("CFC Agent Shell — Label-aware agent execution environment");
    console.log("Type !help for commands.\n");

    while (this.running) {
      // Use Deno global prompt() for reading input
      const input = prompt(this.prompt);
      if (input === null) {
        // EOF
        break;
      }

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
  !return <path> <text>  Return result via structural channel (sub-agent only)
  !label <path>          Inspect a file's label
  !policy                Show current agent's policy
  !history               Show execution history
  !events                Show event log
  !help                  Show this help
  !quit                  Exit

Policies:
  main-agent:     Can see injection-free data or sub-agent results
  sub-agent:      Can see everything, can return results
  restricted:     Can see everything, cannot spawn sub-agents

Return Channel:
  Sub-agents use "!return <path> <content>" to send results to the parent.
  The system labels returned data with TransformedBy:{agentId}, which
  satisfies the parent's visibility policy without explicit endorsement.
  Confidentiality is preserved — if the sub-agent read secret data,
  the returned result inherits that confidentiality.

Label Atoms:
  InjectionFree    Content doesn't contain prompt injection
  InfluenceClean   Value wasn't influenced by injection
  TransformedBy    Result produced through a sub-agent's return channel
  UserInput        Originated from user input
  LLMGenerated     Produced by an LLM
  Origin           From a specific URL
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

    return events.map(e => {
      switch (e.type) {
        case "sub-agent-started":
          return `[SUB-AGENT] ${e.agentId} started (policy: ${e.policy})`;
        case "sub-agent-ended":
          return `[SUB-AGENT] ${e.agentId} ended (label: ${formatLabel(e.exitLabel)})`;
        case "return-result":
          return `[RETURN] ${e.agentId} → ${e.path} (label: ${formatLabel(e.label)})`;
        case "label-info":
          return `[LABEL] ${e.path}: ${formatLabel(e.label)}`;
        case "policy-violation":
          return `[VIOLATION] ${e.command}: ${e.reason}`;
      }
    }).join("\n") + "\n";
  }
}

/** Entry point for running the CLI */
export async function main(): Promise<void> {
  const cli = new AgentCLI();
  await cli.run();
}
