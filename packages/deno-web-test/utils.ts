import * as path from "@std/path";
import { Manifest } from "./manifest.ts";
import { Summary, TestFileResults } from "./interface.ts";
import { build } from "@commontools/felt";

export const tsToJs = (path: string): string => path.replace(/\.ts$/, ".js");

// Given a `Manifest`, moves harness code and bundled
// tests to the manifest's `serverDir`.
export const buildTestDir = async (manifest: Manifest) => {
  // Bundle all tests and move to server root.
  for (const testPath of manifest.tests) {
    const input = path.join(manifest.projectDir, testPath);
    const output = path.join(
      manifest.serverDir,
      "dist",
      tsToJs(testPath),
    );

    await build(Object.assign({
      entryPoints: [input],
      outfile: output,
    }, manifest.config.esbuildConfig ?? {}));
  }

  // Bundle all extra includes and move to server root.
  for (
    const [filepath, outpath] of Object.entries(manifest.config.include ?? {})
  ) {
    const input = path.join(manifest.projectDir, filepath);
    const output = path.join(
      manifest.serverDir,
      outpath,
    );
    await copy(input, output);
  }

  // Deploy harness files to server root.
  if (!import.meta.dirname) {
    throw new Error("Cannot resolve local dirname");
  }
  const harnessDir = path.join(import.meta.dirname, "harness");
  for await (const { name } of Deno.readDir(harnessDir)) {
    await Deno.copyFile(
      path.join(harnessDir, name),
      path.join(manifest.serverDir, name),
    );
  }
};

export function summarize(results: TestFileResults[]): Summary {
  let passed = 0;
  let duration = 0;
  const failed = [];
  for (const fileResults of results) {
    for (const result of fileResults.tests) {
      duration += result.duration;
      if (result.error) {
        failed.push(result);
      } else {
        passed++;
      }
    }
  }
  return { passed, duration, failed };
}

// Use this instead of `@std/fs#copy`, because we want to copy resolved
// symlinks, not the symlinks themselves.
async function copy(src: string, dest: string): Promise<void> {
  const stat = await Deno.lstat(src);

  if (stat.isSymlink) {
    const realPath = await Deno.realPath(src);
    const realStat = await Deno.stat(realPath);
    if (realStat.isDirectory) {
      await copyDir(realPath, dest);
    } else {
      await Deno.copyFile(realPath, dest);
    }
  } else if (stat.isDirectory) {
    await copyDir(src, dest);
  } else {
    await Deno.copyFile(src, dest);
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });

  for await (const entry of Deno.readDir(src)) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    await copy(srcPath, destPath);
  }
}
