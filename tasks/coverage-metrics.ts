#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
import * as path from "@std/path";

export const COVERAGE_PROFILE_ARTIFACT_PREFIX = "coverage-profile-";
export const COVERAGE_METRIC_PREFIX = "coverage-debt:";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SOURCE_ROOTS = ["packages", "tasks"];
const EXCLUDED_PATH_PARTS = new Set([
  ".cache",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "integration",
  "node_modules",
  "test",
  "tests",
  "vendor-astral",
]);

const EXCLUDED_RELATIVE_PREFIXES = [
  "packages/generated-patterns/integration/",
  "packages/patterns/factory-outputs/",
  "packages/patterns-saves-backup/",
  "packages/static/assets/",
];

const EXCLUDED_FILE_SUFFIXES = [
  ".bench.ts",
  ".bench.tsx",
  ".d.ts",
  ".spec.ts",
  ".spec.tsx",
  ".test.ts",
  ".test.tsx",
];

export interface CoverageDebtMetricsOptions {
  rootDir: string;
  coverageProfileDir: string;
}

export interface CoverageDebtMetricsFromLcovOptions {
  rootDir: string;
  lcov: string;
}

export interface CoverageDebtMetric {
  name: string;
  uncoveredLines: number;
}

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  metricGroup: string;
  trackedLineCount: number;
}

interface LcovFileCoverage {
  lineHits: Map<number, number>;
}

export async function collectCoverageDebtMetrics(
  options: CoverageDebtMetricsOptions,
): Promise<CoverageDebtMetric[]> {
  const lcov = await lcovFromCoverageProfile(options.coverageProfileDir);
  return await collectCoverageDebtMetricsFromLcov({
    rootDir: options.rootDir,
    lcov,
  });
}

export async function collectCoverageDebtMetricsFromLcov(
  options: CoverageDebtMetricsFromLcovOptions,
): Promise<CoverageDebtMetric[]> {
  const sourceFiles = await collectSourceFiles(options.rootDir);
  const lcovCoverage = parseLcov(options.lcov);

  let workspaceUncovered = 0;
  const groupUncovered = new Map<string, number>();
  const groupNames = new Set(sourceFiles.map((source) => source.metricGroup));

  for (const source of sourceFiles) {
    const coverage = lcovCoverage.get(source.absolutePath);
    // A file the tests never loaded has no coverage record; every tracked
    // line counts as uncovered, matching how the debt metric scores it.
    const uncovered = coverage
      ? countUncoveredProfileLines(coverage)
      : source.trackedLineCount;

    workspaceUncovered += uncovered;
    groupUncovered.set(
      source.metricGroup,
      (groupUncovered.get(source.metricGroup) ?? 0) + uncovered,
    );
  }

  const metrics: CoverageDebtMetric[] = [
    {
      name: `${COVERAGE_METRIC_PREFIX} workspace uncovered lines`,
      uncoveredLines: workspaceUncovered,
    },
  ];

  for (const group of [...groupNames].sort()) {
    metrics.push({
      name: `${COVERAGE_METRIC_PREFIX} ${group} uncovered lines`,
      uncoveredLines: groupUncovered.get(group) ?? 0,
    });
  }

  return metrics;
}

/**
 * Return the uncovered source line numbers for specific files, keyed by their
 * repository-relative POSIX path. Only the requested files are inspected, so a
 * caller that needs per-line detail for a handful of files (e.g. a PR's changed
 * files) does not pay to materialize line arrays for the whole workspace.
 */
export async function collectUncoveredLinesForFiles(
  options: CoverageDebtMetricsFromLcovOptions & { files: Iterable<string> },
): Promise<Map<string, number[]>> {
  const lcovCoverage = parseLcov(options.lcov);
  const result = new Map<string, number[]>();

  for (const requested of options.files) {
    const relativePath = toPosix(requested);
    if (result.has(relativePath) || !shouldTrackSourceFile(relativePath)) {
      continue;
    }

    const absolutePath = path.normalize(
      path.join(options.rootDir, relativePath),
    );
    const coverage = lcovCoverage.get(absolutePath);

    let uncoveredLines: number[];
    if (coverage) {
      uncoveredLines = uncoveredProfileLineNumbers(coverage);
    } else {
      // No coverage record: the file was never loaded by any test, so every
      // tracked line is uncovered.
      let content: string;
      try {
        content = await Deno.readTextFile(absolutePath);
      } catch (error) {
        // A file the PR deletes is in the changed list but absent from the
        // checkout; skip it. Surface any other read failure rather than
        // silently under-reporting coverage.
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      uncoveredLines = trackedSourceLineNumbers(content);
    }

    if (uncoveredLines.length > 0) result.set(relativePath, uncoveredLines);
  }

  return result;
}

export async function collectSourceFiles(
  rootDir: string,
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const fullRoot = path.join(rootDir, sourceRoot);
    if (!await existsDirectory(fullRoot)) continue;

    for await (const file of walkFiles(fullRoot)) {
      const relativePath = toPosix(path.relative(rootDir, file));
      if (!shouldTrackSourceFile(relativePath)) continue;

      const content = await Deno.readTextFile(file);
      files.push({
        absolutePath: path.normalize(file),
        relativePath,
        metricGroup: metricGroupFor(relativePath),
        trackedLineCount: countTrackedSourceLines(content),
      });
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function shouldTrackSourceFile(relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  if (normalized === "scripts" || normalized.startsWith("scripts/")) {
    return false;
  }

  const extension = path.extname(normalized);
  if (!SOURCE_EXTENSIONS.has(extension)) return false;

  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return false;
  }

  if (
    EXCLUDED_RELATIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return false;
  }

  const parts = normalized.split("/");
  return !parts.some((part) => EXCLUDED_PATH_PARTS.has(part));
}

export function metricGroupFor(relativePath: string): string {
  const normalized = toPosix(relativePath);
  const parts = normalized.split("/");
  if (parts[0] === "packages" && parts[1]) {
    return `packages/${parts[1]}`;
  }
  return parts[0] ?? "workspace";
}

export function countTrackedSourceLines(content: string): number {
  return trackedSourceLineNumbers(content).length;
}

export function trackedSourceLineNumbers(content: string): number[] {
  const lineNumbers: number[] = [];
  let inBlockComment = false;

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    let text = lines[index].trim();
    if (text.length === 0) continue;

    while (text.length > 0) {
      if (inBlockComment) {
        const end = text.indexOf("*/");
        if (end < 0) {
          text = "";
          break;
        }
        text = text.slice(end + 2).trim();
        inBlockComment = false;
        continue;
      }

      if (text.startsWith("//")) {
        text = "";
        break;
      }

      if (text.startsWith("/*")) {
        const end = text.indexOf("*/", 2);
        if (end < 0) {
          text = "";
          inBlockComment = true;
          break;
        }
        text = text.slice(end + 2).trim();
        continue;
      }

      lineNumbers.push(index + 1);
      break;
    }
  }

  return lineNumbers;
}

export function parseLcov(lcov: string): Map<string, LcovFileCoverage> {
  const files = new Map<string, LcovFileCoverage>();
  let currentPath: string | undefined;

  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      // Strip any query suffix before keying: Deno's coverage emits a
      // separate record per module INSTANCE (e.g. `foo.ts?testRun=<uuid>`
      // per importing test file), and keying on the raw path counted the
      // same physical line as debt once per instance that didn't execute
      // it. That made the debt metric flap ±1-5 lines with test order and
      // timing — and made ADDING a test able to increase "uncovered lines"
      // (its fresh instances carry red lines for whatever they don't
      // execute). Merging instances measures real per-file coverage: a line
      // is covered when ANY instance executed it (CT-1861).
      currentPath = path.normalize(line.slice(3).split("?")[0]);
      if (!files.has(currentPath)) {
        files.set(currentPath, { lineHits: new Map() });
      }
      continue;
    }

    if (line.startsWith("DA:") && currentPath) {
      const [lineNumberRaw, hitsRaw] = line.slice(3).split(",");
      const lineNumber = Number(lineNumberRaw);
      const hits = Number(hitsRaw);
      if (Number.isFinite(lineNumber) && Number.isFinite(hits)) {
        const file = files.get(currentPath)!;
        file.lineHits.set(
          lineNumber,
          (file.lineHits.get(lineNumber) ?? 0) + hits,
        );
      }
      continue;
    }

    if (line === "end_of_record") {
      currentPath = undefined;
    }
  }

  return files;
}

export function countUncoveredProfileLines(coverage: LcovFileCoverage): number {
  return uncoveredProfileLineNumbers(coverage).length;
}

function uncoveredProfileLineNumbers(coverage: LcovFileCoverage): number[] {
  const lineNumbers: number[] = [];
  for (const [lineNumber, hits] of coverage.lineHits) {
    if (hits === 0) lineNumbers.push(lineNumber);
  }
  return lineNumbers.sort((a, b) => a - b);
}

/** Run `deno coverage --lcov` over a profile directory and return the report. */
export async function lcovFromCoverageProfile(
  coverageProfileDir: string,
): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "coverage-lcov-" });
  const outputPath = path.join(tmpDir, "coverage.lcov");
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "coverage",
        "--lcov",
        `--output=${outputPath}`,
        coverageProfileDir,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`deno coverage failed: ${stderr.trim()}`);
    }

    return await Deno.readTextFile(outputPath);
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

async function existsDirectory(dir: string): Promise<boolean> {
  try {
    return (await Deno.stat(dir)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function toPosix(filePath: string): string {
  return filePath.split(path.SEPARATOR).join("/");
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory && EXCLUDED_PATH_PARTS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory) {
      yield* walkFiles(full);
    } else {
      yield full;
    }
  }
}

if (import.meta.main) {
  const args = new Map<string, string>();
  for (const arg of Deno.args) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args.set(match[1], match[2]);
  }

  const rootDir = args.get("root") ?? Deno.cwd();
  const coverageProfileDir = args.get("profile-dir");
  if (!coverageProfileDir) {
    console.error("--profile-dir is required.");
    Deno.exit(1);
  }

  const metrics = await collectCoverageDebtMetrics({
    rootDir,
    coverageProfileDir,
  });
  console.log(JSON.stringify({ metrics }, null, 2));
}
