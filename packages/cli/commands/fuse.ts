import { Command } from "@cliffy/command";
import { resolve } from "@std/path";
import ports from "@commontools/ports" with { type: "json" };
import {
  buildDenoArgs,
  defaultStateDir,
  ensureExecShim,
  fuseMod,
  isAlive,
  readAllMountStates,
  readMountState,
  removeMountStateFile,
  writeMountState,
} from "../lib/fuse.ts";

const fuseDescription = `Mount Common Tools spaces as a FUSE filesystem.

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
          meta.json             # piece ID, entity, pattern name
        .index.json             # name-to-entity-ID mapping
      entities/                 # access cells by entity ID
      space.json                # { did, name }
    .spaces.json                # known space-name -> DID mapping

  READING:
  ls <space>/pieces/                     # list pieces
  cat <piece>/result.json                # full cell value as JSON
  cat <piece>/result/title               # single scalar field
  cat <piece>/result/items/0/name        # nested access
  head -n1 <piece>/result/search.tool    # callable shebang for ct exec

  WRITING:
  echo '"new title"' > result/title      # write scalar (auto-detects type)
  echo '{"a":1}' > result.json           # replace entire cell
  echo '{"msg":"hi"}' > result/chat.handler  # invoke a stream handler
  touch result/newkey                    # create key (empty string)
  rm result/oldkey                       # delete key
  ln -s ../../other-piece/input/foo result/ref  # sigil link

Requires FUSE-T (preferred) or macFUSE on macOS.`;

export async function awaitForegroundMountExit(
  child: { status: Promise<Deno.CommandStatus> },
  statePath: string,
  exit: (code: number) => never | void = Deno.exit,
): Promise<void> {
  const status = await child.status;
  await removeMountStateFile(statePath);
  exit(status.code);
}

export async function awaitBackgroundMountStartup(
  pid: number,
  statePath: string,
  deps: {
    attempts?: number;
    delayMs?: number;
    isAlive?: (pid: number) => boolean;
    removeStateFile?: (path: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const attempts = deps.attempts ?? 20;
  const delayMs = deps.delayMs ?? 50;
  const isAliveFn = deps.isAlive ?? isAlive;
  const removeStateFileFn = deps.removeStateFile ?? removeMountStateFile;
  const sleep = deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i < attempts; i++) {
    if (!isAliveFn(pid)) {
      await removeStateFileFn(statePath);
      throw new Error(
        "Background FUSE process exited during startup. Re-run without --background to inspect startup errors.",
      );
    }
    if (i < attempts - 1) {
      await sleep(delayMs);
    }
  }
}

export const fuse = new Command()
  .name("fuse")
  .description(fuseDescription)
  .default("help")
  .globalEnv("CT_API_URL=<url:string>", "URL of the fabric instance.", {
    prefix: "CT_",
  })
  .globalOption("-a,--api-url <url:string>", "URL of the fabric instance.")
  .globalEnv("CT_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CT_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  /* mount */
  .command(
    "mount <mountpoint:string>",
    "Mount a FUSE filesystem at the given directory.",
  )
  .option("--background", "Run in the background (detached).")
  .option("--debug", "Enable FUSE debug output.")
  .example(
    "ct fuse mount /tmp/ct-fuse",
    "Mount with settings from CT_API_URL / CT_IDENTITY env vars.",
  )
  .example(
    `ct fuse mount /tmp/ct-fuse --api-url http://localhost:${ports.toolshed}`,
    "Mount with explicit API URL.",
  )
  .example(
    "ct fuse mount /tmp/ct-fuse --background",
    "Mount in background; use 'ct fuse status' to check.",
  )
  .action(async (options, mountpoint) => {
    // globalEnv merges CT_API_URL / CT_IDENTITY into options automatically
    const apiUrl = options.apiUrl ?? "";
    const identity = options.identity ? resolve(options.identity) : "";
    const absMountpoint = resolve(mountpoint);

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

    const modPath = fuseMod(import.meta.url);
    const stateDir = defaultStateDir();
    const execCli = await ensureExecShim(stateDir, import.meta.url);
    const denoArgs = buildDenoArgs({
      modPath,
      mountpoint: absMountpoint,
      apiUrl,
      identity,
      execCli,
    });

    if (options.background) {
      // Detached background process
      const cmd = new Deno.Command("deno", {
        args: denoArgs,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      });
      const child = cmd.spawn();
      child.unref();

      const pid = child.pid;
      let statePath: string;
      try {
        statePath = await writeMountState(stateDir, {
          pid,
          mountpoint: absMountpoint,
          apiUrl,
          identity,
          startedAt: new Date().toISOString(),
        });
        await awaitBackgroundMountStartup(pid, statePath);
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
      console.log(
        `Use 'ct fuse status' to check, 'ct fuse unmount ${mountpoint}' to stop.`,
      );
    } else {
      // Foreground — inherit stdio, propagate exit code
      const cmd = new Deno.Command("deno", {
        args: denoArgs,
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

    if (pidFile && isAlive(pidFile.entry.pid)) {
      // Verify the PID belongs to a deno/fuse process before killing
      let verified = false;
      try {
        const ps = new Deno.Command("ps", {
          args: ["-p", String(pidFile.entry.pid), "-o", "command="],
          stdout: "piped",
        });
        const out = await ps.output();
        const cmd = new TextDecoder().decode(out.stdout).trim();
        verified = cmd.includes("deno") && cmd.includes("fuse");
      } catch {
        // ps failed — proceed cautiously (skip kill)
      }

      if (verified) {
        console.log(`Sending SIGTERM to PID ${pidFile.entry.pid}...`);
        try {
          Deno.kill(pidFile.entry.pid, "SIGTERM");
          // Wait briefly for graceful shutdown
          await new Promise((r) => setTimeout(r, 1000));
        } catch {
          // Process may have already exited
        }
      } else if (isAlive(pidFile.entry.pid)) {
        console.log(
          `PID ${pidFile.entry.pid} does not appear to be a FUSE process; skipping kill.`,
        );
      }
    }

    // Fallback: try system unmount
    if (pidFile && isAlive(pidFile.entry.pid)) {
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
    if (pidFile) {
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

    if (entries.length === 0) {
      console.log("No active FUSE mounts.");
      return;
    }

    const rows: string[][] = [];

    for (const { entry, path } of entries) {
      const alive = isAlive(entry.pid);
      if (!alive) {
        // Clean stale entry
        await removeMountStateFile(path);
        continue;
      }
      rows.push([
        entry.mountpoint,
        String(entry.pid),
        "running",
        entry.startedAt,
      ]);
    }

    if (rows.length === 0) {
      console.log("No active FUSE mounts.");
      return;
    }

    console.log("MOUNTPOINT\tPID\tSTATUS\tSTARTED");
    for (const row of rows) {
      console.log(row.join("\t"));
    }
  });
