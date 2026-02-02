/**
 * Write commands: cp, mv, rm, mkdir, touch, tee, chmod
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels } from "../labels.ts";

/**
 * cp - copy files
 */
export async function cp(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  let recursive = false;
  const paths: string[] = [];

  // Parse args
  for (const arg of args) {
    if (arg === "-r" || arg === "-R") {
      recursive = true;
    } else if (!arg.startsWith("-")) {
      paths.push(arg);
    }
  }

  if (paths.length < 2) {
    ctx.stderr.write("cp: missing destination\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const src = paths[0];
  const dst = paths[1];

  try {
    const srcNode = ctx.vfs.resolve(src, true);

    if (!srcNode) {
      ctx.stderr.write(
        `cp: cannot stat '${src}': No such file or directory\n`,
        ctx.pcLabel,
      );
      return { exitCode: 1, label: ctx.pcLabel };
    }

    if (srcNode.kind === "directory" && !recursive) {
      ctx.stderr.write(
        `cp: -r not specified; omitting directory '${src}'\n`,
        ctx.pcLabel,
      );
      return { exitCode: 1, label: ctx.pcLabel };
    }

    if (srcNode.kind === "file") {
      ctx.vfs.cp(src, dst);
    } else if (srcNode.kind === "directory" && recursive) {
      // Recursive copy
      copyDirectory(ctx, src, dst);
    }

    return { exitCode: 0, label: ctx.pcLabel, fixedOutputFormat: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`cp: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

function copyDirectory(ctx: CommandContext, src: string, dst: string): void {
  const srcNode = ctx.vfs.resolve(src, true);
  if (!srcNode || srcNode.kind !== "directory") return;

  ctx.vfs.mkdir(dst, false);

  for (const [name, child] of srcNode.children) {
    const srcPath = src === "/" ? `/${name}` : `${src}/${name}`;
    const dstPath = dst === "/" ? `/${name}` : `${dst}/${name}`;

    if (child.kind === "file") {
      ctx.vfs.cp(srcPath, dstPath);
    } else if (child.kind === "directory") {
      copyDirectory(ctx, srcPath, dstPath);
    }
  }
}

/**
 * mv - move/rename files
 */
export async function mv(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  if (args.length < 2) {
    ctx.stderr.write("mv: missing destination\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const src = args[0];
  const dst = args[1];

  try {
    ctx.vfs.mv(src, dst);
    return { exitCode: 0, label: ctx.pcLabel, fixedOutputFormat: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`mv: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * rm - remove files/directories
 */
export async function rm(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  let recursive = false;
  let force = false;
  const paths: string[] = [];

  // Parse args
  for (const arg of args) {
    if (arg === "-r" || arg === "-R") {
      recursive = true;
    } else if (arg === "-f") {
      force = true;
    } else if (arg === "-rf" || arg === "-fr") {
      recursive = true;
      force = true;
    } else if (!arg.startsWith("-")) {
      paths.push(arg);
    }
  }

  if (paths.length === 0) {
    ctx.stderr.write("rm: missing operand\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  let exitCode = 0;

  for (const path of paths) {
    try {
      ctx.vfs.rm(path, recursive);
    } catch (err) {
      if (!force) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.stderr.write(`rm: ${message}\n`, ctx.pcLabel);
        exitCode = 1;
      }
    }
  }

  return { exitCode, label: ctx.pcLabel, fixedOutputFormat: true };
}

/**
 * mkdir - create directories
 */
export async function mkdir(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  let parents = false;
  const paths: string[] = [];

  // Parse args
  for (const arg of args) {
    if (arg === "-p") {
      parents = true;
    } else if (!arg.startsWith("-")) {
      paths.push(arg);
    }
  }

  if (paths.length === 0) {
    ctx.stderr.write("mkdir: missing operand\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  let exitCode = 0;

  for (const path of paths) {
    try {
      ctx.vfs.mkdir(path, parents);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.stderr.write(`mkdir: ${message}\n`, ctx.pcLabel);
      exitCode = 1;
    }
  }

  return { exitCode, label: ctx.pcLabel, fixedOutputFormat: true };
}

/**
 * touch - create empty files or update mtime
 */
export async function touch(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  if (args.length === 0) {
    ctx.stderr.write("touch: missing file operand\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  let exitCode = 0;

  for (const path of args) {
    try {
      if (ctx.vfs.exists(path)) {
        // Update mtime
        const { value, label } = ctx.vfs.readFile(path);
        ctx.vfs.writeFile(path, value, label);
      } else {
        // Create empty file
        ctx.vfs.writeFile(path, "", ctx.pcLabel);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.stderr.write(`touch: ${message}\n`, ctx.pcLabel);
      exitCode = 1;
    }
  }

  return { exitCode, label: ctx.pcLabel, fixedOutputFormat: true };
}

/**
 * tee - read from stdin, write to file and stdout
 */
export async function tee(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  let append = false;
  const files: string[] = [];

  // Parse args
  for (const arg of args) {
    if (arg === "-a") {
      append = true;
    } else if (!arg.startsWith("-")) {
      files.push(arg);
    }
  }

  try {
    const { value, label } = await ctx.stdin.readAll();

    // Write to stdout
    ctx.stdout.write(value, label);

    // Write to files
    for (const file of files) {
      try {
        if (append && ctx.vfs.exists(file)) {
          const { value: existing, label: existingLabel } = ctx.vfs
            .readFileText(file);
          const newContent = existing + value;
          const newLabel = labels.join(existingLabel, label);
          ctx.vfs.writeFile(file, newContent, newLabel);
        } else {
          ctx.vfs.writeFile(file, value, label);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.stderr.write(`tee: ${file}: ${message}\n`, ctx.pcLabel);
      }
    }

    return { exitCode: 0, label };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`tee: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * chmod - change file mode
 */
export async function chmod(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  await Promise.resolve();
  if (args.length < 2) {
    ctx.stderr.write("chmod: missing operand\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const modeStr = args[0];
  const path = args[1];

  try {
    const mode = parseInt(modeStr, 8);
    if (isNaN(mode)) {
      ctx.stderr.write(`chmod: invalid mode: '${modeStr}'\n`, ctx.pcLabel);
      return { exitCode: 1, label: ctx.pcLabel };
    }

    ctx.vfs.chmod(path, mode);
    return { exitCode: 0, label: ctx.pcLabel, fixedOutputFormat: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`chmod: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}
