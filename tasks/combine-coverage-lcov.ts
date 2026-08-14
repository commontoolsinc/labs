#!/usr/bin/env -S deno run --allow-read --allow-write
import { walk } from "@std/fs/walk";
import * as path from "@std/path";
import { type LcovFileCoverage, parseLcovReports } from "./lcov.ts";

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

/**
 * Merge one or more LCOV reports into a single report whose source paths are
 * repository-relative. Records that refer to the same source file collapse into
 * one, with per-line execution counts summed, so a file exercised by several
 * test jobs is reported once with its combined coverage rather than as repeated
 * records that some LCOV consumers keep only the last of.
 *
 * Only line coverage (`DA`/`LF`/`LH`) is carried through; `parseLcovReports`
 * explains what the other record kinds cost to merge.
 */
export function mergeLcovReports(
  reports: string[],
  repoName: string,
): { lcov: string; fileCount: number; rewritten: number; unchanged: number } {
  const files = parseLcovReports(reports, {
    mapPath: (sourcePath) => normalizeSourcePath(sourcePath, repoName),
  });

  const paths = [...files.keys()].sort();
  const blocks = paths.map((sourcePath) =>
    serializeFileCoverage(sourcePath, files.get(sourcePath)!)
  );
  const lcov = blocks.length === 0 ? "" : `${blocks.join("\n")}\n`;

  let rewritten = 0;
  for (const [normalized, file] of files) {
    if (normalized !== file.sourcePath) rewritten++;
  }

  return {
    lcov,
    fileCount: files.size,
    rewritten,
    unchanged: files.size - rewritten,
  };
}

function serializeFileCoverage(
  sourcePath: string,
  file: LcovFileCoverage,
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

/**
 * Every `.lcov` report under `dir`. A missing input directory means no coverage
 * was downloaded and yields no files; anything that goes wrong once the walk is
 * under way is reported, so a report that is present but unreadable cannot
 * shorten the merged output unnoticed.
 */
async function collectLcovFiles(dir: string): Promise<string[]> {
  try {
    await Deno.stat(dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  const files: string[] = [];
  for await (
    const entry of walk(dir, { includeDirs: false, exts: [".lcov"] })
  ) {
    files.push(entry.path);
  }
  return files;
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
  const files = (await collectLcovFiles(inputDir)).sort();

  const reports: string[] = [];
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    if (text.trim().length > 0) reports.push(text);
  }

  return mergeLcovReports(reports, repoName);
}

export function parseArgs(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) parsed.set(match[1], match[2]);
  }
  return parsed;
}

/** Run the command-line interface; returns the process exit code. */
export async function main(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const inputDir = parsed.get("input-dir");
  const outputPath = parsed.get("output");
  const repoName = parsed.get("repo-name");
  if (!inputDir || !outputPath || !repoName) {
    console.error(
      "Usage: deno run --allow-read --allow-write tasks/combine-coverage-lcov.ts " +
        "--input-dir=<dir> --output=<combined.lcov> --repo-name=<repository name>",
    );
    return 2;
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
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
