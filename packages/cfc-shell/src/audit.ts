/**
 * Audit Log System
 *
 * Records all exchange rule evaluations for security review and debugging.
 * Provides a tamper-evident log of data flows and policy decisions.
 */

import { Label } from "./labels.ts";

export interface AuditEntry {
  timestamp: number;
  command: string;
  args: string[];
  inputLabels: Label[];
  outputLabel: Label;
  pcLabel: Label;
  verdict: "allowed" | "blocked" | "intent-requested" | "warned";
  rule?: string;
  reason?: string;
}

/**
 * Manages audit log entries
 */
export class AuditLog {
  private entries: AuditEntry[] = [];

  /**
   * Add an entry to the log
   */
  log(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  /**
   * Get all entries
   */
  all(): readonly AuditEntry[] {
    return this.entries;
  }

  /**
   * Get entries for a specific command
   */
  forCommand(command: string): AuditEntry[] {
    return this.entries.filter((e) => e.command === command);
  }

  /**
   * Get all blocked entries
   */
  blocked(): AuditEntry[] {
    return this.entries.filter((e) => e.verdict === "blocked");
  }

  /**
   * Get entries since a timestamp
   */
  since(timestamp: number): AuditEntry[] {
    return this.entries.filter((e) => e.timestamp >= timestamp);
  }

  /**
   * Format a single entry as human-readable string
   */
  format(entry: AuditEntry): string {
    const date = new Date(entry.timestamp).toISOString();
    const cmd = `${entry.command} ${entry.args.join(" ")}`;

    let result = `[${date}] ${cmd}\n`;
    result += `  Verdict: ${entry.verdict}\n`;

    if (entry.rule) {
      result += `  Rule: ${entry.rule}\n`;
    }

    if (entry.reason) {
      result += `  Reason: ${entry.reason}\n`;
    }

    // Format labels concisely
    if (entry.inputLabels.length > 0) {
      const integrities = entry.inputLabels.map((l) =>
        l.integrity.map((a) => a.kind).join("|") || "none"
      );
      result += `  Input integrity: [${integrities.join(", ")}]\n`;
    }

    const outputIntegrity =
      entry.outputLabel.integrity.map((a) => a.kind).join("|") || "none";
    result += `  Output integrity: ${outputIntegrity}\n`;

    const pcIntegrity = entry.pcLabel.integrity.map((a) => a.kind).join("|") ||
      "none";
    result += `  PC integrity: ${pcIntegrity}\n`;

    return result;
  }

  /**
   * Format all entries
   */
  formatAll(): string {
    return this.entries.map((e) => this.format(e)).join("\n");
  }

  /**
   * Clear the log
   */
  clear(): void {
    this.entries = [];
  }
}
