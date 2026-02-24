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

export const fuse = new Command()
  .name("fuse")
  .description("Mount Common Tools spaces as a FUSE filesystem.")
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
  .option("-s,--space <space:string>", "Space(s) to connect.", {
    collect: true,
  })
  .option("--background", "Run in the background (detached).")
  .option("--debug", "Enable FUSE debug output.")
  .example(
    "ct fuse mount /tmp/ct-fuse",
    "Mount with settings from CT_API_URL / CT_IDENTITY env vars.",
  )
  .example(
    "ct fuse mount /tmp/ct-fuse --api-url http://localhost:8000 --space home",
    "Mount a specific space.",
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
      spaces: (options.space as string[] | undefined) ?? [],
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
      console.log(`Sending SIGTERM to PID ${pidFile.entry.pid}...`);
      try {
        Deno.kill(pidFile.entry.pid, "SIGTERM");
        // Wait briefly for graceful shutdown
        await new Promise((r) => setTimeout(r, 1000));
      } catch {
        // Process may have already exited
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
