import { Command } from "@cliffy/command";
import { resolve } from "@std/path";
import {
  buildDenoArgs,
  defaultStateDir,
  fuseMod,
  isAlive,
  readAllPidFiles,
  readPidFile,
  writePidFile,
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
          result/*.handler      # write-only files for stream cells
          result.json           # full JSON blob
          input/
          input.json
          meta.json             # piece ID, entity, pattern name
        .index.json             # name-to-entity-ID mapping
      entities/                 # entity-hash symlinks -> ../pieces/<name>
      space.json                # { did, name }
    .spaces.json                # known space-name -> DID mapping

READING:
  ls <space>/pieces/                     # list pieces
  cat <piece>/result.json                # full cell value as JSON
  cat <piece>/result/title               # single scalar field
  cat <piece>/result/items/0/name        # nested access

WRITING:
  echo '"new title"' > result/title      # write scalar (auto-detects type)
  echo '{"a":1}' > result.json           # replace entire cell
  echo '{"msg":"hi"}' > result/chat.handler  # invoke a stream handler
  touch result/newkey                    # create key (empty string)
  rm result/oldkey                       # delete key
  ln -s ../../other-piece/input/foo result/ref  # sigil link

Requires FUSE-T (preferred) or macFUSE on macOS.`;

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
    "ct fuse mount /tmp/ct-fuse --api-url http://localhost:8000",
    "Mount with explicit API URL.",
  )
  .example(
    "ct fuse mount /tmp/ct-fuse --background",
    "Mount in background; use 'ct fuse status' to check.",
  )
  .action(async (options, mountpoint) => {
    // globalEnv merges CT_API_URL / CT_IDENTITY into options automatically
    const apiUrl = options.apiUrl ?? "";
    const identity = options.identity ?? "";
    const absMountpoint = resolve(mountpoint);

    // Ensure mountpoint exists
    try {
      await Deno.stat(absMountpoint);
    } catch {
      await Deno.mkdir(absMountpoint, { recursive: true });
    }

    const modPath = fuseMod(import.meta.url);
    const denoArgs = buildDenoArgs({
      modPath,
      mountpoint: absMountpoint,
      apiUrl,
      identity,
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
      const stateDir = defaultStateDir();
      await writePidFile(stateDir, {
        pid,
        mountpoint: absMountpoint,
        apiUrl,
        startedAt: new Date().toISOString(),
      });

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

      const status = await child.status;
      Deno.exit(status.code);
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
    const pidFile = await readPidFile(stateDir, absMountpoint);

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
        : new Deno.Command("fusermount", { args: ["-u", absMountpoint] });
      try {
        await unmountCmd.output();
      } catch {
        console.error(`Failed to unmount ${absMountpoint}`);
        Deno.exit(1);
      }
    }

    // Clean up PID file
    if (pidFile) {
      try {
        await Deno.remove(pidFile.path);
      } catch {
        // already gone
      }
    }

    console.log(`Unmounted ${absMountpoint}`);
  })
  .reset()
  /* status */
  .command("status", "Show active FUSE mounts.")
  .action(async () => {
    const stateDir = defaultStateDir();
    const entries = await readAllPidFiles(stateDir);

    if (entries.length === 0) {
      console.log("No active FUSE mounts.");
      return;
    }

    const rows: string[][] = [];

    for (const { entry, path } of entries) {
      const alive = isAlive(entry.pid);
      if (!alive) {
        // Clean stale entry
        try {
          await Deno.remove(path);
        } catch {
          // ignore
        }
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
