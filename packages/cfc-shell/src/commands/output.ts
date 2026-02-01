/**
 * Output commands: echo, printf
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels } from "../labels.ts";

/**
 * echo - output arguments
 */
export async function echo(args: string[], ctx: CommandContext): Promise<CommandResult> {
  let suppressNewline = false;
  const outputArgs: string[] = [];

  // Parse args
  for (const arg of args) {
    if (arg === "-n") {
      suppressNewline = true;
    } else {
      outputArgs.push(arg);
    }
  }

  const output = outputArgs.join(" ");
  const suffix = suppressNewline ? "" : "\n";

  // Label comes from PC (since these are literal arguments or expanded variables)
  ctx.stdout.write(output + suffix, ctx.pcLabel);

  return { exitCode: 0, label: ctx.pcLabel };
}

/**
 * printf - formatted output
 */
export async function printf(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length === 0) {
    ctx.stderr.write("printf: missing format\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const format = args[0];
  const formatArgs = args.slice(1);

  try {
    let output = "";
    let argIndex = 0;

    for (let i = 0; i < format.length; i++) {
      if (format[i] === "\\") {
        // Handle escape sequences
        if (i + 1 < format.length) {
          const next = format[i + 1];
          if (next === "n") {
            output += "\n";
            i++;
          } else if (next === "t") {
            output += "\t";
            i++;
          } else if (next === "\\") {
            output += "\\";
            i++;
          } else {
            output += "\\";
          }
        } else {
          output += "\\";
        }
      } else if (format[i] === "%") {
        // Handle format specifiers
        if (i + 1 < format.length) {
          const next = format[i + 1];
          if (next === "%") {
            output += "%";
            i++;
          } else if (next === "s") {
            output += formatArgs[argIndex] || "";
            argIndex++;
            i++;
          } else if (next === "d") {
            const num = parseInt(formatArgs[argIndex] || "0", 10);
            output += num.toString();
            argIndex++;
            i++;
          } else if (next === "x") {
            const num = parseInt(formatArgs[argIndex] || "0", 10);
            output += num.toString(16);
            argIndex++;
            i++;
          } else {
            output += "%";
          }
        } else {
          output += "%";
        }
      } else {
        output += format[i];
      }
    }

    // Label from PC (format and args are part of the command)
    ctx.stdout.write(output, ctx.pcLabel);

    return { exitCode: 0, label: ctx.pcLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`printf: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}
