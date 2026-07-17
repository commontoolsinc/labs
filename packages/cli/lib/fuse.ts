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
import { cliName } from "./cli-name.ts";

export interface MountStateEntry {
  pid: number;
  childPid?: number;
  childStatusPath?: string;
  mountpoint: string;
  apiUrl: string;
  identity: string;
  startedAt: string;
  logFile?: string;
}

export interface FuseChildDenoArgsOptions {
  modPath: string;
  mountpoint: string;
  apiUrl: string;
  identity: string;
  execCli: string;
  logFile?: string;
  spaces?: string[];
  allowOther?: boolean;
  noattrcache?: boolean;
  attrcacheTimeout?: string;
  cfcMode?: string;
  cfcAnnotations?: boolean;
  cfcXattrNamespace?: string;
  cfcWritebackXattrs?: boolean;
  cfcWritebackState?: string;
  dangerouslyAllowIncompatibleSchema?: boolean;
  supervisorStatusPath?: string;
  supervisorToken?: string;
}

export interface BackgroundSupervisorDenoArgsOptions
  extends Omit<FuseChildDenoArgsOptions, "modPath"> {
  cliModPath: string;
  statePath?: string;
}

export interface FuseBinaryArgsOptions
  extends Omit<FuseChildDenoArgsOptions, "modPath"> {
  subcommand: "fuse-daemon" | "fuse-supervisor";
  statePath?: string;
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

function isMountStateEntry(value: unknown): value is MountStateEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.pid === "number" &&
    typeof entry.mountpoint === "string" &&
    typeof entry.apiUrl === "string" &&
    typeof entry.identity === "string" &&
    typeof entry.startedAt === "string" &&
    (entry.childPid === undefined || typeof entry.childPid === "number") &&
    (entry.childStatusPath === undefined ||
      typeof entry.childStatusPath === "string") &&
    (entry.logFile === undefined || typeof entry.logFile === "string");
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

function isFsWriteError(error: unknown): boolean {
  return error instanceof Deno.errors.PermissionDenied ||
    error instanceof Deno.errors.NotSupported;
}

function isCompiledBinary(): boolean {
  const exec = Deno.execPath();
  const base = basename(exec);
  return base !== "deno" && base !== "deno.exe";
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
      const parsed = JSON.parse(text) as unknown;
      if (!isMountStateEntry(parsed)) continue;
      matches.push({
        entry: normalizeMountStateEntry(parsed),
        path,
      });
    } catch {
      // Try the next compatible state filename.
    }
  }

  return matches.find(({ entry }) => isMountStateAlive(entry)) ?? matches[0] ??
    null;
}

export async function readAllMountStates(
  stateDir: string,
): Promise<{ entry: MountStateEntry; path: string }[]> {
  const results: { entry: MountStateEntry; path: string }[] = [];
  try {
    for await (const file of Deno.readDir(stateDir)) {
      if (
        !file.isFile || !file.name.endsWith(".json") ||
        file.name.endsWith(".child-status.json")
      ) continue;
      const path = resolve(stateDir, file.name);
      try {
        const text = await Deno.readTextFile(path);
        const parsed = JSON.parse(text) as unknown;
        if (!isMountStateEntry(parsed)) continue;
        results.push({
          entry: normalizeMountStateEntry(parsed),
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
    if (!isMountStateAlive(candidate.entry)) {
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

export function isMountStateAlive(entry: MountStateEntry): boolean {
  return isAlive(entry.pid) ||
    (entry.childPid !== undefined && isAlive(entry.childPid));
}

/** Default state directory for FUSE mount state. */
export function defaultStateDir(): string {
  return resolve(Deno.env.get("HOME") ?? "/tmp", ".cf", "fuse");
}

/** Resolve path to packages/fuse/mod.ts relative to the CLI commands dir. */
export function fuseMod(importMetaUrl: string): string {
  const cliCommandsDir = dirname(fromFileUrl(importMetaUrl));
  return resolve(cliCommandsDir, "../../fuse/mod.ts");
}

/** Resolve path to the minimal FUSE supervisor entrypoint. */
export function fuseSupervisorMod(importMetaUrl: string): string {
  const cliCommandsDir = dirname(fromFileUrl(importMetaUrl));
  return resolve(cliCommandsDir, "../lib/fuse-supervisor.ts");
}

export async function ensureExecShim(
  stateDir = defaultStateDir(),
  importMetaUrl = import.meta.url,
): Promise<string> {
  await Deno.mkdir(stateDir, { recursive: true });

  const compiled = isCompiledBinary();
  const displayCliName = cliName();
  const stateScopedShimPath = join(
    stateDir,
    `cf-exec-${await hashMountLookupKey(
      compiled ? Deno.execPath() : cliMod(importMetaUrl),
    )}`,
  );
  const preferredShimPath = compiled
    ? stateScopedShimPath
    : join(repoRoot(importMetaUrl), ".cf", "fuse", "cf-exec");
  const fallbackShimPath = stateScopedShimPath;

  const script = compiled
    ? `#!/usr/bin/env bash
export CF_EXEC_SHEBANG=1
export CF_CLI_NAME=${displayCliName}
exec "${Deno.execPath()}" "$@"
`
    : `#!/usr/bin/env bash
export CF_EXEC_SHEBANG=1
export CF_CLI_NAME=${displayCliName}
exec "${Deno.execPath()}" run --allow-net --allow-ffi --allow-read --allow-write --allow-env --allow-run "${
      cliMod(importMetaUrl)
    }" "$@"
`;

  const writeShim = async (shimPath: string): Promise<void> => {
    await Deno.mkdir(dirname(shimPath), { recursive: true });
    await Deno.writeTextFile(shimPath, script);
    await Deno.chmod(shimPath, 0o755);
  };

  try {
    await writeShim(preferredShimPath);
    return preferredShimPath;
  } catch (error) {
    if (!isFsWriteError(error) || compiled) {
      throw error;
    }
    await writeShim(fallbackShimPath);
    return fallbackShimPath;
  }
}

/** Build the deno subprocess args for running the FUSE module. */
export function buildFuseChildDenoArgs(
  opts: FuseChildDenoArgsOptions,
): string[] {
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
  if (opts.logFile) args.push("--log-file", opts.logFile);
  if (opts.allowOther) args.push("--allow-other");
  if (opts.noattrcache) args.push("--noattrcache");
  if (opts.attrcacheTimeout) {
    args.push("--attrcache-timeout", opts.attrcacheTimeout);
  }
  if (opts.cfcMode) args.push("--cfc-mode", opts.cfcMode);
  if (opts.cfcAnnotations) args.push("--cfc-annotations");
  if (opts.cfcXattrNamespace) {
    args.push("--cfc-xattr-namespace", opts.cfcXattrNamespace);
  }
  if (opts.cfcWritebackXattrs) args.push("--cfc-writeback-xattrs");
  if (opts.cfcWritebackState) {
    args.push("--cfc-writeback-state", opts.cfcWritebackState);
  }
  if (opts.dangerouslyAllowIncompatibleSchema) {
    args.push("--dangerously-allow-incompatible-schema");
  }
  if (opts.supervisorStatusPath) {
    args.push("--supervisor-status", opts.supervisorStatusPath);
  }
  if (opts.supervisorToken) {
    args.push("--supervisor-token", opts.supervisorToken);
  }
  for (const space of opts.spaces ?? []) args.push("--space", space);

  return args;
}

/**
 * Build the args for the compiled cf binary's hidden fuse subcommands. The
 * compiled binary takes the mountpoint and mount flags directly, where a
 * deno invocation needs a script path and permission flags first.
 */
export function buildFuseBinaryArgs(opts: FuseBinaryArgsOptions): string[] {
  const args = [opts.subcommand, opts.mountpoint];

  if (opts.apiUrl) args.push("--api-url", opts.apiUrl);
  if (opts.identity) args.push("--identity", opts.identity);
  if (opts.allowOther) args.push("--allow-other");
  if (opts.noattrcache) args.push("--noattrcache");
  if (opts.attrcacheTimeout) {
    args.push("--attrcache-timeout", opts.attrcacheTimeout);
  }
  if (opts.cfcMode) args.push("--cfc-mode", opts.cfcMode);
  if (opts.cfcAnnotations) args.push("--cfc-annotations");
  if (opts.cfcXattrNamespace) {
    args.push("--cfc-xattr-namespace", opts.cfcXattrNamespace);
  }
  if (opts.cfcWritebackXattrs) args.push("--cfc-writeback-xattrs");
  if (opts.cfcWritebackState) {
    args.push("--cfc-writeback-state", opts.cfcWritebackState);
  }
  if (opts.dangerouslyAllowIncompatibleSchema) {
    args.push("--dangerously-allow-incompatible-schema");
  }
  if (opts.execCli) args.push("--exec-cli", opts.execCli);
  if (opts.logFile) args.push("--log-file", opts.logFile);
  if (opts.statePath) args.push("--state-path", opts.statePath);
  if (opts.supervisorStatusPath) {
    args.push("--supervisor-status", opts.supervisorStatusPath);
  }
  if (opts.supervisorToken) {
    args.push("--supervisor-token", opts.supervisorToken);
  }
  for (const space of opts.spaces ?? []) args.push("--space", space);

  return args;
}

/** Build the deno subprocess args for running the non-FFI FUSE supervisor. */
export function buildBackgroundSupervisorDenoArgs(
  opts: BackgroundSupervisorDenoArgsOptions,
): string[] {
  const args = [
    "run",
    "--allow-run",
    opts.cliModPath,
    opts.mountpoint,
  ];

  if (opts.statePath) {
    args.splice(2, 0, `--allow-read=${opts.statePath}`);
    args.splice(3, 0, `--allow-write=${opts.statePath}`);
    args.push("--state-path", opts.statePath);
  }

  if (opts.apiUrl) args.push("--api-url", opts.apiUrl);
  if (opts.identity) args.push("--identity", opts.identity);
  if (opts.execCli) args.push("--exec-cli", opts.execCli);
  if (opts.logFile) args.push("--log-file", opts.logFile);
  if (opts.allowOther) args.push("--allow-other");
  if (opts.noattrcache) args.push("--noattrcache");
  if (opts.attrcacheTimeout) {
    args.push("--attrcache-timeout", opts.attrcacheTimeout);
  }
  if (opts.cfcMode) args.push("--cfc-mode", opts.cfcMode);
  if (opts.cfcAnnotations) args.push("--cfc-annotations");
  if (opts.cfcXattrNamespace) {
    args.push("--cfc-xattr-namespace", opts.cfcXattrNamespace);
  }
  if (opts.cfcWritebackXattrs) args.push("--cfc-writeback-xattrs");
  if (opts.cfcWritebackState) {
    args.push("--cfc-writeback-state", opts.cfcWritebackState);
  }
  if (opts.dangerouslyAllowIncompatibleSchema) {
    args.push("--dangerously-allow-incompatible-schema");
  }
  if (opts.supervisorStatusPath) {
    args.push("--supervisor-status", opts.supervisorStatusPath);
  }
  if (opts.supervisorToken) {
    args.push("--supervisor-token", opts.supervisorToken);
  }
  for (const space of opts.spaces ?? []) args.push("--space", space);

  return args;
}

export function buildDenoArgs(opts: FuseChildDenoArgsOptions): string[] {
  return buildFuseChildDenoArgs(opts);
}
