#!/usr/bin/env -S deno run --allow-read --allow-write
import * as path from "@std/path";

/**
 * Rewrite an LCOV `SF:` source path to a repository-relative POSIX path.
 *
 * `deno coverage --lcov` records each source file by its absolute path on the
 * machine that ran the tests. Those roots differ between runners: a
 * GitHub-hosted runner checks the repository out under `/home/runner/work`,
 * while a self-hosted runner uses its own work directory. The actions runner
 * always checks out into `<work-dir>/<repo>/<repo>`, so the path that follows
 * the doubled repository directory is the repository-relative path. Stripping
 * everything up to and including that doubled directory collapses the differing
 * absolute roots onto a single relative path an IDE can map back to the
 * checkout.
 *
 * The last occurrence of the doubled directory is used so that a work directory
 * whose own ancestors happen to repeat the repository name does not anchor too
 * early. Paths that do not contain the doubled repository directory are
 * returned unchanged; pattern-runtime coverage uses synthetic paths (for
 * example `cf-mount/...`) that have no repository file to map to.
 */
export function normalizeSourcePath(
  sourcePath: string,
  repoName: string,
): string {
  const posix = sourcePath.replaceAll("\\", "/");
  const anchor = `/${repoName}/${repoName}/`;
  const index = posix.lastIndexOf(anchor);
  if (index >= 0) return posix.slice(index + anchor.length);
  return posix;
}

interface FileCoverage {
  testName?: string;
  lineHits: Map<number, number>;
}

/**
 * Parse one or more LCOV reports, normalize their source paths, and merge every
 * record that refers to the same source file into a single line-coverage
 * record. Per-line execution counts are summed, matching how the repository's
 * own coverage tooling (tasks/coverage-metrics.ts) accumulates hits, so a file
 * exercised by several test jobs is reported once with its combined coverage
 * rather than as repeated records that some LCOV consumers keep only the last
 * of.
 *
 * Only line coverage (`DA`/`LF`/`LH`) is carried through. Function (`FN`) and
 * branch (`BRDA`) records are dropped: LCOV keys function hits by name, and a
 * single source file can declare several functions with the same name (for
 * example a free function and a method), so merging them faithfully is not
 * possible from the report alone. Line coverage is what IDEs use to colour the
 * gutter and is the signal the combined report exists to provide.
 */
export function mergeLcovReports(
  reports: string[],
  repoName: string,
): { lcov: string; fileCount: number; rewritten: number; unchanged: number } {
  const files = new Map<string, FileCoverage>();
  const anchored = new Set<string>();

  for (const report of reports) {
    let current: FileCoverage | undefined;
    // An LCOV record opens with an optional `TN:` test-name line before its
    // `SF:` line, so a test name is held until the source path is known.
    let pendingTestName: string | undefined;
    for (const line of report.split(/\r?\n/)) {
      if (line.startsWith("TN:")) {
        pendingTestName = line.slice(3) || undefined;
      } else if (line.startsWith("SF:")) {
        const original = line.slice(3);
        const normalized = normalizeSourcePath(original, repoName);
        current = files.get(normalized);
        if (!current) {
          current = { lineHits: new Map() };
          files.set(normalized, current);
          if (normalized !== original) anchored.add(normalized);
        }
        if (pendingTestName && !current.testName) {
          current.testName = pendingTestName;
        }
        pendingTestName = undefined;
      } else if (!current) {
        continue;
      } else if (line.startsWith("DA:")) {
        const [lineNumber, hits] = line.slice(3).split(",");
        const parsedLine = Number(lineNumber);
        const parsedHits = Number(hits);
        if (Number.isInteger(parsedLine) && Number.isFinite(parsedHits)) {
          current.lineHits.set(
            parsedLine,
            (current.lineHits.get(parsedLine) ?? 0) + parsedHits,
          );
        }
      } else if (line === "end_of_record") {
        current = undefined;
        pendingTestName = undefined;
      }
    }
  }

  const paths = [...files.keys()].sort();
  const blocks = paths.map((sourcePath) =>
    serializeFileCoverage(sourcePath, files.get(sourcePath)!)
  );
  const lcov = blocks.length === 0 ? "" : `${blocks.join("\n")}\n`;

  return {
    lcov,
    fileCount: files.size,
    rewritten: anchored.size,
    unchanged: files.size - anchored.size,
  };
}

function serializeFileCoverage(
  sourcePath: string,
  file: FileCoverage,
): string {
  const lines: string[] = [];
  if (file.testName) lines.push(`TN:${file.testName}`);
  lines.push(`SF:${sourcePath}`);

  const lineNumbers = [...file.lineHits.keys()].sort((a, b) => a - b);
  let linesHit = 0;
  for (const lineNumber of lineNumbers) {
    const hits = file.lineHits.get(lineNumber)!;
    if (hits > 0) linesHit++;
    lines.push(`DA:${lineNumber},${hits}`);
  }
  lines.push(`LF:${lineNumbers.length}`);
  lines.push(`LH:${linesHit}`);
  lines.push("end_of_record");
  return lines.join("\n");
}

async function* collectLcovFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (error) {
    // A missing input directory (no coverage was downloaded) yields no files.
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory) {
      yield* collectLcovFiles(full);
    } else if (entry.name.endsWith(".lcov")) {
      yield full;
    }
  }
}

/**
 * Read every LCOV report under `inputDir` and merge them into a single report
 * with repository-relative source paths.
 */
export async function combineCoverageLcov(
  inputDir: string,
  repoName: string,
): Promise<
  { lcov: string; fileCount: number; rewritten: number; unchanged: number }
> {
  const files: string[] = [];
  for await (const file of collectLcovFiles(inputDir)) files.push(file);
  files.sort();

  const reports: string[] = [];
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    if (text.trim().length > 0) reports.push(text);
  }

  return mergeLcovReports(reports, repoName);
}

function parseArgs(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) parsed.set(match[1], match[2]);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  const inputDir = args.get("input-dir");
  const outputPath = args.get("output");
  const repoName = args.get("repo-name");
  if (!inputDir || !outputPath || !repoName) {
    console.error(
      "Usage: deno run --allow-read --allow-write tasks/combine-coverage-lcov.ts " +
        "--input-dir=<dir> --output=<combined.lcov> --repo-name=<repository name>",
    );
    Deno.exit(2);
  }

  const { lcov, fileCount, rewritten, unchanged } = await combineCoverageLcov(
    inputDir,
    repoName,
  );

  await Deno.mkdir(path.dirname(outputPath), { recursive: true });
  await Deno.writeTextFile(outputPath, lcov);

  console.log(
    `Merged line coverage for ${fileCount} source file(s) into ${outputPath} ` +
      `(${rewritten} normalized to repository-relative paths, ${unchanged} left as-is).`,
  );
}

if (import.meta.main) {
  await main();
}
