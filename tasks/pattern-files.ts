/**
 * The set of authored pattern entry files under `packages/patterns`.
 *
 * Shared by `cfcheck.ts` (type-checks them) and `pattern-compat.ts` (proves
 * each one can still be applied over its deployed predecessors). The two must
 * agree on the set: a file cfcheck compiles but pattern-compat skips is a
 * pattern that can ship without an updatability proof.
 */

export const PATTERNS_DIR = "packages/patterns";

/**
 * Exclusions are expressed relative to the patterns root, not to the repo
 * root, so they hold whatever directory the walk is rooted at — an absolute
 * path, or a relative one from a different working directory. Anchoring them
 * to `packages/patterns/...` instead would silently stop excluding anything
 * the moment a caller passed an absolute directory.
 */
const NON_PATTERN_FILES = new Set([
  "mod.ts",
]);

const NON_PATTERN_PREFIXES = [
  "integration/",
  "tools/",
];

/**
 * A pattern's identity in the baseline tree: its path relative to the patterns
 * root, e.g. `system/home.tsx`. This is also the suffix of the toolshed route
 * that serves it (`/api/patterns/system/home.tsx`), which is what the updater
 * resolves against — so a baseline directory is named by the same string the
 * update mechanism keys on.
 */
export function patternKey(path: string, patternsDir = PATTERNS_DIR): string {
  const prefix = `${patternsDir}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Whether a path under the patterns root is an authored pattern entry. */
export function isPatternSource(
  path: string,
  patternsDir = PATTERNS_DIR,
): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return false;
  const key = patternKey(path, patternsDir);
  if (NON_PATTERN_FILES.has(key)) return false;
  return !NON_PATTERN_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export async function collectPatternFiles(
  dir: string = PATTERNS_DIR,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string) {
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile) continue;
      if (!isPatternSource(path, dir)) continue;
      files.push(path);
    }
  }

  await walk(dir);
  return files.sort();
}
