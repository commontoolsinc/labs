import { resolve } from "@std/path";
import { encodeHex } from "@std/encoding/hex";

export interface PidEntry {
  pid: number;
  mountpoint: string;
  apiUrl: string;
  startedAt: string;
}

/** Hex hash of absolute mountpoint path, used as PID filename. */
export async function mountpointHash(mountpoint: string): Promise<string> {
  const data = new TextEncoder().encode(resolve(mountpoint));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hash)).slice(0, 16);
}

export async function writePidFile(
  stateDir: string,
  entry: PidEntry,
): Promise<string> {
  await Deno.mkdir(stateDir, { recursive: true });
  const hash = await mountpointHash(entry.mountpoint);
  const path = resolve(stateDir, `${hash}.json`);
  await Deno.writeTextFile(path, JSON.stringify(entry, null, 2));
  return path;
}

export async function readPidFile(
  stateDir: string,
  mountpoint: string,
): Promise<{ entry: PidEntry; path: string } | null> {
  const hash = await mountpointHash(mountpoint);
  const path = resolve(stateDir, `${hash}.json`);
  try {
    const text = await Deno.readTextFile(path);
    return { entry: JSON.parse(text), path };
  } catch {
    return null;
  }
}

export async function readAllPidFiles(
  stateDir: string,
): Promise<{ entry: PidEntry; path: string }[]> {
  const results: { entry: PidEntry; path: string }[] = [];
  try {
    for await (const f of Deno.readDir(stateDir)) {
      if (!f.isFile || !f.name.endsWith(".json")) continue;
      const path = resolve(stateDir, f.name);
      try {
        const text = await Deno.readTextFile(path);
        results.push({ entry: JSON.parse(text), path });
      } catch {
        // skip corrupt entries
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return results;
}

export function isAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

/** Default state directory for FUSE PID files. */
export function defaultStateDir(): string {
  return resolve(Deno.env.get("HOME") ?? "/tmp", ".ct", "fuse");
}

/** Resolve path to packages/fuse/mod.ts relative to the CLI commands dir. */
export function fuseMod(importMetaUrl: string): string {
  const cliDir = new URL(".", importMetaUrl).pathname;
  return resolve(cliDir, "../../fuse/mod.ts");
}

/** Build the deno subprocess args for running the FUSE module. */
export function buildDenoArgs(opts: {
  modPath: string;
  mountpoint: string;
  apiUrl: string;
  identity: string;
}): string[] {
  const args = [
    "run",
    "--unstable-ffi",
    "--allow-ffi",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-net",
    opts.modPath,
    opts.mountpoint,
  ];

  if (opts.apiUrl) args.push("--api-url", opts.apiUrl);
  if (opts.identity) args.push("--identity", opts.identity);

  return args;
}
