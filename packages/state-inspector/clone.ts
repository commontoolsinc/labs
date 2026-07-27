// Rehearsal-grade space clones — a writable copy of a real space store, plus
// the bookkeeping that makes repeated rehearsal attempts comparable.
//
// Design + evidence: docs/plans/space-clone-rehearsal.md. Two findings from the
// July 2026 Topics migration shape this module:
//
//   * The COPY was never the hard part. A server-side `VACUUM INTO` already
//     emits one correctly-named, companion-free file, and a plain `cp` was
//     enough. So the copy path here is deliberately thin.
//   * The BOOKKEEPING was re-invented every attempt (ad-hoc SQL and Python
//     heredocs). Two rehearsals whose fingerprints were computed differently
//     cannot be compared, and an improvised check that quietly measures less
//     than last time looks exactly like a pass. The manifest is the payload.
//
// Layout written by `createClone`:
//
//   <dir>/clone.json               manifest: source, hashes, counts
//   <dir>/.cf-clone                marker — "this store is NOT production"
//   <dir>/pristine/<did>.sqlite    the baseline; never opened read-write
//   <dir>/engine-v3/<did>.sqlite   the working copy a toolshed serves
//
// `engine-v3/` is not decoration: it is the on-disk layout the memory server
// resolves through `resolveSpaceStoreUrl`, so pointing `MEMORY_DIR` at <dir>
// serves the clone as a live space under the SAME DID.

import { createHasher } from "@commonfabric/content-hash";
import { openSpace } from "./db.ts";
import { contentFingerprint, type FingerprintReport } from "./fingerprint.ts";

/** Filenames the layout depends on. */
const MANIFEST = "clone.json";
const MARKER = ".cf-clone";
const PRISTINE_DIR = "pristine";
/** The memory server's own per-space directory name — must match the engine. */
const WORKING_DIR = "engine-v3";

export interface CloneManifest {
  /** Schema version of this file, so a future reader can refuse politely. */
  version: 1;
  /** Space DID — the clone keeps it (see the design doc's identity section). */
  space: string;
  /** Where the snapshot came from: a path or URL, verbatim, for provenance. */
  source: string;
  /** ISO timestamp the clone was taken. */
  createdAt: string;
  /** SHA-256 of the pristine snapshot file. */
  snapshotHash: string;
  snapshotBytes: number;
  /** Durable counts at clone time — the cheap half of "did content survive?". */
  counts: {
    commits: number;
    revisions: number;
    entities: number;
    maxSeq: number;
  };
  /** Content fingerprint at clone time, generated cells excluded. */
  fingerprint: { hash: string; entities: number; excludedGenerated: number };
}

export interface CreateCloneOptions {
  /** Path to a `.sqlite` snapshot (a server-side `VACUUM INTO` output). */
  source: string;
  /** Space DID; determines the on-disk filename the server resolves. */
  space: string;
  /** Destination clone directory. Created if absent, must be empty otherwise. */
  targetDir: string;
  /**
   * Store directories that must never be written to — normally the live
   * server's. Callers pass what the environment says (`MEMORY_DIR`/`DB_PATH`).
   */
  forbiddenDirs?: string[];
  /** Timestamp source, injectable so tests need no clock. */
  now?: () => Date;
}

export interface ClonePaths {
  dir: string;
  manifestPath: string;
  pristinePath: string;
  workingPath: string;
}

/** Where each artifact lives for a clone of `space` in `dir`. */
export function clonePaths(dir: string, space: string): ClonePaths {
  const file = `${space}.sqlite`;
  return {
    dir,
    manifestPath: `${dir}/${MANIFEST}`,
    pristinePath: `${dir}/${PRISTINE_DIR}/${file}`,
    workingPath: `${dir}/${WORKING_DIR}/${file}`,
  };
}

/**
 * Build a clone from a snapshot: copy to `pristine/`, copy that to
 * `engine-v3/`, and record a manifest.
 *
 * The source is never opened read-write and never mutated — it is read for
 * hashing and copied. Refuses to write into a forbidden (live) store directory
 * or into the source's own directory.
 */
export async function createClone(
  options: CreateCloneOptions,
): Promise<CloneManifest> {
  const now = options.now ?? (() => new Date());
  const dir = await resolvePath(options.targetDir);
  const source = await resolvePath(options.source);

  assertSafeTarget(dir, source, options.forbiddenDirs ?? []);
  await assertEmptyOrAbsent(dir);

  const paths = clonePaths(dir, options.space);
  await Deno.mkdir(`${dir}/${PRISTINE_DIR}`, { recursive: true });
  await Deno.mkdir(`${dir}/${WORKING_DIR}`, { recursive: true });

  // Plain copies. `VACUUM INTO` server-side already produced a consistent,
  // companion-free file; re-vacuuming here would need the live source, which by
  // this point is typically an scp'd file on a laptop.
  await Deno.copyFile(source, paths.pristinePath);
  await Deno.copyFile(paths.pristinePath, paths.workingPath);

  const snapshotHash = await hashFile(paths.pristinePath);
  const snapshotBytes = (await Deno.stat(paths.pristinePath)).size;

  const space = openSpace(paths.pristinePath);
  let counts: CloneManifest["counts"];
  let fingerprint: FingerprintReport;
  try {
    counts = storeCounts(space);
    fingerprint = contentFingerprint(space);
  } finally {
    space.close();
  }

  const manifest: CloneManifest = {
    version: 1,
    space: options.space,
    source: options.source,
    createdAt: now().toISOString(),
    snapshotHash,
    snapshotBytes,
    counts,
    fingerprint: {
      hash: fingerprint.hash,
      entities: fingerprint.entities,
      excludedGenerated: fingerprint.excludedGenerated,
    },
  };

  await Deno.writeTextFile(
    paths.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await Deno.writeTextFile(
    `${dir}/${MARKER}`,
    `This directory is a CLONE of space ${options.space}, not production.\n` +
      `Taken ${manifest.createdAt} from ${options.source}.\n` +
      `Reset it with: cf space reset ${dir}\n`,
  );
  return manifest;
}

/**
 * Restore the working copy from the pristine snapshot.
 *
 * Deletes the `-wal`/`-shm` companions the engine creates on open. Leaving them
 * behind would let a checkpoint replay part of the discarded attempt over the
 * fresh copy — a reset that silently isn't one.
 */
export async function resetClone(dir: string): Promise<CloneManifest> {
  const manifest = await readManifest(dir);
  const paths = clonePaths(await resolvePath(dir), manifest.space);
  // The companions are absent on a clone no engine has opened yet — the normal
  // case at the start of a rehearsal — so their absence is not an error, while
  // any OTHER failure must surface rather than leave a half-reset clone.
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${paths.workingPath}${suffix}`;
    if (await pathExists(path)) await Deno.remove(path);
  }
  await Deno.copyFile(paths.pristinePath, paths.workingPath);
  return manifest;
}

export interface VerifyResult {
  /** True when the baseline is intact AND the working copy still matches it. */
  ok: boolean;
  /** The pristine snapshot still hashes to what the manifest recorded. */
  baselineIntact: boolean;
  /** Working-copy counts, against the manifest's. */
  counts: {
    manifest: CloneManifest["counts"];
    working: CloneManifest["counts"];
  };
  /** Working-copy content fingerprint, and whether it matches the baseline. */
  fingerprint: {
    manifest: string;
    working: string;
    match: boolean;
    excludedGenerated: number;
  };
}

/**
 * Check a clone against its manifest: the baseline is what it claims to be, and
 * the working copy still holds the same durable content.
 *
 * A migration rehearsal EXPECTS counts to grow — that is what a migration does.
 * The fingerprint is the signal that matters: generated cells are excluded, so
 * a clean pattern update should leave it unchanged even as commits climb.
 */
export async function verifyClone(dir: string): Promise<VerifyResult> {
  const manifest = await readManifest(dir);
  const paths = clonePaths(await resolvePath(dir), manifest.space);

  const baselineIntact = await hashFile(paths.pristinePath) ===
    manifest.snapshotHash;

  const space = openSpace(paths.workingPath);
  let counts: CloneManifest["counts"];
  let fingerprint: FingerprintReport;
  try {
    counts = storeCounts(space);
    fingerprint = contentFingerprint(space);
  } finally {
    space.close();
  }

  const match = fingerprint.hash === manifest.fingerprint.hash;
  return {
    ok: baselineIntact && match,
    baselineIntact,
    counts: { manifest: manifest.counts, working: counts },
    fingerprint: {
      manifest: manifest.fingerprint.hash,
      working: fingerprint.hash,
      match,
      excludedGenerated: fingerprint.excludedGenerated,
    },
  };
}

/** Read and validate a clone manifest. */
export async function readManifest(dir: string): Promise<CloneManifest> {
  const path = `${await resolvePath(dir)}/${MANIFEST}`;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`${dir} is not a clone directory (no ${MANIFEST}).`);
    }
    throw error;
  }
  const parsed = JSON.parse(text) as CloneManifest;
  if (parsed.version !== 1) {
    throw new Error(
      `${path} has manifest version ${parsed.version}; this tool understands 1.`,
    );
  }
  return parsed;
}

function storeCounts(
  space: ReturnType<typeof openSpace>,
): CloneManifest["counts"] {
  const one = <T extends object>(sql: string): T =>
    space.db.prepare(sql).get<T>() as T;
  const c = one<{ n: number; hi: number | null }>(
    `SELECT count(*) n, max(seq) hi FROM "commit"`,
  );
  const r = one<{ n: number; e: number }>(
    `SELECT count(*) n, count(DISTINCT id) e FROM revision`,
  );
  return { commits: c.n, revisions: r.n, entities: r.e, maxSeq: c.hi ?? 0 };
}

/**
 * SHA-256 of a file, streamed through the canonical hasher
 * (`@commonfabric/content-hash`) so a multi-GB store never lands in memory.
 */
async function hashFile(path: string): Promise<string> {
  const hasher = createHasher();
  using file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) hasher.update(chunk);
  return hasher.digest("base64url");
}

async function resolvePath(path: string): Promise<string> {
  // realPath needs the path to exist; fall back to the literal for a target
  // directory we are about to create.
  try {
    return await Deno.realPath(path);
  } catch {
    return path.replace(/\/+$/, "");
  }
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * The rail that matters: never write a clone into the store a live server is
 * serving, and never into the source's own directory.
 *
 * Explicit path refusal, not a "looks like production" heuristic — a guess that
 * says yes when it should say no is worse than no check at all.
 */
function assertSafeTarget(
  dir: string,
  source: string,
  forbiddenDirs: string[],
): void {
  const sourceDir = source.replace(/\/[^/]*$/, "");
  if (isWithin(dir, sourceDir) || isWithin(sourceDir, dir)) {
    throw new Error(
      `refusing to clone into the snapshot's own directory (${sourceDir}).`,
    );
  }
  for (const raw of forbiddenDirs) {
    const forbidden = raw.replace(/\/+$/, "");
    if (forbidden === "") continue;
    if (isWithin(dir, forbidden) || isWithin(forbidden, dir)) {
      throw new Error(
        `refusing to write a clone into ${dir}: it overlaps the live store ` +
          `directory ${forbidden}. Pick a target outside it.`,
      );
    }
  }
}

/**
 * Whether a path exists. An absent path is an ordinary answer; every other
 * failure (a component that is not a directory, a permission problem) is a real
 * error and propagates — treating those as "absent" would silently skip a
 * reset or merge a clone into occupied ground.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** A clone directory must not silently merge into existing contents. */
async function assertEmptyOrAbsent(dir: string): Promise<void> {
  // Absent is the normal case — we are about to create it.
  if (!(await pathExists(dir))) return;
  for await (const entry of Deno.readDir(dir)) {
    throw new Error(
      `${dir} is not empty (found ${entry.name}); pick a fresh directory or ` +
        `remove it first.`,
    );
  }
}
