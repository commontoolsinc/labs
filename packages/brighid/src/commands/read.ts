/**
 * Read commands: cat, head, tail, wc, diff
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels } from "../labels.ts";

/**
 * cat - concatenate files to stdout
 */
export async function cat(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  // If no args, copy stdin to stdout
  if (args.length === 0) {
    const { value, label } = await ctx.stdin.readAll();
    ctx.stdout.write(value, label);
    return { exitCode: 0, label };
  }

  let outputLabel = ctx.pcLabel;
  let exitCode = 0;

  for (const path of args) {
    try {
      const { value, label } = ctx.vfs.readFileText(path);
      ctx.stdout.write(value, label);
      outputLabel = labels.join(outputLabel, label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.stderr.write(`cat: ${path}: ${message}\n`, ctx.pcLabel);
      exitCode = 1;
    }
  }

  return { exitCode, label: outputLabel };
}

/**
 * head - output first N lines
 */
export async function head(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  let n = 10;
  let file: string | null = null;

  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n" && i + 1 < args.length) {
      n = parseInt(args[i + 1], 10);
      i++;
    } else if (
      args[i].startsWith("-") && !isNaN(parseInt(args[i].slice(1), 10))
    ) {
      n = parseInt(args[i].slice(1), 10);
    } else {
      file = args[i];
    }
  }

  try {
    let content: string;
    let label;

    if (file) {
      ({ value: content, label } = ctx.vfs.readFileText(file));
    } else {
      ({ value: content, label } = await ctx.stdin.readAll());
    }

    const lines = content.split("\n");
    const output = lines.slice(0, n).join("\n");
    if (output) {
      ctx.stdout.write(output + (lines.length > n ? "\n" : ""), label);
    }

    return { exitCode: 0, label };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`head: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * tail - output last N lines
 */
export async function tail(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  let n = 10;
  let file: string | null = null;

  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n" && i + 1 < args.length) {
      n = parseInt(args[i + 1], 10);
      i++;
    } else if (
      args[i].startsWith("-") && !isNaN(parseInt(args[i].slice(1), 10))
    ) {
      n = parseInt(args[i].slice(1), 10);
    } else {
      file = args[i];
    }
  }

  try {
    let content: string;
    let label;

    if (file) {
      ({ value: content, label } = ctx.vfs.readFileText(file));
    } else {
      ({ value: content, label } = await ctx.stdin.readAll());
    }

    const lines = content.split("\n");
    const output = lines.slice(-n).join("\n");
    if (output) {
      ctx.stdout.write(output, label);
    }

    return { exitCode: 0, label };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`tail: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * wc - count lines, words, characters
 */
export async function wc(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  let countLines = false;
  let countWords = false;
  let countChars = false;
  const files: string[] = [];

  // Parse flags
  for (const arg of args) {
    if (arg === "-l") {
      countLines = true;
    } else if (arg === "-w") {
      countWords = true;
    } else if (arg === "-c") {
      countChars = true;
    } else if (!arg.startsWith("-")) {
      files.push(arg);
    }
  }

  // Default: count all
  if (!countLines && !countWords && !countChars) {
    countLines = countWords = countChars = true;
  }

  let outputLabel = ctx.pcLabel;
  let exitCode = 0;

  const processContent = (content: string, name: string) => {
    const lines = content.split("\n").length - 1;
    const words = content.split(/\s+/).filter((w) => w.length > 0).length;
    const chars = content.length;

    const parts: string[] = [];
    if (countLines) parts.push(lines.toString().padStart(8));
    if (countWords) parts.push(words.toString().padStart(8));
    if (countChars) parts.push(chars.toString().padStart(8));

    return parts.join(" ") + (name ? ` ${name}` : "") + "\n";
  };

  if (files.length === 0) {
    // Read from stdin
    const { value, label } = await ctx.stdin.readAll();
    ctx.stdout.write(processContent(value, ""), label);
    outputLabel = labels.join(outputLabel, label);
  } else {
    for (const file of files) {
      try {
        const { value, label } = ctx.vfs.readFileText(file);
        ctx.stdout.write(processContent(value, file), label);
        outputLabel = labels.join(outputLabel, label);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.stderr.write(`wc: ${file}: ${message}\n`, ctx.pcLabel);
        exitCode = 1;
      }
    }
  }

  return { exitCode, label: outputLabel, fixedOutputFormat: true };
}

/**
 * diff - simple line-by-line diff
 */
export async function diff(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  if (args.length < 2) {
    ctx.stderr.write("diff: missing operand\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const [file1, file2] = args;

  try {
    const { value: content1, label: label1 } = ctx.vfs.readFileText(file1);
    const { value: content2, label: label2 } = ctx.vfs.readFileText(file2);

    const lines1 = content1.split("\n");
    const lines2 = content2.split("\n");

    const outputLabel = labels.join(label1, label2);

    let hasDiff = false;

    // Simple line-by-line comparison
    const maxLen = Math.max(lines1.length, lines2.length);
    for (let i = 0; i < maxLen; i++) {
      const line1 = lines1[i] ?? "";
      const line2 = lines2[i] ?? "";

      if (line1 !== line2) {
        if (!hasDiff) {
          ctx.stdout.write(`--- ${file1}\n+++ ${file2}\n`, outputLabel);
          hasDiff = true;
        }

        if (i < lines1.length) {
          ctx.stdout.write(`< ${line1}\n`, outputLabel);
        }
        if (i < lines2.length) {
          ctx.stdout.write(`> ${line2}\n`, outputLabel);
        }
      }
    }

    return { exitCode: hasDiff ? 1 : 0, label: outputLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`diff: ${message}\n`, ctx.pcLabel);
    return { exitCode: 2, label: ctx.pcLabel };
  }
}
