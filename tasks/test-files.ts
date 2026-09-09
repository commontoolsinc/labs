/**
 * Which files of this repository are tests rather than source, for the lint
 * rules that hold source to a rule and exempt the tests from it. A test, a
 * benchmark, and the helpers and fixtures serving either all count: a file
 * named `*.test.ts` or `*.bench.ts` (or `.tsx`) wherever it sits, and every
 * file under a `test/`, `integration/`, or `bench/` directory.
 */

import { relative } from "@std/path";

/** The directories that hold tests and benchmarks rather than source. */
export const TEST_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "bench",
  "integration",
  "test",
]);

/** The file names that are a test or a benchmark wherever they sit. */
export const TEST_FILE_PATTERN = /\.(?:test|bench)\.tsx?$/;

/** Either separator `relative()` can return, the host deciding which. */
export const PATH_SEPARATOR = /[/\\]/;

/**
 * True when the file at `path` is a test rather than source. Only the
 * directories between `root` and the file are read, so a `test` directory
 * above `root` does not make everything under it a test.
 */
export function isTestFile(root: string, path: string): boolean {
  const parts = relative(root, path).split(PATH_SEPARATOR);
  const base = parts.pop() ?? "";
  return TEST_FILE_PATTERN.test(base) ||
    parts.some((part) => TEST_DIRECTORY_NAMES.has(part));
}
