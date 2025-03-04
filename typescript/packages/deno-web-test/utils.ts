import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import * as path from "@std/path";
import { Manifest } from "./manifest.ts";
import { Summary, TestFileResults } from "./interface.ts";

export const tsToJs = (path: string): string => path.replace(/\.ts$/, ".js");

export const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

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
    await bundle(input, output);
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

export async function bundle(inputPath: string, outputPath: string) {
  const _ = await esbuild.build({
    plugins: [...denoPlugins()],
    entryPoints: [inputPath],
    outfile: outputPath,
    bundle: true,
    format: "esm",
  });

  esbuild.stop();
}

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
