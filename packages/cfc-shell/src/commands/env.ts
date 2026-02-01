/**
 * Environment commands: export, unset, env, printenv
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels } from "../labels.ts";

/**
 * export - mark variables as exported
 */
export async function exportCmd(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length === 0) {
    // Show all exported variables
    const exported = ctx.env.exported();
    let outputLabel = ctx.pcLabel;

    for (const [name, { value, label }] of exported) {
      ctx.stdout.write(`export ${name}=${value}\n`, label);
      outputLabel = labels.join(outputLabel, label);
    }

    return { exitCode: 0, label: outputLabel };
  }

  for (const arg of args) {
    if (arg.includes("=")) {
      // export NAME=VALUE
      const [name, ...valueParts] = arg.split("=");
      const value = valueParts.join("=");
      ctx.env.set(name, value, ctx.pcLabel);
      ctx.env.export(name);
    } else {
      // export NAME (mark existing or create empty)
      ctx.env.export(arg);
    }
  }

  return { exitCode: 0, label: ctx.pcLabel };
}

/**
 * unset - remove variables
 */
export async function unset(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length === 0) {
    ctx.stderr.write("unset: not enough arguments\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  for (const name of args) {
    try {
      ctx.env.unset(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.stderr.write(`unset: ${name}: ${message}\n`, ctx.pcLabel);
    }
  }

  return { exitCode: 0, label: ctx.pcLabel };
}

/**
 * env - print all exported variables
 */
export async function env(_args: string[], ctx: CommandContext): Promise<CommandResult> {
  const exported = ctx.env.exported();
  let outputLabel = ctx.pcLabel;

  const entries = Array.from(exported.entries()).sort(([a], [b]) => a.localeCompare(b));

  for (const [name, { value, label }] of entries) {
    ctx.stdout.write(`${name}=${value}\n`, label);
    outputLabel = labels.join(outputLabel, label);
  }

  return { exitCode: 0, label: outputLabel };
}

/**
 * printenv - print environment variable(s)
 */
export async function printenv(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length === 0) {
    // Print all variables
    const exported = ctx.env.exported();
    let outputLabel = ctx.pcLabel;

    const entries = Array.from(exported.entries()).sort(([a], [b]) => a.localeCompare(b));

    for (const [name, { value, label }] of entries) {
      ctx.stdout.write(`${name}=${value}\n`, label);
      outputLabel = labels.join(outputLabel, label);
    }

    return { exitCode: 0, label: outputLabel };
  } else {
    // Print specific variable
    const name = args[0];
    const variable = ctx.env.get(name);

    if (variable) {
      ctx.stdout.write(variable.value + "\n", variable.label);
      return { exitCode: 0, label: variable.label };
    } else {
      return { exitCode: 1, label: ctx.pcLabel };
    }
  }
}
