import { basename } from "@std/path";
import { buildFuseChildDenoArgs, fuseMod } from "./fuse.ts";

export interface FuseSupervisorOptions {
  mountpoint: string;
  apiUrl: string;
  identity: string;
  execCli: string;
  logFile: string;
  spaces: string[];
  allowOther?: boolean;
  noattrcache?: boolean;
  attrcacheTimeout?: string;
  cfcMode?: string;
  cfcAnnotations?: boolean;
  cfcXattrNamespace?: string;
  cfcWritebackXattrs?: boolean;
  cfcWritebackState?: string;
  statePath?: string;
  supervisorStatusPath?: string;
  supervisorToken?: string;
  importMetaUrl?: string;
  command?: FuseCommandConstructor;
  execPath?: string;
  childShutdownTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  exit?: (code: number) => never | void;
  addSignalListener?: (signal: Deno.Signal, handler: () => void) => void;
  removeSignalListener?: (signal: Deno.Signal, handler: () => void) => void;
  supervisorPid?: number;
}

export interface FuseCommandConstructor {
  new (command: string | URL, options: Deno.CommandOptions): {
    spawn(): {
      pid: number;
      status: Promise<Deno.CommandStatus>;
      kill(signal: Deno.Signal): void;
    };
  };
}

export interface SupervisedFuseChild {
  killed?: boolean;
  kill: (signal: Deno.Signal) => void;
  status?: Promise<Deno.CommandStatus>;
}

const DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

export function buildFuseChildCommand(
  options: FuseSupervisorOptions,
): { command: string; args: string[] } {
  const execPath = options.execPath ?? Deno.execPath();
  const execBase = basename(execPath);
  const isCompiledBinary = execBase !== "deno" && execBase !== "deno.exe";

  if (isCompiledBinary) {
    const args = ["fuse-daemon", options.mountpoint];
    if (options.apiUrl) args.push("--api-url", options.apiUrl);
    if (options.identity) args.push("--identity", options.identity);
    if (options.execCli) args.push("--exec-cli", options.execCli);
    if (options.logFile) args.push("--log-file", options.logFile);
    if (options.allowOther) args.push("--allow-other");
    if (options.noattrcache) args.push("--noattrcache");
    if (options.attrcacheTimeout) {
      args.push("--attrcache-timeout", options.attrcacheTimeout);
    }
    if (options.cfcMode) args.push("--cfc-mode", options.cfcMode);
    if (options.cfcAnnotations) args.push("--cfc-annotations");
    if (options.cfcXattrNamespace) {
      args.push("--cfc-xattr-namespace", options.cfcXattrNamespace);
    }
    if (options.cfcWritebackXattrs) args.push("--cfc-writeback-xattrs");
    if (options.cfcWritebackState) {
      args.push("--cfc-writeback-state", options.cfcWritebackState);
    }
    if (options.supervisorStatusPath) {
      args.push("--supervisor-status", options.supervisorStatusPath);
    }
    if (options.supervisorToken) {
      args.push("--supervisor-token", options.supervisorToken);
    }
    for (const space of options.spaces) args.push("--space", space);
    return { command: execPath, args };
  }

  return {
    command: execPath,
    args: buildFuseChildDenoArgs({
      modPath: fuseMod(options.importMetaUrl ?? import.meta.url),
      mountpoint: options.mountpoint,
      apiUrl: options.apiUrl,
      identity: options.identity,
      execCli: options.execCli,
      logFile: options.logFile,
      spaces: options.spaces,
      allowOther: options.allowOther,
      noattrcache: options.noattrcache,
      attrcacheTimeout: options.attrcacheTimeout,
      cfcMode: options.cfcMode,
      cfcAnnotations: options.cfcAnnotations,
      cfcXattrNamespace: options.cfcXattrNamespace,
      cfcWritebackXattrs: options.cfcWritebackXattrs,
      cfcWritebackState: options.cfcWritebackState,
      supervisorStatusPath: options.supervisorStatusPath,
      supervisorToken: options.supervisorToken,
    }),
  };
}

export async function runFuseSupervisor(
  options: FuseSupervisorOptions,
): Promise<void> {
  const childCommand = buildFuseChildCommand(options);
  const CommandCtor = options.command ?? Deno.Command;
  const exit = options.exit ?? Deno.exit;
  const child = new CommandCtor(childCommand.command, {
    args: childCommand.args,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();

  let childExited = false;
  const supervisedChild: SupervisedFuseChild = {
    get killed(): boolean {
      return childExited;
    },
    kill: (signal: Deno.Signal) => child.kill(signal),
    status: child.status,
  };

  let terminating = false;
  const forwardTermination = (signal: Deno.Signal): void => {
    if (terminating) return;
    terminating = true;
    cleanupFuseChild(supervisedChild, {
      signal,
      timeoutMs: options.childShutdownTimeoutMs,
    }).then(() => {
      exit(signal === "SIGINT" ? 130 : 143);
    }).catch(() => {
      exit(1);
    });
  };
  const onSigterm = () => forwardTermination("SIGTERM");
  const onSigint = () => forwardTermination("SIGINT");

  addSupervisorSignalListener("SIGTERM", onSigterm, options.addSignalListener);
  addSupervisorSignalListener("SIGINT", onSigint, options.addSignalListener);

  try {
    if (options.statePath) {
      const recorded = await recordFuseChildPid({
        statePath: options.statePath,
        childPid: child.pid,
        supervisorPid: options.supervisorPid ?? Deno.pid,
        sleep: options.sleep,
      });
      if (!recorded) {
        throw new Error("Unable to record FUSE child PID in mount state.");
      }
    }
    const status = await child.status;
    childExited = true;
    exit(status.code);
  } finally {
    removeSupervisorSignalListener(
      "SIGTERM",
      onSigterm,
      options.removeSignalListener,
    );
    removeSupervisorSignalListener(
      "SIGINT",
      onSigint,
      options.removeSignalListener,
    );
    await cleanupFuseChild(supervisedChild, {
      timeoutMs: options.childShutdownTimeoutMs,
    });
  }
}

export async function cleanupFuseChild(
  child: SupervisedFuseChild,
  options: {
    signal?: Deno.Signal;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  if (child.killed) return;

  const signal = options.signal ?? "SIGTERM";
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS;

  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the status check and kill attempt.
    return;
  }

  if (!child.status) return;

  const timedOut = Symbol("timedOut");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race<Deno.CommandStatus | typeof timedOut>([
    child.status,
    new Promise<typeof timedOut>((resolve) => {
      timeoutId = setTimeout(() => resolve(timedOut), timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });

  if (result !== timedOut) return;

  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited during the timeout window.
  }

  await child.status.catch(() => undefined);
}

export interface ParsedSupervisorArgs {
  options: FuseSupervisorOptions;
  help: boolean;
}

export function parseSupervisorArgs(
  rawArgs: string[],
): ParsedSupervisorArgs {
  const options: FuseSupervisorOptions = {
    mountpoint: "",
    apiUrl: "",
    identity: "",
    execCli: "",
    logFile: "",
    spaces: [],
  };
  let help = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    switch (arg) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--api-url":
        options.apiUrl = requireValue(rawArgs, ++i, arg);
        break;
      case "--identity":
        options.identity = requireValue(rawArgs, ++i, arg);
        break;
      case "--exec-cli":
        options.execCli = requireValue(rawArgs, ++i, arg);
        break;
      case "--log-file":
        options.logFile = requireValue(rawArgs, ++i, arg);
        break;
      case "--allow-other":
        options.allowOther = true;
        break;
      case "--noattrcache":
        options.noattrcache = true;
        break;
      case "--attrcache-timeout":
        options.attrcacheTimeout = requireValue(rawArgs, ++i, arg);
        break;
      case "--cfc-mode":
        options.cfcMode = requireValue(rawArgs, ++i, arg);
        break;
      case "--cfc-annotations":
        options.cfcAnnotations = true;
        break;
      case "--cfc-xattr-namespace":
        options.cfcXattrNamespace = requireValue(rawArgs, ++i, arg);
        break;
      case "--cfc-writeback-xattrs":
        options.cfcWritebackXattrs = true;
        break;
      case "--cfc-writeback-state":
        options.cfcWritebackState = requireValue(rawArgs, ++i, arg);
        break;
      case "--state-path":
        options.statePath = requireValue(rawArgs, ++i, arg);
        break;
      case "--supervisor-status":
        options.supervisorStatusPath = requireValue(rawArgs, ++i, arg);
        break;
      case "--supervisor-token":
        options.supervisorToken = requireValue(rawArgs, ++i, arg);
        break;
      case "--space":
      case "-s":
        options.spaces.push(requireValue(rawArgs, ++i, arg));
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown fuse supervisor option: ${arg}`);
        }
        if (options.mountpoint) {
          throw new Error(`Unexpected fuse supervisor argument: ${arg}`);
        }
        options.mountpoint = arg;
    }
  }

  return { options, help };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function supervisorHelp(): string {
  return `Usage: fuse-supervisor <mountpoint> [options]

Internal: supervise a background FUSE child process.

Options:
  --api-url <url>                 URL of the fabric instance
  --identity <path>               Path to an identity keyfile
  --exec-cli <path>               Path to the cf exec shim
  --log-file <path>               Path to the FUSE child log file
  --allow-other                   Pass allow_other through to the FUSE child
  --noattrcache                   Pass noattrcache through to the FUSE child
  --attrcache-timeout <seconds>   Pass attrcache-timeout through to the FUSE child
  --cfc-mode <mode>               FUSE-side CFC mode
  --cfc-annotations               Publish CFC annotation xattrs
  --cfc-xattr-namespace <ns>      CFC xattr namespace
  --cfc-writeback-xattrs          Enable CFC writeback xattrs
  --cfc-writeback-state <path>    CFC writeback state path
  --state-path <path>             Mount state file to update with child PID
  --supervisor-status <path>      Child readiness and heartbeat status file
  --supervisor-token <token>      Child readiness status correlation token
  -s, --space <name>              Space(s) to connect
  -h, --help                      Show this help
`;
}

export async function recordFuseChildPid(
  options: {
    statePath: string;
    childPid: number;
    supervisorPid: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const state = JSON.parse(
        await Deno.readTextFile(options.statePath),
      ) as Record<string, unknown>;
      if (state.pid !== options.supervisorPid) {
        await sleep(50);
        continue;
      }
      state.childPid = options.childPid;
      await Deno.writeTextFile(
        options.statePath,
        JSON.stringify(state, null, 2),
      );
      return true;
    } catch {
      await sleep(50);
    }
  }
  return false;
}

if (import.meta.main) {
  try {
    const { options, help } = parseSupervisorArgs(Deno.args);
    if (help) {
      console.log(supervisorHelp());
      Deno.exit(0);
    }
    if (!options.mountpoint) {
      throw new Error("Missing mountpoint for fuse supervisor.");
    }
    await runFuseSupervisor(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

function addSupervisorSignalListener(
  signal: Deno.Signal,
  handler: () => void,
  addSignalListener: (signal: Deno.Signal, handler: () => void) => void = Deno
    .addSignalListener,
): void {
  try {
    addSignalListener(signal, handler);
  } catch {
    // Some platforms do not support all signal listeners.
  }
}

function removeSupervisorSignalListener(
  signal: Deno.Signal,
  handler: () => void,
  removeSignalListener: (signal: Deno.Signal, handler: () => void) => void =
    Deno
      .removeSignalListener,
): void {
  try {
    removeSignalListener(signal, handler);
  } catch {
    // Ignore unsupported or already-removed listeners.
  }
}
