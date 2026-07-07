/**
 * Compile-cache key state derivation for perf-check.
 *
 * The pattern-test jobs restore a compile byte cache under keys whose PREFIX
 * hashes a transformer-adjacent path set (the `cc-*` cache keys in
 * .github/workflows/deno.yml). The restore-keys prefix includes that hash, so
 * a run whose commit changes any file in the set gets no cache fallback at
 * all: every pattern compiles cold, and compile-dominated wall times inflate
 * roughly 1.6-1.9x. Gating such a run against warm baselines is a false
 * positive by construction — and the first main-branch run after such a merge
 * is equally cold, polluting the baseline history the same way (observed as
 * the recurring "single-test outlier" spikes).
 *
 * Only the prefix inputs matter for coldness: each job's key suffix (its
 * pattern sources) still restores through the prefix restore-key when it
 * changes, so suffix churn recompiles incrementally rather than from scratch.
 *
 * A run is cold exactly when the hashFiles digest of the prefix set differs
 * from the commit whose cache it would restore — equivalently, when any file
 * in the set changed between the two commits. That makes the state derivable
 * from changed-file lists alone (the PR's file list, or the compare API for
 * adjacent main pushes), with no cooperation needed from the pattern jobs.
 */

import {
  COMPILE_CACHE_FAMILIES,
  type CompileCacheState,
  type CompileCacheStates,
  githubGet,
  REPO,
} from "./perf-lib.ts";

/** Run-level fingerprint verdict; "unknown" must fail open (keep + gate). */
export type CacheKeyState = "cold" | "warm";

/**
 * Mirror of the FIRST hashFiles(...) argument list of every `cc-*` compile
 * cache key in .github/workflows/deno.yml. perf-cache-state.test.ts parses
 * the workflow and asserts set equality, so the two cannot drift silently.
 */
export const COMPILE_CACHE_KEY_GLOBS = [
  "packages/ts-transformers/**",
  "packages/js-compiler/**",
  "packages/runner/src/harness/**",
  "packages/runner/src/pattern-coverage.ts",
  "packages/runner/src/sandbox/**",
  "packages/schema-generator/**",
  "packages/api/**",
  "packages/static/assets/types/**",
  "deno.jsonc",
  "deno.lock",
] as const;

type PathMatcher = (path: string) => boolean;

/**
 * The key globs are deliberately simple (directory trees and exact files), so
 * this interprets just those two shapes and refuses anything fancier — a new
 * glob shape in the workflow must extend this and the drift test together
 * rather than silently mis-matching.
 */
function matcherForGlob(glob: string): PathMatcher {
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -"**".length);
    return (path) => path.startsWith(prefix);
  }
  if (!glob.includes("*")) {
    return (path) => path === glob;
  }
  throw new Error(
    `Unsupported compile-cache key glob shape: ${glob}`,
  );
}

const KEY_PATH_MATCHERS: readonly PathMatcher[] = COMPILE_CACHE_KEY_GLOBS.map(
  matcherForGlob,
);

export function pathTouchesCompileCacheKey(path: string): boolean {
  return KEY_PATH_MATCHERS.some((matches) => matches(path));
}

export function classifyCacheKeyState(
  changedFiles: readonly string[],
): CacheKeyState {
  return changedFiles.some(pathTouchesCompileCacheKey) ? "cold" : "warm";
}

/**
 * Changed files between two commits via the compare API. GitHub caps the
 * file list at 300 entries; adjacent main pushes stay far below that, and a
 * capped list can only under-report (misread cold as warm), which degrades
 * to today's behavior rather than wrongly waiving a gate.
 */
export async function fetchChangedFilesBetween(
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const data = await githubGet<
    { files?: { filename: string; previous_filename?: string }[] }
  >(
    `/repos/${REPO}/compare/${encodeURIComponent(baseSha)}...${
      encodeURIComponent(headSha)
    }`,
  );
  return changedPathsOf(data.files ?? []);
}

/**
 * Both sides of every change: a file renamed OUT of the key set appears only
 * under its new path, but the rename removed it from a hashed directory —
 * the fingerprint rotated all the same. Deletions already surface under
 * `filename`; renames need `previous_filename` too.
 */
export function changedPathsOf(
  files: readonly { filename: string; previous_filename?: string }[],
): string[] {
  return files.flatMap((file) =>
    file.previous_filename
      ? [file.filename, file.previous_filename]
      : [file.filename]
  );
}

/**
 * Classify a run against the run whose cache it would have restored
 * (its predecessor on main). "unknown" — no predecessor available, or the
 * compare failed — must be treated like "warm" by consumers: gate normally
 * and keep the samples, i.e. fail open to today's behavior.
 */
export async function classifyRunAgainstPredecessor(
  headSha: string,
  predecessorSha: string | undefined,
  fetchChanged: (
    baseSha: string,
    headSha: string,
  ) => Promise<string[]> = fetchChangedFilesBetween,
): Promise<CacheKeyState | "unknown"> {
  if (!predecessorSha || predecessorSha === headSha) return "unknown";
  try {
    return classifyCacheKeyState(await fetchChanged(predecessorSha, headSha));
  } catch (error) {
    console.warn(
      `  Warning: could not classify compile-cache state for ${
        headSha.slice(0, 8)
      }: ${error}`,
    );
    return "unknown";
  }
}

/**
 * Expand a run-level fingerprint verdict to per-family states: a fingerprint
 * rotation colds every family at once (the shared key prefix), and a
 * fingerprint-stable run restored (at least) via restore-keys everywhere.
 * Used to retro-classify runs whose artifacts predate the recorded stamp.
 */
export function uniformCacheStates(
  state: CompileCacheState,
): CompileCacheStates {
  const states: CompileCacheStates = {};
  for (const family of COMPILE_CACHE_FAMILIES) {
    states[family] = state;
  }
  return states;
}
