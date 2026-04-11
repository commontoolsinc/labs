/**
 * Navigation commands: cd, pwd, ls
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels } from "../labels.ts";

/**
 * cd - change working directory
 */
export async function cd(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  const dir = args[0] || ctx.env.get("HOME")?.value || "/";

  try {
    ctx.vfs.cd(dir);
    return { exitCode: 0, label: ctx.pcLabel, fixedOutputFormat: true };
  } catch {
    ctx.stderr.write(`cd: ${dir}: No such file or directory\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel, fixedOutputFormat: true };
  }
}

/**
 * pwd - print working directory
 */
export async function pwd(
  _args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  ctx.stdout.write(ctx.vfs.cwd + "\n", ctx.pcLabel);
  return { exitCode: 0, label: ctx.pcLabel, fixedOutputFormat: true };
}

/**
 * ls - list directory contents
 */
export async function ls(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  let longFormat = false;
  let showAll = false;
  const paths: string[] = [];

  // Parse flags
  for (const arg of args) {
    if (arg === "-l") {
      longFormat = true;
    } else if (arg === "-a") {
      showAll = true;
    } else if (arg === "-la" || arg === "-al") {
      longFormat = true;
      showAll = true;
    } else if (arg.startsWith("-")) {
      // Ignore unknown flags for simplicity
      continue;
    } else {
      paths.push(arg);
    }
  }

  // Default to current directory
  if (paths.length === 0) {
    paths.push(".");
  }

  let outputLabel = ctx.pcLabel;
  let exitCode = 0;

  for (const path of paths) {
    try {
      const node = ctx.vfs.resolve(path, true);

      if (!node) {
        ctx.stderr.write(
          `ls: cannot access '${path}': No such file or directory\n`,
          ctx.pcLabel,
        );
        exitCode = 1;
        continue;
      }

      // Join with the directory's label
      outputLabel = labels.join(outputLabel, node.label);

      if (node.kind === "directory") {
        const entries = Array.from(node.children.entries())
          .filter(([name]) => showAll || !name.startsWith("."))
          .sort(([a], [b]) => a.localeCompare(b));

        for (const [name, child] of entries) {
          if (longFormat) {
            const mode = child.metadata.mode.toString(8).padStart(4, "0");
            const size = child.metadata.size.toString().padStart(8);
            const kind = child.kind === "directory"
              ? "d"
              : child.kind === "symlink"
              ? "l"
              : "-";
            ctx.stdout.write(`${kind}${mode} ${size} ${name}\n`, outputLabel);
          } else {
            ctx.stdout.write(name + "\n", outputLabel);
          }
        }
      } else {
        // Single file
        if (longFormat) {
          const mode = node.metadata.mode.toString(8).padStart(4, "0");
          const size = node.metadata.size.toString().padStart(8);
          const kind = node.kind === "file" ? "-" : "l";
          ctx.stdout.write(`${kind}${mode} ${size} ${path}\n`, outputLabel);
        } else {
          ctx.stdout.write(path + "\n", outputLabel);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.stderr.write(`ls: ${path}: ${message}\n`, ctx.pcLabel);
      exitCode = 1;
    }
  }

  return { exitCode, label: outputLabel, fixedOutputFormat: true };
}
