/**
 * Execution commands: bash, eval, source
 *
 * These are CRITICAL commit points for prompt injection defense.
 * They check integrity before executing any code/scripts.
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels, type Label } from "../labels.ts";

/**
 * Check if a label has sufficient integrity for execution
 */
function hasSufficientIntegrity(label: Label): boolean {
  // Required integrity: EndorsedBy(user) OR CodeHash(trusted) OR UserInput
  const hasUserEndorsement = labels.hasIntegrity(label, { kind: "EndorsedBy", principal: "user" });
  const hasUserInput = labels.hasIntegrity(label, { kind: "UserInput" });

  // Check for CodeHash (any trusted hash)
  const hasCodeHash = label.integrity.some(atom => atom.kind === "CodeHash");

  return hasUserEndorsement || hasUserInput || hasCodeHash;
}

/**
 * Check if a label has dangerous low-integrity markers
 */
function hasDangerousIntegrity(label: Label): boolean {
  // Dangerous: Origin(*) OR LLMGenerated without sufficient endorsement
  const hasOrigin = label.integrity.some(atom => atom.kind === "Origin");
  const hasLLMGenerated = label.integrity.some(atom => atom.kind === "LLMGenerated");

  return hasOrigin || hasLLMGenerated;
}

/**
 * Format label integrity for error messages
 */
function formatIntegrity(label: Label): string {
  if (label.integrity.length === 0) {
    return "none";
  }

  return label.integrity.map(atom => {
    if (atom.kind === "Origin") return `Origin(${atom.url})`;
    if (atom.kind === "LLMGenerated") return `LLMGenerated(${atom.model || "*"})`;
    if (atom.kind === "EndorsedBy") return `EndorsedBy(${atom.principal})`;
    if (atom.kind === "CodeHash") return `CodeHash(${atom.hash})`;
    if (atom.kind === "UserInput") return "UserInput";
    if (atom.kind === "TransformedBy") return `TransformedBy(${atom.command})`;
    return atom.kind;
  }).join(", ");
}

/**
 * Block execution with integrity error
 */
function blockExecution(ctx: CommandContext, contentLabel: Label): CommandResult {
  const integrityStr = formatIntegrity(contentLabel);

  ctx.stderr.write(
    `[CFC-SHELL] Blocked: script content lacks sufficient integrity for execution.\n` +
    `Content has integrity: [${integrityStr}].\n` +
    `Required: EndorsedBy(user) or UserInput or CodeHash(trusted).\n`,
    ctx.pcLabel
  );

  return { exitCode: 126, label: ctx.pcLabel }; // Permission denied
}

/**
 * bash - execute bash script
 */
export async function bash(args: string[], ctx: CommandContext): Promise<CommandResult> {
  // bash -c "command" - execute command string
  if (args.length >= 2 && args[0] === "-c") {
    const command = args[1];
    const commandLabel = ctx.pcLabel; // Command comes from args, inherits PC

    // Check integrity
    if (hasDangerousIntegrity(commandLabel) && !hasSufficientIntegrity(commandLabel)) {
      return blockExecution(ctx, commandLabel);
    }

    // In a real implementation, this would recursively parse and execute
    // For now, block all bash -c execution in Phase 4
    ctx.stderr.write(
      "[CFC-SHELL] bash -c execution requires full interpreter (Phase 5)\n",
      ctx.pcLabel
    );
    return { exitCode: 126, label: ctx.pcLabel };
  }

  // bash script.sh - execute script file
  if (args.length >= 1) {
    const scriptPath = args[0];

    try {
      const { value: scriptContent, label: scriptLabel } = ctx.vfs.readFileText(scriptPath);

      // Check integrity
      if (hasDangerousIntegrity(scriptLabel) && !hasSufficientIntegrity(scriptLabel)) {
        return blockExecution(ctx, scriptLabel);
      }

      // In a real implementation, this would parse and execute
      ctx.stderr.write(
        "[CFC-SHELL] bash script execution requires full interpreter (Phase 5)\n",
        ctx.pcLabel
      );
      return { exitCode: 126, label: ctx.pcLabel };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.stderr.write(`bash: ${scriptPath}: ${message}\n`, ctx.pcLabel);
      return { exitCode: 127, label: ctx.pcLabel };
    }
  }

  // Interactive bash not supported
  ctx.stderr.write("bash: interactive mode not supported\n", ctx.pcLabel);
  return { exitCode: 1, label: ctx.pcLabel };
}

/**
 * eval - evaluate command string
 */
export async function evalCmd(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length === 0) {
    return { exitCode: 0, label: ctx.pcLabel };
  }

  const command = args.join(" ");
  const commandLabel = ctx.pcLabel; // Command comes from args, inherits PC

  // Check integrity
  if (hasDangerousIntegrity(commandLabel) && !hasSufficientIntegrity(commandLabel)) {
    return blockExecution(ctx, commandLabel);
  }

  // In a real implementation, this would parse and execute the command
  ctx.stderr.write(
    "[CFC-SHELL] eval requires full interpreter (Phase 5)\n",
    ctx.pcLabel
  );
  return { exitCode: 126, label: ctx.pcLabel };
}

/**
 * source - execute commands from file in current shell
 */
export async function source(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length === 0) {
    ctx.stderr.write("source: filename argument required\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const scriptPath = args[0];

  try {
    const { value: scriptContent, label: scriptLabel } = ctx.vfs.readFileText(scriptPath);

    // Check integrity
    if (hasDangerousIntegrity(scriptLabel) && !hasSufficientIntegrity(scriptLabel)) {
      return blockExecution(ctx, scriptLabel);
    }

    // In a real implementation, this would parse and execute in current environment
    ctx.stderr.write(
      "[CFC-SHELL] source requires full interpreter (Phase 5)\n",
      ctx.pcLabel
    );
    return { exitCode: 126, label: ctx.pcLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`source: ${scriptPath}: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}
