#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
import * as path from "@std/path";

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

async function collectCoverageProfileFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory) {
        files.push(...await collectCoverageProfileFiles(fullPath));
      } else if (entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  return files;
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

async function writeEmptyLcov(
  outputPath: string,
  reason: string,
): Promise<void> {
  await Deno.mkdir(path.dirname(outputPath), { recursive: true });
  await Deno.writeTextFile(outputPath, "");
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

  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    if (stderr.includes("No covered files included in the report")) {
      await writeEmptyLcov(
        outputPath,
        `No reportable covered files found in ${profileDir}`,
      );
      return;
    }
    throw new Error(`deno coverage failed: ${stderr.trim()}`);
  }

  await Deno.writeTextFile(
    outputPath,
    normalizeLcovInstancePaths(await Deno.readTextFile(outputPath)),
  );

  console.log(`Wrote LCOV coverage report to ${outputPath}`);
}

if (import.meta.main) {
  await main();
}
