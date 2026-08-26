/**
 * The set of authored pattern entry files in the repository.
 *
 * Shared by `cfcheck.ts` (type-checks them) and `pattern-compat.ts` (proves
 * each one can still be applied over its deployed predecessors). The two must
 * agree on the set: a file cfcheck compiles but pattern-compat skips is a
 * pattern that can ship without an updatability proof.
 */

import { CONNECTOR_PATTERN_SOURCES } from "../packages/connectors/pattern-sources.ts";

export const PATTERNS_DIR = "packages/patterns";

/** A source tree whose authored modules are checked as patterns. */
export interface PatternTree {
  /** Repository-relative directory containing the source modules. */
  readonly directory: string;
  /** Baseline-key prefix when the source tree is outside `PATTERNS_DIR`. */
  readonly keyPrefix?: string;
  /** Program root allowed to resolve the tree's local imports. */
  readonly programRoot?: string;
}

/** Every source tree covered by the pattern type and compatibility checks. */
export const PATTERN_TREES: readonly PatternTree[] = [
  { directory: PATTERNS_DIR },
  ...CONNECTOR_PATTERN_SOURCES.map((source) => ({
    ...source,
    programRoot: ".",
  })),
];

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
export function patternKey(path: string, patternsDir?: string): string {
  if (patternsDir !== undefined) {
    const prefix = `${patternsDir}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }
  for (const tree of PATTERN_TREES) {
    const prefix = `${tree.directory}/`;
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    return tree.keyPrefix === undefined
      ? relative
      : `${tree.keyPrefix}/${relative}`;
  }
  return path;
}

/** Whether a pattern path or its deployed key contains a filter. */
export function matchesPatternFilter(path: string, filter: string): boolean {
  return path.includes(filter) || patternKey(path).includes(filter);
}

/** Repository-relative source path for a compatibility-baseline key. */
export function patternPath(key: string): string {
  for (const tree of PATTERN_TREES) {
    if (tree.keyPrefix === undefined) continue;
    const prefix = `${tree.keyPrefix}/`;
    if (key.startsWith(prefix)) {
      return `${tree.directory}/${key.slice(prefix.length)}`;
    }
  }
  return `${PATTERNS_DIR}/${key}`;
}

/** Source root containing a repository-relative pattern path. */
export function patternRoot(path: string): string {
  return PATTERN_TREES.find((tree) =>
    path === tree.directory || path.startsWith(`${tree.directory}/`)
  )?.programRoot ?? PATTERNS_DIR;
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

/** Every authored pattern source across all registered source trees. */
export async function collectAllPatternFiles(): Promise<string[]> {
  const files = await Promise.all(
    PATTERN_TREES.map((tree) => collectPatternFiles(tree.directory)),
  );
  return files.flat().sort();
}
