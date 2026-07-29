/**
 * The set of authored pattern entry files under `packages/patterns`.
 *
 * Shared by `cfcheck.ts` (type-checks them) and `pattern-compat.ts` (proves
 * each one can still be applied over its deployed predecessors). The two must
 * agree on the set: a file cfcheck compiles but pattern-compat skips is a
 * pattern that can ship without an updatability proof.
 */

export const PATTERNS_DIR = "packages/patterns";

const NON_PATTERN_FILES = new Set([
  "packages/patterns/mod.ts",
  "packages/patterns/scrabble/scrabble-words.ts",
]);

const NON_PATTERN_PREFIXES = [
  "packages/patterns/integration/",
  "packages/patterns/tools/",
];

export function isPatternSource(path: string): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  if (NON_PATTERN_FILES.has(path)) return false;
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return false;
  return !NON_PATTERN_PREFIXES.some((prefix) => path.startsWith(prefix));
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
      if (!isPatternSource(path)) continue;
      files.push(path);
    }
  }

  await walk(dir);
  return files.sort();
}

/**
 * A pattern's identity in the baseline tree: its path relative to the patterns
 * root, e.g. `system/home.tsx`. This is also the suffix of the toolshed route
 * that serves it (`/api/patterns/system/home.tsx`), which is what the updater
 * resolves against — so a baseline directory is named by the same string the
 * update mechanism keys on.
 */
export function patternKey(path: string): string {
  return path.startsWith(`${PATTERNS_DIR}/`)
    ? path.slice(PATTERNS_DIR.length + 1)
    : path;
}
