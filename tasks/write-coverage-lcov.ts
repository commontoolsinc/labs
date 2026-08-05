#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
import * as path from "@std/path";
import { isTrackedSourcePath } from "./coverage-metrics.ts";

// Taken from this file's own location rather than the working directory, which
// the conversion inherits from its caller.
const REPO_ROOT = path.dirname(path.dirname(path.fromFileUrl(import.meta.url)));

/**
 * Normalize per-instance source paths in an LCOV report to their physical
 * file. A handful of tests deliberately import modules with a cache-busting
 * query (`foo.ts?testRun=<uuid>`) to get fresh module-scoped state per test;
 * V8 then reports each such import as a separate script, and
 * `deno coverage --lcov` emits a separate record per instance under the
 * suffixed path. Downstream consumers (the coverage-debt metric, the
 * combined IDE report) must see one record set per physical file — a line is
 * covered when ANY instance executed it — so the suffix is stripped here, at
 * generation, rather than taught to every consumer (CT-1861). Records are
 * left separate; LCOV consumers accumulate duplicate `SF:` sections.
 */
export function normalizeLcovInstancePaths(lcov: string): string {
  return lcov.split(/\r?\n/).map((line) =>
    line.startsWith("SF:") ? `SF:${line.slice(3).split("?")[0]}` : line
  ).join("\n");
}

/**
 * Collect every `.json` coverage profile file under `dir`, descending into
 * subdirectories. A missing directory, including one removed mid-walk, yields
 * an empty result rather than an error.
 *
 * A full local coverage run can leave several hundred thousand profile files
 * under one directory. The walk appends each path to a single shared array, so
 * no step ever passes a several-hundred-thousand-element array to a variadic
 * call such as `push(...items)`; doing so overflows the call stack, because
 * each element becomes a separate argument and V8 caps how many arguments one
 * call takes.
 *
 * `readDir` defaults to `Deno.readDir`; it is a parameter so a test can present
 * a very large directory without creating that many real files.
 */
export async function collectCoverageProfileFiles(
  dir: string,
  readDir: (dir: string) => AsyncIterable<Deno.DirEntry> = Deno.readDir,
): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    try {
      for await (const entry of readDir(current)) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory) {
          await walk(fullPath);
        } else if (entry.name.endsWith(".json")) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  }

  await walk(dir);
  return files;
}

function parseDroppedFiles(stderr: string, message: RegExp): string[] {
  const dropped: string[] = [];
  for (const match of stderr.matchAll(message)) {
    dropped.push(match[1]);
  }
  return dropped;
}

/**
 * The files `deno coverage` left out of the report because the Deno cache holds
 * no transpiled form for them, though their source is still on disk.
 *
 * `deno coverage` builds the report from each covered file's transpiled form in
 * the cache rather than from the source, so a file whose transpiled form is
 * absent is dropped with a warning on stderr. When other files do report, the
 * exit status stays zero and the report carries every one of them, so the loss
 * is invisible to anything reading only the report — and a consumer that scores
 * a file absent from the report as fully uncovered, which the coverage-debt
 * metric does, reads the drop as a coverage regression. The usual cause is a
 * profile collected by one Deno version and reported by another, because the
 * two share a cache directory but read transpiled sources only from their own
 * part of it.
 */
export function parseFilesMissingTranspiledSource(stderr: string): string[] {
  return parseDroppedFiles(
    stderr,
    /^Missing transpiled source code for: "([^"]*)"/gm,
  );
}

/**
 * The files `deno coverage` left out of the report because their source is no
 * longer on disk, which it says with a different message than the one above. A
 * test that compiled a file and then deleted it leaves a profile no report can
 * name, and nothing downstream tracks such a file either.
 */
export function parseFilesWithNoSource(stderr: string): string[] {
  return parseDroppedFiles(stderr, /^Source not found for "([^"]*)"/gm);
}

/**
 * Whether a dropped file costs anything downstream, which is to say whether the
 * coverage-debt metric charges for it. The metric's own predicate decides, so
 * the two cannot drift apart.
 *
 * Anything else is dropped without cost. A file the metric does not track is not
 * part of the measurement at all, and a file outside the repository has an
 * ordinary reason to be missing from the cache the report is built from: the
 * cache key covers the Deno configuration in scope where the file was compiled,
 * so a module a test compiled from a working directory outside the repository is
 * filed under a scope the conversion never looks in. Tests that copy a fixture
 * project into a temporary directory and run Deno there produce exactly that.
 */
export function isTrackedFile(url: string, repositoryRoot: string): boolean {
  let filePath: string;
  try {
    filePath = path.fromFileUrl(url);
  } catch {
    // A specifier naming no local file — an http or data URL — is never tracked.
    return false;
  }
  if (!filePath.startsWith(`${repositoryRoot}${path.SEPARATOR}`)) return false;
  return isTrackedSourcePath(path.relative(repositoryRoot, filePath));
}

async function removeEmptyCoverageProfiles(files: string[]): Promise<number> {
  let removed = 0;
  for (const file of files) {
    const info = await Deno.stat(file);
    if (info.size > 0) continue;
    await Deno.remove(file);
    removed++;
  }
  return removed;
}

async function writeEmptyLcovFile(outputPath: string): Promise<void> {
  await Deno.mkdir(path.dirname(outputPath), { recursive: true });
  await Deno.writeTextFile(outputPath, "");
}

async function writeEmptyLcov(
  outputPath: string,
  reason: string,
): Promise<void> {
  await writeEmptyLcovFile(outputPath);
  console.warn(`${reason}; wrote empty LCOV report to ${outputPath}.`);
}

async function main(): Promise<void> {
  const [profileDir, outputPath] = Deno.args;
  if (!profileDir || !outputPath) {
    console.error(
      "Usage: deno run --allow-read --allow-write --allow-run tasks/write-coverage-lcov.ts <profile-dir> <output.lcov>",
    );
    Deno.exit(2);
  }

  const profileFiles = await collectCoverageProfileFiles(profileDir);
  if (profileFiles.length === 0) {
    await writeEmptyLcov(
      outputPath,
      `No coverage profile files found in ${profileDir}`,
    );
    return;
  }

  const removedEmptyProfiles = await removeEmptyCoverageProfiles(profileFiles);
  if (removedEmptyProfiles > 0) {
    console.warn(
      `Removed ${removedEmptyProfiles} empty coverage profile file(s) from ${profileDir}.`,
    );
  }

  const remainingProfileFiles = await collectCoverageProfileFiles(profileDir);
  if (remainingProfileFiles.length === 0) {
    await writeEmptyLcov(
      outputPath,
      `No non-empty coverage profile files remain in ${profileDir}`,
    );
    return;
  }

  await Deno.mkdir(path.dirname(outputPath), { recursive: true });
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["coverage", "--lcov", `--output=${outputPath}`, profileDir],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(result.stderr);

  const missingTranspiled = parseFilesMissingTranspiledSource(stderr);
  const lost = missingTranspiled.filter((url) => isTrackedFile(url, REPO_ROOT));
  const untracked = [
    ...missingTranspiled.filter((url) => !isTrackedFile(url, REPO_ROOT)),
    ...parseFilesWithNoSource(stderr),
  ];
  if (untracked.length > 0) {
    console.warn(
      `deno coverage left ${untracked.length} file(s) out of the report that it tracks nothing for:\n  ${
        untracked.join("\n  ")
      }`,
    );
  }

  const reportLostFiles = () => {
    console.error(
      `deno coverage left ${lost.length} tracked file(s) out of ${outputPath}:\n  ${
        lost.join("\n  ")
      }`,
    );
    console.error(
      "Every line of those files reads as uncovered downstream. They are missing from the Deno cache the report is built from, which happens when the profiles were collected under a different Deno version, or from a working directory under a different Deno configuration, than the one reporting them.",
    );
  };

  if (!result.success) {
    // An output file is left behind whatever the outcome, so a caller that
    // collects the report as a build artifact still finds one to collect and
    // reads the outcome from this step.
    await writeEmptyLcovFile(outputPath);

    // `deno coverage` leaves test files out of a report by design, so profiles
    // covering nothing else convert to nothing and it calls that an error. With
    // no tracked file lost, nothing downstream is charged for the emptiness, so
    // it is honest.
    if (
      lost.length === 0 &&
      stderr.includes("No covered files included in the report")
    ) {
      console.warn(
        `deno coverage found nothing to report in ${profileDir}; wrote empty LCOV report to ${outputPath}.`,
      );
      return;
    }

    console.error(
      `deno coverage failed to convert the ${remainingProfileFiles.length} coverage profile file(s) in ${profileDir}; wrote empty LCOV report to ${outputPath}.`,
    );
    if (lost.length > 0) reportLostFiles();
    console.error(stderr.trim());
    Deno.exit(1);
  }

  await Deno.writeTextFile(
    outputPath,
    normalizeLcovInstancePaths(await Deno.readTextFile(outputPath)),
  );

  // The report of everything that did convert is on disk either way, so it can
  // be read while a loss is diagnosed. Only a run that lost nothing says so.
  if (lost.length > 0) {
    console.error(`Wrote the LCOV report that did convert to ${outputPath}.`);
    reportLostFiles();
    Deno.exit(1);
  }

  console.log(`Wrote LCOV coverage report to ${outputPath}`);
}

if (import.meta.main) {
  await main();
}
