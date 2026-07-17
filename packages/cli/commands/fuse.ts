import { Command } from "@cliffy/command";
import { basename, resolve } from "@std/path";
import ports from "@commonfabric/ports" with { type: "json" };
import {
  buildBackgroundSupervisorDenoArgs,
  buildDenoArgs,
  buildFuseBinaryArgs,
  defaultStateDir,
  ensureExecShim,
  fuseMod,
  fuseSupervisorMod,
  isAlive,
  isMountStateAlive,
  type MountStateEntry,
  prepareMountStatePath,
  readAllMountStates,
  readMountState,
  removeMountStateFile,
  writeMountState,
} from "../lib/fuse.ts";
import { parseAttrcacheTimeoutSeconds } from "../../fuse/mount-options.ts";
import { cliText } from "../lib/cli-name.ts";

export function isFuseProcessCommand(command: string): boolean {
  return command.includes("packages/fuse/mod.ts") ||
    command.includes("packages/cli/lib/fuse-supervisor.ts") ||
    command.includes("fuse-supervisor") ||
    command.includes("fuse-daemon");
}

type FuseChildSupervisorState =
  | "starting"
  | "mounted"
  | "failed"
  | "exiting"
  | "exited";

interface FuseChildSupervisorStatus {
  state: FuseChildSupervisorState;
  pid?: number;
  mountpoint?: string;
  updatedAt?: string;
  error?: string;
  exitCode?: number;
}

export function childStatusPathForStatePath(statePath: string): string {
  return `${statePath}.child-status`;
}

export const mountStatusHeader =
  "MOUNTPOINT\tSUPERVISOR_PID\tCHILD_PID\tSTATUS\tSTARTED\tLOG";

function parseChildSupervisorStatus(
  text: string,
): FuseChildSupervisorStatus | null {
  try {
    const parsed = JSON.parse(text) as Partial<FuseChildSupervisorStatus>;
    switch (parsed.state) {
      case "starting":
      case "mounted":
      case "failed":
      case "exiting":
      case "exited":
        return parsed as FuseChildSupervisorStatus;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const fuseDescription = cliText(
  `Mount Common Fabric spaces as a FUSE filesystem.

Spaces appear as directories at the mount root. Any space name you \`cd\`
into is connected on demand — no need to specify spaces up front.

FILESYSTEM LAYOUT:
  <mountpoint>/
    <space>/                    # one per connected space
      pieces/
        <piece-name>/           # each piece gets a directory
          result/               # exploded JSON tree (dirs, files, symlinks)
          result/*.handler      # executable callables; writing still invokes handlers
          result/*.tool         # executable tools surfaced as mounted callables
          result.json           # full JSON blob
          input/
          input/*.handler
          input/*.tool
          input.json
          meta.json             # piece ID, entity, running pattern ref
        .index.json             # name-to-entity-ID mapping
        pieces.json             # discovery manifest with pattern refs
      entities/                 # access cells by entity ID
      space.json                # { did, name }
    .spaces.json                # known space-name -> DID mapping

  READING:
  ls <space>/pieces/                     # list pieces
  cat <piece>/result.json                # full cell value as JSON
  cat <piece>/result/title               # single scalar field
  cat <piece>/result/items/0/name        # nested access
  head -n1 <piece>/result/search.tool    # callable shebang for cf exec

  WRITING:
  echo '"new title"' > result/title      # write scalar (auto-detects type)
  echo '{"a":1}' > result.json           # replace entire cell
  echo '{"msg":"hi"}' > result/chat.handler  # invoke a stream handler
  touch result/newkey                    # create key (empty string)
  rm result/oldkey                       # delete key
  ln -s ../../other-piece/input/foo result/ref  # sigil link

Requires FUSE-T (preferred) or macFUSE on macOS.`,
);

export async function awaitForegroundMountExit(
  child: { status: Promise<Deno.CommandStatus> },
  statePath: string,
  exit: (code: number) => never | void = Deno.exit,
): Promise<void> {
  const status = await child.status;
  await removeMountStateFile(statePath);
  exit(status.code);
}

async function removeMountStateAndChildStatus(
  statePath: string,
  childStatusPath: string | undefined,
  removeStateFile: (path: string) => Promise<void>,
): Promise<void> {
  await removeStateFile(statePath);
  if (childStatusPath) {
    await removeStateFile(childStatusPath).catch(() => undefined);
  }
}

const CHILD_CONFIRM_MS = 100;

/**
 * Reads readiness lines until the child settles on a state, and returns null
 * once no report can arrive any more.
 *
 * Two things end the read besides a report. End of stream means every process
 * holding the write end has exited. The supervisor exiting means the same thing
 * for a child that cannot report on its own: the FUSE child inherits the write
 * end, so an orphaned child holds the stream open and end of stream never comes.
 */
async function readSettledChildStatus(
  readiness: ReadableStream<Uint8Array>,
  supervisorExit: Promise<unknown>,
): Promise<FuseChildSupervisorStatus | null> {
  const reader = readiness.getReader();
  const decoder = new TextDecoder();
  const supervisorGone = Symbol("supervisorGone");
  let buffered = "";
  try {
    while (true) {
      const next = await Promise.race<
        ReadableStreamReadResult<Uint8Array> | typeof supervisorGone
      >([
        reader.read(),
        supervisorExit.then(() => supervisorGone),
      ]);
      if (next === supervisorGone) return null;
      const { value, done } = next;
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const status = parseChildSupervisorStatus(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (status && status.state !== "starting") return status;
        newline = buffered.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Whether `exit` settles within `ms`. */
function exitsWithin(exit: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([exit.then(() => true), elapsed]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Waits for a background mount to report that it is up.
 *
 * The supervisor and its FUSE child write readiness to `deps.readiness`, a pipe
 * this command holds the read end of, so the read wakes on the child's own
 * announcement rather than on a clock. The channel is private to this mount, so
 * a line arriving on it came from this child and needs no correlation against
 * the mount state.
 *
 * Returns only once the child has reported `mounted` and both the supervisor and
 * the child are alive. Every other outcome removes the mount state and throws.
 */
export async function awaitBackgroundMountStartup(
  pid: number,
  statePath: string,
  deps: {
    readiness: ReadableStream<Uint8Array>;
    supervisorExit: Promise<unknown>;
    isAlive?: (pid: number) => boolean;
    removeStateFile?: (path: string) => Promise<void>;
    childStatusPath?: string;
    confirmMs?: number;
  },
): Promise<void> {
  const isAliveFn = deps.isAlive ?? isAlive;
  const removeStateFileFn = deps.removeStateFile ?? removeMountStateFile;
  const confirmMs = deps.confirmMs ?? CHILD_CONFIRM_MS;
  const exitedDuringStartup =
    "Background FUSE process exited during startup. Re-run without --background to inspect startup errors.";
  const fail = async (message: string): Promise<never> => {
    await removeMountStateAndChildStatus(
      statePath,
      deps.childStatusPath,
      removeStateFileFn,
    );
    throw new Error(message);
  };

  const status = await readSettledChildStatus(
    deps.readiness,
    deps.supervisorExit,
  );

  if (!status) return await fail(exitedDuringStartup);
  if (status.state !== "mounted") {
    return await fail(
      `Background FUSE mount failed during startup: ${
        status.error ?? `child reported ${status.state}`
      }`,
    );
  }

  // The child reports `mounted` just before entering its FUSE session loop, so a
  // mount that fails in the loop reports mounted and then exits. At the instant
  // the report arrives the child is still running, and a pid probe says so; what
  // distinguishes the two is that a dying child takes the supervisor down with
  // it. Wait for that exit to either arrive or not. This is the one wait here
  // with a duration in it, because nothing announces that a process intends to
  // keep running.
  if (await exitsWithin(deps.supervisorExit, confirmMs)) {
    return await fail(
      "Background FUSE mount failed during startup: child exited after reporting mounted.",
    );
  }

  if (typeof status.pid !== "number" || !isAliveFn(status.pid)) {
    return await fail(
      "Background FUSE mount failed during startup: child exited after reporting mounted.",
    );
  }
  if (!isAliveFn(pid)) return await fail(exitedDuringStartup);
}

export const fuse = new Command()
  .name("fuse")
  .description(fuseDescription)
  .default("help")
  .globalEnv("CF_API_URL=<url:string>", "URL of the fabric instance.", {
    prefix: "CF_",
  })
  .globalOption("-a,--api-url <url:string>", "URL of the fabric instance.")
  .globalEnv("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  /* mount */
  .command(
    "mount <mountpoint:string>",
    "Mount a FUSE filesystem at the given directory.",
  )
  .option("--background", "Run in the background (detached).")
  .option("--debug", "Enable FUSE debug output.")
  .option(
    "--allow-other",
    "Linux only: export the mount to other users such as Docker daemon. Requires user_allow_other in /etc/fuse.conf.",
  )
  .option(
    "--noattrcache",
    "macOS/FUSE-T only: mount with FUSE-T's noattrcache option (the NFS nonegnamecache flag on current FUSE-T). Negative name lookups are never cached; positive attribute caching keeps the NFS client's 5-60 second defaults.",
    { conflicts: ["attrcache-timeout"] },
  )
  .option(
    "--attrcache-timeout <seconds:integer>",
    "macOS/FUSE-T only: bound every NFS client attribute-cache window to the given whole seconds (0-86400). FUSE-T mounts default to 1; 0 keeps the NFS client's age-based 5-60 second default caching.",
  )
  .option(
    "--cfc-mode <mode:string>",
    "Enable FUSE-side CFC mode: disabled, observe, enforce-explicit, or enforce-strict.",
  )
  .option(
    "--cfc-annotations",
    "Publish CFC annotation xattrs even when CFC mode is disabled.",
  )
  .option(
    "--cfc-xattr-namespace <namespace:string>",
    "CFC xattr namespace to expose: trusted, compat, or both.",
  )
  .option(
    "--cfc-writeback-xattrs",
    "Enable temporary CFC writeback prepare/finalize xattrs for integration testing.",
  )
  .option(
    "--cfc-writeback-state <path:string>",
    "Path for persisted CFC writeback recovery state.",
  )
  .option(
    "-s, --space <name:string>",
    "Space(s) to connect (repeatable, default: home).",
    { collect: true },
  )
  .example(
    cliText("cf fuse mount /tmp/cf-fuse"),
    "Mount with settings from CF_API_URL / CF_IDENTITY env vars.",
  )
  .example(
    cliText(
      `cf fuse mount /tmp/cf-fuse --api-url http://localhost:${ports.toolshed}`,
    ),
    "Mount with explicit API URL.",
  )
  .example(
    cliText("cf fuse mount /tmp/cf-fuse --background"),
    cliText("Mount in background; use 'cf fuse status' to check."),
  )
  .example(
    cliText("cf fuse mount /tmp/cf-fuse --allow-other"),
    cliText(
      "Linux only: export the mount to Docker or other users.",
    ),
  )
  .action(async (options, mountpoint) => {
    // globalEnv merges CF_API_URL / CF_IDENTITY into options automatically
    const apiUrl = options.apiUrl ?? "";
    const identity = options.identity ? resolve(options.identity) : "";
    const absMountpoint = resolve(mountpoint);

    // cliffy's integer type accepts any whole number; enforce the daemon's
    // range here so the error surfaces at the command line rather than in
    // the (possibly backgrounded) FUSE child.
    const attrcacheTimeout = options.attrcacheTimeout !== undefined
      ? String(options.attrcacheTimeout)
      : undefined;
    if (attrcacheTimeout !== undefined) {
      parseAttrcacheTimeoutSeconds(attrcacheTimeout);
    }

    if (identity) {
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(identity);
      } catch {
        throw new Error(`Identity file not found: ${identity}`);
      }
      if (!stat.isFile) {
        throw new Error(`Identity file not found: ${identity}`);
      }
    }

    // Ensure mountpoint exists
    try {
      await Deno.stat(absMountpoint);
    } catch {
      await Deno.mkdir(absMountpoint, { recursive: true });
    }

    const stateDir = defaultStateDir();
    const execCli = await ensureExecShim(stateDir, import.meta.url);
    const execPath = Deno.execPath();
    const execBase = basename(execPath);
    const isCompiledBinary = execBase !== "deno" && execBase !== "deno.exe";

    // The mount flags every spawn path forwards, whichever entrypoint runs.
    const mountFlags = {
      mountpoint: absMountpoint,
      apiUrl,
      identity,
      execCli,
      spaces: options.space ?? [],
      allowOther: options.allowOther,
      noattrcache: options.noattrcache,
      attrcacheTimeout,
      cfcMode: options.cfcMode,
      cfcAnnotations: options.cfcAnnotations,
      cfcXattrNamespace: options.cfcXattrNamespace,
      cfcWritebackXattrs: options.cfcWritebackXattrs,
      cfcWritebackState: options.cfcWritebackState,
    };

    let spawnCmd: string;
    let spawnArgs: string[];
    if (isCompiledBinary) {
      spawnCmd = execPath;
      spawnArgs = buildFuseBinaryArgs({
        subcommand: "fuse-daemon",
        ...mountFlags,
      });
    } else {
      spawnCmd = "deno";
      spawnArgs = buildDenoArgs({
        modPath: fuseMod(import.meta.url),
        ...mountFlags,
      });
    }

    if (options.background) {
      // Derive log file path: /tmp/cf-fuse-<mountname>.log
      const logFile = `/tmp/cf-fuse-${basename(absMountpoint)}.log`;

      // The supervisor writes the mount state, because it is the process that
      // spawns the FUSE child and so the only one that knows both PIDs. It holds
      // write access to that one file, so the directory is prepared here.
      const statePath = await prepareMountStatePath(stateDir, absMountpoint);
      const childStatusPath = childStatusPathForStatePath(statePath);
      try {
        await Deno.remove(childStatusPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }

      const supervisorFlags = {
        ...mountFlags,
        logFile,
        statePath,
        supervisorStatusPath: childStatusPath,
      };
      spawnCmd = execPath;
      spawnArgs = isCompiledBinary
        ? buildFuseBinaryArgs({
          subcommand: "fuse-supervisor",
          ...supervisorFlags,
        })
        : buildBackgroundSupervisorDenoArgs({
          cliModPath: fuseSupervisorMod(import.meta.url),
          ...supervisorFlags,
        });

      // Detached background process. Its stdout is a pipe the supervisor passes
      // down to the FUSE child, which writes its readiness into it.
      const cmd = new Deno.Command(spawnCmd, {
        args: spawnArgs,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      });
      const child = cmd.spawn();

      const pid = child.pid;
      try {
        await awaitBackgroundMountStartup(pid, statePath, {
          readiness: child.stdout,
          supervisorExit: child.status,
          childStatusPath,
        });
        // The mount is up and outlives this command, so stop holding the process
        // open for it. Unreferencing any earlier would also stop the readiness
        // read from holding it, and the command would exit mid-handshake.
        child.unref();
      } catch (error) {
        try {
          Deno.kill(pid, "SIGTERM");
        } catch {
          // Process may have already exited.
        }
        throw error;
      }

      console.log(`FUSE mounted in background (PID ${pid})`);
      console.log(`  mountpoint: ${absMountpoint}`);
      console.log(`  log:        ${logFile}`);
      console.log(
        cliText(
          `Use 'cf fuse status' to check, 'cf fuse unmount ${mountpoint}' to stop.`,
        ),
      );
    } else {
      // Foreground — inherit stdio, propagate exit code
      const logFile = `/tmp/cf-fuse-${basename(absMountpoint)}.log`;
      spawnArgs.push("--log-file", logFile);
      console.error(`FUSE log: ${logFile}`);

      const cmd = new Deno.Command(spawnCmd, {
        args: spawnArgs,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const child = cmd.spawn();
      let statePath: string;
      try {
        statePath = await writeMountState(stateDir, {
          pid: child.pid,
          mountpoint: absMountpoint,
          apiUrl,
          identity,
          startedAt: new Date().toISOString(),
          logFile,
        });
      } catch (error) {
        try {
          Deno.kill(child.pid, "SIGTERM");
        } catch {
          // Process may have already exited.
        }
        throw error;
      }

      await awaitForegroundMountExit(child, statePath);
    }
  })
  .reset()
  /* unmount */
  .command(
    "unmount <mountpoint:string>",
    "Unmount a FUSE filesystem.",
  )
  .action(async (_options, mountpoint) => {
    const absMountpoint = resolve(mountpoint);
    const stateDir = defaultStateDir();
    const pidFile = await readMountState(stateDir, absMountpoint);

    const targetPid = pidFile && isAlive(pidFile.entry.pid)
      ? pidFile.entry.pid
      : pidFile?.entry.childPid;

    if (pidFile && targetPid !== undefined && isAlive(targetPid)) {
      // Verify the PID belongs to a deno/fuse process before killing
      let verified = false;
      try {
        const ps = new Deno.Command("ps", {
          args: ["-p", String(targetPid), "-o", "command="],
          stdout: "piped",
        });
        const out = await ps.output();
        const cmd = new TextDecoder().decode(out.stdout).trim();
        verified = isFuseProcessCommand(cmd);
      } catch {
        // ps failed — proceed cautiously (skip kill)
      }

      if (verified) {
        console.log(`Sending SIGTERM to PID ${targetPid}...`);
        try {
          Deno.kill(targetPid, "SIGTERM");
          // Wait briefly for the supervisor to terminate after child cleanup.
          for (let i = 0; i < 20 && isAlive(targetPid); i++) {
            await new Promise((r) => setTimeout(r, 100));
          }
        } catch {
          // Process may have already exited
        }
      } else if (isAlive(targetPid)) {
        console.log(
          `PID ${targetPid} does not appear to be a FUSE process; skipping kill.`,
        );
      }
    }

    // Fallback: try system unmount
    if (pidFile && isMountStateAlive(pidFile.entry)) {
      console.log("Process still alive, trying system unmount...");
      const unmountCmd = Deno.build.os === "darwin"
        ? new Deno.Command("umount", { args: [absMountpoint] })
        : new Deno.Command("fusermount3", { args: ["-u", absMountpoint] });
      try {
        await unmountCmd.output();
      } catch {
        console.error(`Failed to unmount ${absMountpoint}`);
        Deno.exit(1);
      }
    }

    // Clean up PID file
    if (pidFile && !isMountStateAlive(pidFile.entry)) {
      await removeMountStateFile(pidFile.path);
    }

    console.log(`Unmounted ${absMountpoint}`);
  })
  .reset()
  /* status */
  .command("status", "Show active FUSE mounts.")
  .action(async () => {
    const stateDir = defaultStateDir();
    const entries = await readAllMountStates(stateDir);

    console.log(formatMountStatusTable(await buildMountStatusRows(entries)));
  });

export async function buildMountStatusRows(
  entries: Array<{ entry: MountStateEntry; path: string }>,
  deps: {
    isMountStateAlive?: (entry: MountStateEntry) => boolean;
    removeMountStateFile?: (path: string) => Promise<void>;
    readChildMountStatus?: (entry: MountStateEntry) => Promise<string>;
  } = {},
): Promise<string[][]> {
  const isMountStateAliveFn = deps.isMountStateAlive ?? isMountStateAlive;
  const removeMountStateFileFn = deps.removeMountStateFile ??
    removeMountStateFile;
  const readChildMountStatusFn = deps.readChildMountStatus ??
    readChildMountStatus;
  const rows: string[][] = [];

  for (const { entry, path } of entries) {
    if (!isMountStateAliveFn(entry)) {
      await removeMountStateFileFn(path);
      continue;
    }
    rows.push([
      entry.mountpoint,
      String(entry.pid),
      entry.childPid === undefined ? "-" : String(entry.childPid),
      entry.childStatusPath ? await readChildMountStatusFn(entry) : "running",
      entry.startedAt,
      entry.logFile ?? "-",
    ]);
  }

  return rows;
}

export function formatMountStatusTable(rows: string[][]): string {
  if (rows.length === 0) return "No active FUSE mounts.";
  return [mountStatusHeader, ...rows.map((row) => row.join("\t"))].join("\n");
}

async function readChildMountStatus(entry: { childStatusPath?: string }) {
  if (!entry.childStatusPath) return "running";
  try {
    const status = parseChildSupervisorStatus(
      await Deno.readTextFile(entry.childStatusPath),
    );
    return status?.state ?? "unknown";
  } catch {
    return "unknown";
  }
}
