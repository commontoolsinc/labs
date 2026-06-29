// Local space-DB discovery — so callers never have to hand-feed absolute
// sqlite paths. Finds memory v2 space DBs from env overrides and from the known
// on-disk cache layouts, walking up from the working directory.
//
// On-disk layout (verified): `<root>/{packages/toolshed/,}cache/memory/engine-v3/
// engine-v3/<did>.sqlite`. The engine-v3 segment is sometimes doubled, so we
// walk a bounded depth under each cache base rather than assume a fixed path.

import { Identity } from "@commonfabric/identity";

import { openSpace } from "./db.ts";

// A named space's DID is reproducibly derived by the runtime from its name:
// `Identity.fromPassphrase("common user").derive(<name>)` (see
// `packages/identity/src/session.ts` `createSession`). The shell addresses a
// space by name (`/<space-name>/…`); we mirror that derivation so
// `cf inspect <name>` resolves the same DB the runtime would, without anyone
// copying a DID around.
const SPACE_ROOT_PASSPHRASE = "common user";
let spaceRoot: Promise<Identity> | undefined;

/** Derive the DID of a NAMED space, the same way the runtime does. */
export async function deriveSpaceDid(name: string): Promise<string> {
  spaceRoot ??= Identity.fromPassphrase(SPACE_ROOT_PASSPHRASE);
  const space = await (await spaceRoot).derive(name);
  return space.did();
}

export interface DiscoveredSpace {
  /** Space DID (DB file basename without `.sqlite`). */
  did: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

function* walkSqlite(dir: string, depth: number): Generator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return; // missing/unreadable dir
  }
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    if (e.isFile && e.name.endsWith(".sqlite")) yield full;
    else if (e.isDirectory && depth > 0) yield* walkSqlite(full, depth - 1);
  }
}

/** Candidate cache directories to search, in priority order. */
export function candidateRoots(cwd: string = Deno.cwd()): string[] {
  const roots: string[] = [];
  const env = Deno.env.get("MEMORY_DIR");
  if (env) roots.push(env);
  const dbPath = Deno.env.get("DB_PATH");
  if (dbPath) {
    // A bare relative filename (`space.sqlite`) has an empty dirname — fall back
    // to `.` so it still resolves to the current directory rather than dropping.
    roots.push(
      dbPath.endsWith(".sqlite") ? (dirname(dbPath) || ".") : dbPath,
    );
  }
  // Walk up from cwd; check both cache layouts at each level.
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    roots.push(`${dir}/packages/toolshed/cache/memory`);
    roots.push(`${dir}/cache/memory`);
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return roots;
}

/** Discover local space DBs. `dirs` are searched before the default roots. */
export function discoverSpaceDbs(
  opts: { dirs?: string[]; cwd?: string } = {},
): DiscoveredSpace[] {
  const roots = [...(opts.dirs ?? []), ...candidateRoots(opts.cwd)];
  const seen = new Set<string>();
  const out: DiscoveredSpace[] = [];
  for (const root of roots) {
    for (const path of walkSqlite(root, 4)) {
      let real: string;
      try {
        real = Deno.realPathSync(path);
      } catch {
        real = path;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      let stat: Deno.FileInfo;
      try {
        stat = Deno.statSync(path);
      } catch {
        continue;
      }
      out.push({
        did: basename(path).replace(/\.sqlite$/, ""),
        path,
        sizeBytes: stat.size,
        mtimeMs: stat.mtime?.getTime() ?? 0,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Resolve a space token (a DID / DID-prefix, or a path) to a DB file path.
 * Paths win if they exist; otherwise the token is matched against discovered
 * DIDs (exact, then substring). Throws on no/ambiguous match.
 */
export function resolveSpacePath(
  token: string,
  discovered?: DiscoveredSpace[],
): string {
  if (token.endsWith(".sqlite") || token.includes("/")) {
    try {
      Deno.statSync(token);
      return token;
    } catch {
      // not a real path — fall through to DID matching
    }
  }
  const spaces = discovered ?? discoverSpaceDbs();
  const exact = spaces.filter((s) => s.did === token);
  const matches = exact.length
    ? exact
    : spaces.filter((s) => s.did.includes(token));
  if (matches.length === 1) return matches[0].path;
  if (matches.length === 0) {
    throw new Error(`no space matches "${token}" (run: inspect spaces)`);
  }
  throw new Error(
    `"${token}" is ambiguous (${matches.length} matches); use a longer prefix or a path`,
  );
}

/**
 * Resolve a space token to a DB path, accepting a space NAME in addition to a
 * DID / DID-prefix / path. Tries the synchronous matcher first (path/DID); only
 * if that finds nothing AND the token looks like a name (not a path, not already
 * `did:`-shaped) does it derive the name's DID via {@link deriveSpaceDid} and
 * match that. Async because the derivation uses the identity keypair.
 */
export async function resolveSpace(
  token: string,
  discovered?: DiscoveredSpace[],
): Promise<string> {
  const spaces = discovered ?? discoverSpaceDbs();
  try {
    return resolveSpacePath(token, spaces);
  } catch (err) {
    const looksLikeName = !token.includes("/") &&
      !token.endsWith(".sqlite") && !token.startsWith("did:");
    if (!looksLikeName) throw err;
    const did = await deriveSpaceDid(token);
    const match = spaces.find((s) => s.did === did);
    if (match) return match.path;
    throw new Error(
      `no space matches "${token}" — as a name it derives to ${did}, ` +
        `but no local DB for that DID was found (run: inspect spaces)`,
    );
  }
}

export interface SpaceQuickStats {
  commits: number;
  entities: number;
  lastActivity: string | null;
}

/** Cheap one-query stats for listing many DBs without a full summary. */
export function quickStats(path: string): SpaceQuickStats | null {
  let space;
  try {
    space = openSpace(path);
  } catch {
    return null;
  }
  try {
    const row = space.db
      .prepare(
        `SELECT
           (SELECT count(*) FROM "commit") AS commits,
           (SELECT count(DISTINCT id) FROM revision) AS entities,
           (SELECT max(created_at) FROM "commit") AS lastActivity`,
      )
      .get<
        { commits: number; entities: number; lastActivity: string | null }
      >();
    return row
      ? {
        commits: row.commits,
        entities: row.entities,
        lastActivity: row.lastActivity,
      }
      : null;
  } catch {
    return null; // not a memory v2 space DB
  } finally {
    space.close();
  }
}
