import { encodeHex } from "@std/encoding/hex";
import {
  basename,
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  resolve,
  SEPARATOR,
} from "@std/path";

export interface MountStateEntry {
  pid: number;
  mountpoint: string;
  apiUrl: string;
  identity: string;
  startedAt: string;
}

export async function canonicalizeMountLookupPath(
  path: string,
): Promise<string> {
  const resolved = resolve(path);
  const suffix: string[] = [];
  let probe = resolved;

  while (true) {
    try {
      const real = await Deno.realPath(probe);
      return suffix.length === 0 ? real : join(real, ...suffix.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(basename(probe));
      probe = parent;
    }
  }
}

function normalizeMountStateEntry(entry: MountStateEntry): MountStateEntry {
  return {
    ...entry,
    mountpoint: resolve(entry.mountpoint),
    identity: entry.identity
      ? (isAbsolute(entry.identity) ? entry.identity : resolve(entry.identity))
      : "",
  };
}

function isWithinMountpoint(path: string, mountpoint: string): boolean {
  return path === mountpoint || path.startsWith(`${mountpoint}${SEPARATOR}`);
}

function cliMod(importMetaUrl: string): string {
  const cliLibDir = dirname(fromFileUrl(importMetaUrl));
  return resolve(cliLibDir, "../mod.ts");
}

function repoRoot(importMetaUrl: string): string {
  const cliLibDir = dirname(fromFileUrl(importMetaUrl));
  return resolve(cliLibDir, "../../..");
}

async function hashMountLookupKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hash)).slice(0, 16);
}

async function legacyMountpointHash(mountpoint: string): Promise<string> {
  return await hashMountLookupKey(resolve(mountpoint));
}

/** Hex hash of absolute mountpoint path, used as state filename. */
export async function mountpointHash(mountpoint: string): Promise<string> {
  return await hashMountLookupKey(
    await canonicalizeMountLookupPath(mountpoint),
  );
}

export async function writeMountState(
  stateDir: string,
  entry: MountStateEntry,
): Promise<string> {
  await Deno.mkdir(stateDir, { recursive: true });
  const normalized = normalizeMountStateEntry(entry);
  const hash = await mountpointHash(normalized.mountpoint);
  const path = resolve(stateDir, `${hash}.json`);
  await Deno.writeTextFile(path, JSON.stringify(normalized, null, 2));
  const legacyHash = await legacyMountpointHash(normalized.mountpoint);
  if (legacyHash !== hash) {
    await Deno.remove(resolve(stateDir, `${legacyHash}.json`)).catch(() =>
      undefined
    );
  }
  return path;
}

export async function readMountState(
  stateDir: string,
  mountpoint: string,
): Promise<{ entry: MountStateEntry; path: string } | null> {
  const candidatePaths = [
    resolve(stateDir, `${await mountpointHash(mountpoint)}.json`),
  ];
  const legacyPath = resolve(
    stateDir,
    `${await legacyMountpointHash(mountpoint)}.json`,
  );
  if (!candidatePaths.includes(legacyPath)) {
    candidatePaths.push(legacyPath);
  }

  const matches: { entry: MountStateEntry; path: string }[] = [];
  for (const path of candidatePaths) {
    try {
      const text = await Deno.readTextFile(path);
      matches.push({
        entry: normalizeMountStateEntry(JSON.parse(text) as MountStateEntry),
        path,
      });
    } catch {
      // Try the next compatible state filename.
    }
  }

  return matches.find(({ entry }) => isAlive(entry.pid)) ?? matches[0] ?? null;
}

export async function readAllMountStates(
  stateDir: string,
): Promise<{ entry: MountStateEntry; path: string }[]> {
  const results: { entry: MountStateEntry; path: string }[] = [];
  try {
    for await (const file of Deno.readDir(stateDir)) {
      if (!file.isFile || !file.name.endsWith(".json")) continue;
      const path = resolve(stateDir, file.name);
      try {
        const text = await Deno.readTextFile(path);
        results.push({
          entry: normalizeMountStateEntry(JSON.parse(text) as MountStateEntry),
          path,
        });
      } catch {
        // Skip corrupt entries.
      }
    }
  } catch {
    // State dir does not exist yet.
  }
  return results;
}

export async function findMountForPath(
  absPath: string,
  stateDir = defaultStateDir(),
): Promise<{ entry: MountStateEntry; path: string } | null> {
  const normalizedPath = await canonicalizeMountLookupPath(absPath);
  const entries = await readAllMountStates(stateDir);

  let bestMatch: { entry: MountStateEntry; path: string } | null = null;
  let bestMatchMountpoint: string | null = null;
  for (const candidate of entries) {
    if (!isAlive(candidate.entry.pid)) {
      try {
        await Deno.remove(candidate.path);
      } catch {
        // Ignore cleanup failures.
      }
      continue;
    }

    const candidateMountpoint = await canonicalizeMountLookupPath(
      candidate.entry.mountpoint,
    );
    if (!isWithinMountpoint(normalizedPath, candidateMountpoint)) {
      continue;
    }

    if (
      !bestMatch ||
      candidateMountpoint.length > (bestMatchMountpoint?.length ?? -1)
    ) {
      bestMatch = candidate;
      bestMatchMountpoint = candidateMountpoint;
    }
  }

  return bestMatch;
}

export function removeMountStateFile(path: string): Promise<void> {
  return Deno.remove(path).catch(() => undefined);
}

export function isAlive(pid: number): boolean {
  try {
    // SIGURG is benign (no default handler) — unlike SIGCONT which resumes
    // stopped processes. We just need to check if the process exists.
    Deno.kill(pid, "SIGURG");
    return true;
  } catch {
    return false;
  }
}

/** Default state directory for FUSE mount state. */
export function defaultStateDir(): string {
  return resolve(Deno.env.get("HOME") ?? "/tmp", ".ct", "fuse");
}

/** Resolve path to packages/fuse/mod.ts relative to the CLI commands dir. */
export function fuseMod(importMetaUrl: string): string {
  const cliCommandsDir = dirname(fromFileUrl(importMetaUrl));
  return resolve(cliCommandsDir, "../../fuse/mod.ts");
}

export async function ensureExecShim(
  stateDir = defaultStateDir(),
  importMetaUrl = import.meta.url,
): Promise<string> {
  const shimPath = join(repoRoot(importMetaUrl), ".ct", "fuse", "ct-exec");
  const denoPath = Deno.execPath();
  const modPath = cliMod(importMetaUrl);
  const script = `#!/usr/bin/env bash
export CT_EXEC_SHEBANG=1
exec "${denoPath}" run --allow-net --allow-ffi --allow-read --allow-write --allow-env --allow-run "${modPath}" "$@"
`;

  await Deno.mkdir(stateDir, { recursive: true });
  await Deno.mkdir(dirname(shimPath), { recursive: true });
  await Deno.writeTextFile(shimPath, script);
  await Deno.chmod(shimPath, 0o755);
  return shimPath;
}

/** Build the deno subprocess args for running the FUSE module. */
export function buildDenoArgs(opts: {
  modPath: string;
  mountpoint: string;
  apiUrl: string;
  identity: string;
  execCli: string;
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
  if (opts.execCli) args.push("--exec-cli", opts.execCli);

  return args;
}
