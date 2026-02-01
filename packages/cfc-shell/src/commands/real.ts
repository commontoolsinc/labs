/**
 * !real command - Sandboxed Real Execution escape hatch
 *
 * Allows running real programs when the simulated command set is insufficient.
 * Results are imported back with conservative labels based on inputs.
 *
 * Usage:
 *   !real [--net] [--read PATH] [--write PATH] [--timeout MS] [--profile NAME] -- COMMAND [ARGS...]
 *
 * Flags:
 *   --net          Allow network access
 *   --read PATH    Mount VFS path as readable in sandbox
 *   --write PATH   Mount VFS path as writable (results imported back)
 *   --timeout MS   Override timeout
 *   --profile NAME Use a named sandbox profile
 *   --             Separator between !real flags and the actual command
 *
 * Examples:
 *   !real python script.py
 *   !real --net -- npm install
 *   !real --read /data --write /output -- python process.py
 *   !real --profile python-data -- python train.py
 */

import { CommandFn, CommandResult, CommandContext } from "./context.ts";
import { SandboxedExecutor } from "../sandbox/executor.ts";
import { defaultConfig, mergeConfig, getProfile } from "../sandbox/config.ts";
import { labels } from "../labels.ts";

/**
 * Parse !real command flags
 */
interface RealCommandFlags {
  net: boolean;
  readPaths: string[];
  writePaths: string[];
  timeout?: number;
  profile?: string;
  command: string[];
}

function parseRealFlags(args: string[]): RealCommandFlags {
  const flags: RealCommandFlags = {
    net: false,
    readPaths: [],
    writePaths: [],
    command: [],
  };

  let i = 0;
  let foundSeparator = false;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--") {
      // Everything after -- is the actual command
      foundSeparator = true;
      i++;
      break;
    } else if (arg === "--net") {
      flags.net = true;
      i++;
    } else if (arg === "--read") {
      if (i + 1 >= args.length) {
        throw new Error("--read requires a PATH argument");
      }
      flags.readPaths.push(args[i + 1]);
      i += 2;
    } else if (arg === "--write") {
      if (i + 1 >= args.length) {
        throw new Error("--write requires a PATH argument");
      }
      flags.writePaths.push(args[i + 1]);
      i += 2;
    } else if (arg === "--timeout") {
      if (i + 1 >= args.length) {
        throw new Error("--timeout requires a MS argument");
      }
      const timeout = parseInt(args[i + 1], 10);
      if (isNaN(timeout) || timeout <= 0) {
        throw new Error("--timeout must be a positive number");
      }
      flags.timeout = timeout;
      i += 2;
    } else if (arg === "--profile") {
      if (i + 1 >= args.length) {
        throw new Error("--profile requires a NAME argument");
      }
      flags.profile = args[i + 1];
      i += 2;
    } else {
      // Not a flag - rest is the command
      break;
    }
  }

  // Everything remaining is the command
  flags.command = args.slice(i);

  if (flags.command.length === 0) {
    throw new Error("!real requires a COMMAND to execute");
  }

  return flags;
}

/**
 * The !real escape hatch command
 */
export const realCommand: CommandFn = async (
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> => {
  // Parse flags
  let flags: RealCommandFlags;
  try {
    flags = parseRealFlags(args);
  } catch (error) {
    await ctx.stderr.write(
      `!real: ${error instanceof Error ? error.message : String(error)}\n`,
      labels.bottom(),
    );
    ctx.stderr.close();
    ctx.stdout.close();
    return {
      exitCode: 1,
      label: labels.bottom(),
    };
  }

  // Extract command and args
  const [command, ...commandArgs] = flags.command;

  // Request intent from user (always required for real execution)
  const intentGranted = await ctx.requestIntent(
    "real-exec",
    `Execute real command: ${command} ${commandArgs.join(" ")}`,
  );

  if (!intentGranted) {
    await ctx.stderr.write(
      "!real: User denied intent for real execution\n",
      labels.bottom(),
    );
    ctx.stderr.close();
    ctx.stdout.close();
    return {
      exitCode: 1,
      label: labels.bottom(),
    };
  }

  // Build sandbox config
  let config = { ...defaultConfig };

  // Apply profile if specified
  if (flags.profile) {
    const profile = getProfile(flags.profile);
    if (!profile) {
      await ctx.stderr.write(
        `!real: Unknown profile: ${flags.profile}\n`,
        labels.bottom(),
      );
      ctx.stderr.close();
      ctx.stdout.close();
      return {
        exitCode: 1,
        label: labels.bottom(),
      };
    }
    config = mergeConfig(config, profile.config);
  }

  // Apply flags
  const flagOverrides: Partial<typeof config> = {};
  if (flags.net) {
    flagOverrides.allowNetwork = true;
  }
  if (flags.readPaths.length > 0) {
    // Add to allowed read paths (both read and write paths need to be in allowedReadPaths)
    flagOverrides.allowedReadPaths = [
      ...config.allowedReadPaths,
      ...flags.readPaths,
      ...flags.writePaths,
    ];
  }
  if (flags.writePaths.length > 0) {
    flagOverrides.allowedWritePaths = [
      ...config.allowedWritePaths,
      ...flags.writePaths,
    ];
  }
  if (flags.timeout !== undefined) {
    flagOverrides.timeout = flags.timeout;
  }

  config = mergeConfig(config, flagOverrides);

  // Create executor
  const executor = new SandboxedExecutor(config);

  // Collect input labels: PC label + stdin label + labels of read paths
  const inputLabels = [ctx.pcLabel];

  // Read stdin if available
  const stdinData = await ctx.stdin.readAll();
  inputLabels.push(stdinData.label);

  // Collect labels from read paths
  for (const readPath of [...flags.readPaths, ...flags.writePaths]) {
    try {
      // Normalize path
      const normalizedPath = ctx.vfs.resolvePath(readPath);

      // Get node to check if it exists
      const node = ctx.vfs.resolve(normalizedPath, true);
      if (!node) {
        continue;
      }

      if (node.kind === "file") {
        const { label } = ctx.vfs.readFile(normalizedPath);
        inputLabels.push(label);
      } else if (node.kind === "directory") {
        // Collect labels from all files in directory recursively
        await collectDirLabels(ctx.vfs, normalizedPath, inputLabels);
      }
    } catch (error) {
      // Path doesn't exist or error reading - skip
      console.error(`Failed to read ${readPath}: ${error}`);
    }
  }

  // Determine which VFS paths to export
  const exportPaths = [...flags.readPaths, ...flags.writePaths];

  try {
    // Execute command
    const result = await executor.execute(
      command,
      commandArgs,
      stdinData.value ? stdinData : null,
      inputLabels,
      ctx.vfs,
      exportPaths,
    );

    // Write stdout
    await ctx.stdout.write(result.stdout.value, result.stdout.label);

    // Write stderr
    if (result.stderr.value) {
      await ctx.stderr.write(result.stderr.value, result.stderr.label);
    }

    // Close streams
    ctx.stdout.close();
    ctx.stderr.close();

    // Return result with output label
    return {
      exitCode: result.exitCode,
      label: result.stdout.label,
    };
  } catch (error) {
    await ctx.stderr.write(
      `!real: Execution failed: ${error instanceof Error ? error.message : String(error)}\n`,
      labels.bottom(),
    );
    ctx.stderr.close();
    ctx.stdout.close();
    return {
      exitCode: 1,
      label: labels.bottom(),
    };
  }
};

/**
 * Recursively collect labels from all files in a directory
 */
async function collectDirLabels(
  vfs: any,
  dirPath: string,
  labels: any[],
): Promise<void> {
  try {
    const { value: entries } = vfs.readdir(dirPath);

    for (const entry of entries) {
      const childPath = dirPath === "/" ? `/${entry}` : `${dirPath}/${entry}`;
      const node = vfs.resolve(childPath, true);

      if (!node) {
        continue;
      }

      if (node.kind === "file") {
        const { label } = vfs.readFile(childPath);
        labels.push(label);
      } else if (node.kind === "directory") {
        await collectDirLabels(vfs, childPath, labels);
      }
    }
  } catch (error) {
    console.error(`Failed to collect labels from ${dirPath}: ${error}`);
  }
}
