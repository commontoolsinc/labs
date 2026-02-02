/**
 * Miscellaneous commands: date, true, false, test/[, sleep, read, which, xargs
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels } from "../labels.ts";

/**
 * date - output current date
 */
export async function date(
  _args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  const now = new Date().toString();
  ctx.stdout.write(now + "\n", ctx.pcLabel);
  return { exitCode: 0, label: ctx.pcLabel, fixedOutputFormat: true };
}

/**
 * true - always succeed
 */
export async function trueCmd(
  _args: string[],
  _ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  return { exitCode: 0, label: labels.bottom(), fixedOutputFormat: true };
}

/**
 * false - always fail
 */
export async function falseCmd(
  _args: string[],
  _ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  return { exitCode: 1, label: labels.bottom(), fixedOutputFormat: true };
}

/**
 * test / [ - evaluate conditional expression
 */
export async function test(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  // Remove trailing ] if this was called as [
  if (args.length > 0 && args[args.length - 1] === "]") {
    args = args.slice(0, -1);
  }

  if (args.length === 0) {
    return { exitCode: 1, label: ctx.pcLabel };
  }

  let outputLabel = ctx.pcLabel;

  try {
    const result = evaluateTestExpression(args, ctx, (label) => {
      outputLabel = labels.join(outputLabel, label);
    });

    return {
      exitCode: result ? 0 : 1,
      label: outputLabel,
      fixedOutputFormat: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`test: ${message}\n`, ctx.pcLabel);
    return { exitCode: 2, label: ctx.pcLabel };
  }
}

function evaluateTestExpression(
  args: string[],
  ctx: CommandContext,
  trackLabel: (label: typeof ctx.pcLabel) => void,
): boolean {
  if (args.length === 0) {
    return false;
  }

  // Handle negation
  if (args[0] === "!") {
    return !evaluateTestExpression(args.slice(1), ctx, trackLabel);
  }

  // File tests
  if (args[0] === "-f" && args.length >= 2) {
    const exists = ctx.vfs.exists(args[1]);
    const node = exists ? ctx.vfs.resolve(args[1], true) : null;
    if (node) {
      trackLabel(node.label);
    }
    return node?.kind === "file";
  }

  if (args[0] === "-d" && args.length >= 2) {
    const exists = ctx.vfs.exists(args[1]);
    const node = exists ? ctx.vfs.resolve(args[1], true) : null;
    if (node) {
      trackLabel(node.label);
    }
    return node?.kind === "directory";
  }

  if (args[0] === "-e" && args.length >= 2) {
    const exists = ctx.vfs.exists(args[1]);
    if (exists) {
      const node = ctx.vfs.resolve(args[1], true);
      if (node) {
        trackLabel(node.label);
      }
    }
    return exists;
  }

  // String tests
  if (args[0] === "-z" && args.length >= 2) {
    return args[1].length === 0;
  }

  if (args[0] === "-n" && args.length >= 2) {
    return args[1].length > 0;
  }

  // String equality
  if (args.length >= 3 && args[1] === "=") {
    return args[0] === args[2];
  }

  if (args.length >= 3 && args[1] === "!=") {
    return args[0] !== args[2];
  }

  // Non-empty string
  if (args.length === 1) {
    return args[0].length > 0;
  }

  return false;
}

/**
 * sleep - sleep for N seconds
 */
export async function sleep(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  if (args.length === 0) {
    ctx.stderr.write("sleep: missing operand\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const seconds = parseFloat(args[0]);
  if (isNaN(seconds) || seconds < 0) {
    ctx.stderr.write(
      `sleep: invalid time interval '${args[0]}'\n`,
      ctx.pcLabel,
    );
    return { exitCode: 1, label: ctx.pcLabel };
  }

  // Cap at 5 seconds for simulation
  const cappedSeconds = Math.min(seconds, 5);

  await new Promise((resolve) => setTimeout(resolve, cappedSeconds * 1000));

  return { exitCode: 0, label: ctx.pcLabel, fixedOutputFormat: true };
}

/**
 * read - read line from stdin into variable
 */
export async function read(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  let _raw = false;
  let varName = "REPLY";

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-r") {
      _raw = true;
    } else if (!arg.startsWith("-")) {
      varName = arg;
    }
  }

  try {
    const { value, label } = await ctx.stdin.readAll();
    const line = value.split("\n")[0] || "";

    // Store in environment with stdin's label
    ctx.env.set(varName, line, label);

    return { exitCode: 0, label };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`read: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * which - locate a command
 */
export async function which(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  if (args.length === 0) {
    ctx.stderr.write("which: missing argument\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  // This would check the command registry in a full implementation
  // For now, just return success for known commands
  const knownCommands = [
    "cd",
    "pwd",
    "ls",
    "cat",
    "grep",
    "echo",
    "date",
    "true",
    "false",
    "test",
    "[",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "touch",
    "chmod",
    "head",
    "tail",
    "wc",
    "diff",
    "sed",
    "sort",
    "uniq",
    "cut",
    "tr",
    "jq",
    "base64",
    "tee",
    "sleep",
    "read",
    "which",
    "xargs",
    "export",
    "unset",
    "env",
    "printenv",
    "curl",
    "bash",
    "eval",
    "source",
  ];

  const command = args[0];
  const found = knownCommands.includes(command);

  if (found) {
    ctx.stdout.write(`/usr/bin/${command}\n`, ctx.pcLabel);
    return { exitCode: 0, label: ctx.pcLabel, fixedOutputFormat: true };
  } else {
    return { exitCode: 1, label: ctx.pcLabel, fixedOutputFormat: true };
  }
}

/**
 * xargs - execute command with arguments from stdin
 */
export async function xargs(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  let replaceStr: string | null = null;
  const cmdArgs: string[] = [];

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-I" && i + 1 < args.length) {
      replaceStr = args[i + 1];
      i++;
    } else {
      cmdArgs.push(arg);
    }
  }

  if (cmdArgs.length === 0) {
    ctx.stderr.write("xargs: missing command\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  try {
    const { value: input, label: inputLabel } = await ctx.stdin.readAll();
    const lines = input.split("\n").filter((l) => l.trim().length > 0);

    const outputLabel = labels.join(ctx.pcLabel, inputLabel);

    // For now, just output what would be executed
    // In a full implementation with the interpreter, we'd actually execute the commands
    for (const line of lines) {
      let finalArgs = [...cmdArgs];

      if (replaceStr !== null) {
        // Replace occurrences of replaceStr with the line
        finalArgs = finalArgs.map((arg) => arg.replace(replaceStr!, line));
      } else {
        // Append line as argument
        finalArgs.push(line);
      }

      const command = finalArgs.join(" ");
      ctx.stdout.write(`[xargs would execute: ${command}]\n`, outputLabel);
    }

    return { exitCode: 0, label: outputLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`xargs: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}
