#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
import * as path from "@std/path";

export const COVERAGE_PROFILE_ARTIFACT_PREFIX = "coverage-profile-";
export const COVERAGE_METRIC_PREFIX = "coverage-debt:";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SOURCE_ROOTS = ["packages", "tasks", "scripts"];
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
  const lcov = await denoCoverageLcov(options.coverageProfileDir);
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
  let count = 0;
  let inBlockComment = false;

  for (const line of content.split(/\r?\n/)) {
    let text = line.trim();
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

      count++;
      break;
    }
  }

  return count;
}

export function parseLcov(lcov: string): Map<string, LcovFileCoverage> {
  const files = new Map<string, LcovFileCoverage>();
  let currentPath: string | undefined;

  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      currentPath = path.normalize(line.slice(3));
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
  let uncovered = 0;
  for (const hits of coverage.lineHits.values()) {
    if (hits === 0) uncovered++;
  }
  return uncovered;
}

async function denoCoverageLcov(coverageProfileDir: string): Promise<string> {
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
