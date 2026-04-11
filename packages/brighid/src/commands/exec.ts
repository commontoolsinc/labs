/**
 * Execution commands: bash, eval, source
 *
 * These are CRITICAL commit points for prompt injection defense.
 * They check integrity before executing any code/scripts.
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { type Label, labels } from "../labels.ts";
import { defaultConfig } from "../sandbox/config.ts";

/**
 * Check if a label has sufficient integrity for execution
 */
function hasSufficientIntegrity(label: Label): boolean {
  // Required integrity: EndorsedBy(user) OR CodeHash(trusted) OR UserInput
  const hasUserEndorsement = labels.hasIntegrity(label, {
    kind: "EndorsedBy",
    principal: "user",
  });
  const hasUserInput = labels.hasIntegrity(label, { kind: "UserInput" });

  // Check for CodeHash (any trusted hash)
  const hasCodeHash = label.integrity.some((atom) => atom.kind === "CodeHash");

  return hasUserEndorsement || hasUserInput || hasCodeHash;
}

/**
 * Check if a label has dangerous low-integrity markers
 */
function hasDangerousIntegrity(label: Label): boolean {
  // Dangerous: Origin(*) OR LLMGenerated without sufficient endorsement
  const hasOrigin = label.integrity.some((atom) => atom.kind === "Origin");
  const hasLLMGenerated = label.integrity.some((atom) =>
    atom.kind === "LLMGenerated"
  );

  return hasOrigin || hasLLMGenerated;
}

/**
 * Format label integrity for error messages
 */
function formatIntegrity(label: Label): string {
  if (label.integrity.length === 0) {
    return "none";
  }

  return label.integrity.map((atom) => {
    if (atom.kind === "Origin") return `Origin(${atom.url})`;
    if (atom.kind === "LLMGenerated") {
      return `LLMGenerated(${atom.model || "*"})`;
    }
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
function blockExecution(
  ctx: CommandContext,
  contentLabel: Label,
): CommandResult {
  const integrityStr = formatIntegrity(contentLabel);

  ctx.stderr.write(
    `[BRIGHID] Blocked: script content lacks sufficient integrity for execution.\n` +
      `Content has integrity: [${integrityStr}].\n` +
      `Required: EndorsedBy(user) or UserInput or CodeHash(trusted).\n`,
    ctx.pcLabel,
  );

  return { exitCode: 126, label: ctx.pcLabel }; // Permission denied
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function guestPathForVfsPath(vfsPath: string, guestWorkspacePath: string): string {
  if (vfsPath === "/") {
    return guestWorkspacePath;
  }

  const segments = vfsPath.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return `${guestWorkspacePath}${vfsPath}`;
  }

  return vfsPath;
}

async function runSandboxedBash(
  command: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const executor = ctx.getSandboxExecutor(defaultConfig);
  const guestWorkspacePath = executor.getConfig().guestWorkspacePath;
  const guestCwd = guestPathForVfsPath(ctx.vfs.cwd, guestWorkspacePath);
  const wrappedCommand = `cd ${shellSingleQuote(guestCwd)} && ${command}`;

  const stdinData = await ctx.stdin.readAll();
  const result = await executor.execute(
    "/bin/bash",
    ["-lc", wrappedCommand],
    stdinData.value.length > 0 ? stdinData : null,
    [ctx.pcLabel],
    ctx.vfs,
    ["/"],
    { cwd: ctx.vfs.cwd, mirrorRootIntoGuest: true },
  );

  if (result.stdout.value) {
    await ctx.stdout.write(result.stdout.value, result.stdout.label);
  }
  if (result.stderr.value) {
    await ctx.stderr.write(result.stderr.value, result.stderr.label);
  }

  ctx.stdout.close();
  ctx.stderr.close();

  return {
    exitCode: result.exitCode,
    label: result.stdout.value ? result.stdout.label : result.stderr.label,
  };
}

/**
 * bash - execute bash script
 */
export async function bash(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  if (args.length >= 2 && args[0] === "-c") {
    const command = args[1];
    const commandLabel = ctx.pcLabel;

    if (
      hasDangerousIntegrity(commandLabel) &&
      !hasSufficientIntegrity(commandLabel)
    ) {
      return blockExecution(ctx, commandLabel);
    }

    return await runSandboxedBash(command, ctx);
  }

  if (args.length >= 1) {
    const scriptPath = args[0];

    try {
      const { value: scriptContent, label: scriptLabel } = ctx.vfs.readFileText(
        scriptPath,
      );

      if (
        hasDangerousIntegrity(scriptLabel) &&
        !hasSufficientIntegrity(scriptLabel)
      ) {
        return blockExecution(ctx, scriptLabel);
      }

      const executor = ctx.getSandboxExecutor(defaultConfig);
      const stdinData = await ctx.stdin.readAll();
      const scriptStdin = {
        value: stdinData.value.length > 0
          ? `${scriptContent}\n${stdinData.value}`
          : scriptContent,
        label: labels.join(scriptLabel, stdinData.label),
      };
      const result = await executor.execute(
        "/bin/bash",
        ["-s"],
        scriptStdin,
        [ctx.pcLabel, scriptLabel],
        ctx.vfs,
        ["/"],
        { cwd: ctx.vfs.cwd, mirrorRootIntoGuest: true },
      );

      if (result.stdout.value) {
        await ctx.stdout.write(result.stdout.value, result.stdout.label);
      }
      if (result.stderr.value) {
        await ctx.stderr.write(result.stderr.value, result.stderr.label);
      }

      ctx.stdout.close();
      ctx.stderr.close();

      return {
        exitCode: result.exitCode,
        label: result.stdout.value ? result.stdout.label : result.stderr.label,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.stderr.write(`bash: ${scriptPath}: ${message}\n`, ctx.pcLabel);
      return { exitCode: 127, label: ctx.pcLabel };
    }
  }

  await ctx.stderr.write("bash: interactive mode not supported\n", ctx.pcLabel);
  return { exitCode: 1, label: ctx.pcLabel };
}

/**
 * eval - evaluate command string
 */
export async function evalCmd(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  if (args.length === 0) {
    return { exitCode: 0, label: ctx.pcLabel };
  }

  const command = args.join(" ");
  const commandLabel = ctx.pcLabel;

  if (
    hasDangerousIntegrity(commandLabel) && !hasSufficientIntegrity(commandLabel)
  ) {
    return blockExecution(ctx, commandLabel);
  }

  return await runSandboxedBash(command, ctx);
}

/**
 * source - execute commands from file in current shell
 */
export async function source(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  if (args.length === 0) {
    await ctx.stderr.write("source: filename argument required\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const scriptPath = args[0];

  try {
    const { value: _scriptContent, label: scriptLabel } = ctx.vfs.readFileText(
      scriptPath,
    );

    if (
      hasDangerousIntegrity(scriptLabel) && !hasSufficientIntegrity(scriptLabel)
    ) {
      return blockExecution(ctx, scriptLabel);
    }

    await ctx.stderr.write(
      "[BRIGHID] source is not supported with the gVisor backend because a sandboxed subprocess cannot safely mutate the current shell environment.\n",
      ctx.pcLabel,
    );
    return { exitCode: 126, label: ctx.pcLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.stderr.write(`source: ${scriptPath}: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}
