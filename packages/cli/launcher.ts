import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CfLauncherOptions {
  denoPath: string;
  labsRoot: string;
  configPath: string;
  cliEntrypoint: string;
  cwd: string;
  cfArgs: readonly string[];
}

export interface CfLauncherCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ParseCfLauncherArgsOptions {
  argv: readonly string[];
  cwd: string;
  initCwd?: string;
  denoPath: string;
  modulePath: string;
}

const optionNamesWithValues = new Set([
  "--deno",
  "--labs-root",
  "--config",
  "--cli-entrypoint",
  "--cwd",
]);

const resolvePath = (base: string, path: string): string =>
  isAbsolute(path) ? path : resolve(base, path);

export const defaultLabsRootFromModulePath = (modulePath: string): string =>
  resolve(dirname(modulePath), "..", "..");

const readInitCwd = (): string | undefined => {
  try {
    const value = Deno.env.get("INIT_CWD");
    return value !== undefined && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
};

const usage =
  `Usage: deno run --allow-run --allow-env --allow-read packages/cli/launcher.ts [options] [--] [cf args...]

Options:
  --deno <path>              Deno executable to use for the child CLI process
  --labs-root <path>         Labs checkout root (defaults to this script's repo)
  --config <path>            Deno config path (defaults to <labs-root>/deno.json)
  --cli-entrypoint <path>    CF CLI entrypoint (defaults to <labs-root>/packages/cli/mod.ts)
  --cwd <path>               Caller working directory for the CF CLI child process
  --launcher-help            Show this help text
`;

export const formatCfLauncherUsage = (): string => usage;

export const parseCfLauncherArgs = (
  options: ParseCfLauncherArgsOptions,
): CfLauncherOptions | { help: true } => {
  const defaultLabsRoot = defaultLabsRootFromModulePath(options.modulePath);
  let denoPath = options.denoPath;
  let labsRoot = defaultLabsRoot;
  let configPath: string | undefined;
  let cliEntrypoint: string | undefined;
  let cwd = options.initCwd ?? options.cwd;
  const cfArgs: string[] = [];

  for (let index = 0; index < options.argv.length; index += 1) {
    const arg = options.argv[index]!;
    if (arg === "--") {
      cfArgs.push(...options.argv.slice(index + 1));
      break;
    }
    if (arg === "--launcher-help") {
      return { help: true };
    }
    if (optionNamesWithValues.has(arg)) {
      const value = options.argv[index + 1];
      if (value === undefined || value === "") {
        throw new Error(`${arg} requires a value`);
      }
      switch (arg) {
        case "--deno":
          denoPath = value;
          break;
        case "--labs-root":
          labsRoot = resolvePath(options.cwd, value);
          break;
        case "--config":
          configPath = resolvePath(options.cwd, value);
          break;
        case "--cli-entrypoint":
          cliEntrypoint = resolvePath(options.cwd, value);
          break;
        case "--cwd":
          cwd = resolvePath(options.cwd, value);
          break;
      }
      index += 1;
      continue;
    }
    cfArgs.push(...options.argv.slice(index));
    break;
  }

  const resolvedLabsRoot = resolvePath(options.cwd, labsRoot);
  return {
    denoPath,
    labsRoot: resolvedLabsRoot,
    configPath: configPath ?? resolve(resolvedLabsRoot, "deno.json"),
    cliEntrypoint: cliEntrypoint ??
      resolve(resolvedLabsRoot, "packages", "cli", "mod.ts"),
    cwd,
    cfArgs,
  };
};

export const buildCfLauncherCommand = (
  options: CfLauncherOptions,
): CfLauncherCommand => ({
  command: options.denoPath,
  args: [
    "run",
    "--config",
    options.configPath,
    "--allow-net",
    "--allow-ffi",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    options.cliEntrypoint,
    ...options.cfArgs,
  ],
  cwd: options.cwd,
  env: {
    CF_CLI_NAME: "cf",
  },
});

const run = async (): Promise<number> => {
  const modulePath = fileURLToPath(import.meta.url);
  const parsed = parseCfLauncherArgs({
    argv: Deno.args,
    cwd: Deno.cwd(),
    initCwd: readInitCwd(),
    denoPath: Deno.execPath(),
    modulePath,
  });
  if ("help" in parsed) {
    console.log(formatCfLauncherUsage());
    return 0;
  }
  const command = buildCfLauncherCommand(parsed);
  const child = new Deno.Command(command.command, {
    args: command.args,
    cwd: command.cwd,
    env: command.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.spawn().status;
  return status.code;
};

if (import.meta.main) {
  Deno.exit(await run());
}
