#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
import * as path from "@std/path";

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

  console.log(`Wrote LCOV coverage report to ${outputPath}`);
}

if (import.meta.main) {
  await main();
}
