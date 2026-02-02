/**
 * Search commands: grep
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels } from "../labels.ts";
import { expandGlob } from "../glob.ts";

/**
 * grep - search for pattern in files
 */
export async function grep(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  let caseInsensitive = false;
  let showLineNumbers = false;
  let invertMatch = false;
  let countOnly = false;
  let recursive = false;
  let filesOnly = false;
  // deno-lint-ignore no-unused-vars
  let useExtendedRegex = false;
  let pattern = "";
  const files: string[] = [];

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-i") {
      caseInsensitive = true;
    } else if (arg === "-n") {
      showLineNumbers = true;
    } else if (arg === "-v") {
      invertMatch = true;
    } else if (arg === "-c") {
      countOnly = true;
    } else if (arg === "-r") {
      recursive = true;
    } else if (arg === "-l") {
      filesOnly = true;
    } else if (arg === "-E") {
      useExtendedRegex = true;
    } else if (arg.startsWith("-")) {
      // Handle combined flags like -inr
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === "i") caseInsensitive = true;
        else if (arg[j] === "n") showLineNumbers = true;
        else if (arg[j] === "v") invertMatch = true;
        else if (arg[j] === "c") countOnly = true;
        else if (arg[j] === "r") recursive = true;
        else if (arg[j] === "l") filesOnly = true;
        else if (arg[j] === "E") useExtendedRegex = true;
      }
    } else if (!pattern) {
      pattern = arg;
    } else {
      files.push(arg);
    }
  }

  if (!pattern) {
    ctx.stderr.write("grep: missing pattern\n", ctx.pcLabel);
    return { exitCode: 2, label: ctx.pcLabel };
  }

  // Create regex
  let regex: RegExp;
  try {
    const flags = caseInsensitive ? "i" : "";
    regex = new RegExp(pattern, flags);
  } catch {
    ctx.stderr.write(`grep: invalid pattern: ${pattern}\n`, ctx.pcLabel);
    return { exitCode: 2, label: ctx.pcLabel };
  }

  // Pattern label from PC (since it's in the command)
  let outputLabel = ctx.pcLabel;
  let exitCode = 1; // No matches by default
  let _foundMatch = false;

  const processFile = (
    path: string,
    content: string,
    fileLabel: typeof outputLabel,
  ) => {
    const lines = content.split("\n");
    let matchCount = 0;
    let hasMatch = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matches = regex.test(line);
      const shouldOutput = invertMatch ? !matches : matches;

      if (shouldOutput) {
        matchCount++;
        hasMatch = true;
        _foundMatch = true;

        if (countOnly || filesOnly) {
          // Don't output lines yet
        } else {
          const prefix = showLineNumbers ? `${i + 1}:` : "";
          const filePrefix = files.length > 1 ? `${path}:` : "";
          ctx.stdout.write(
            `${filePrefix}${prefix}${line}\n`,
            labels.join(outputLabel, fileLabel),
          );
        }
      }
    }

    if (countOnly) {
      const filePrefix = files.length > 1 ? `${path}:` : "";
      ctx.stdout.write(
        `${filePrefix}${matchCount}\n`,
        labels.join(outputLabel, fileLabel),
      );
    } else if (filesOnly && hasMatch) {
      ctx.stdout.write(`${path}\n`, labels.join(outputLabel, fileLabel));
    }

    return hasMatch;
  };

  if (files.length === 0) {
    // Read from stdin
    const { value, label } = await ctx.stdin.readAll();
    outputLabel = labels.join(outputLabel, label);
    if (processFile("-", value, label)) {
      exitCode = 0;
    }
  } else {
    // Process files
    for (const filePattern of files) {
      try {
        if (
          recursive || filePattern.includes("*") || filePattern.includes("?")
        ) {
          // Expand glob
          const { value: matches, label: globLabel } = expandGlob(
            ctx.vfs,
            filePattern,
          );
          outputLabel = labels.join(outputLabel, globLabel);

          for (const match of matches) {
            try {
              const node = ctx.vfs.resolve(match, true);
              if (node?.kind === "file") {
                const { value, label } = ctx.vfs.readFileText(match);
                outputLabel = labels.join(outputLabel, label);
                if (processFile(match, value, label)) {
                  exitCode = 0;
                }
              }
            } catch {
              // Skip inaccessible files
            }
          }
        } else {
          // Single file
          const { value, label } = ctx.vfs.readFileText(filePattern);
          outputLabel = labels.join(outputLabel, label);
          if (processFile(filePattern, value, label)) {
            exitCode = 0;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.stderr.write(`grep: ${filePattern}: ${message}\n`, ctx.pcLabel);
        exitCode = 2;
      }
    }
  }

  return { exitCode, label: outputLabel, fixedOutputFormat: countOnly };
}
