#!/usr/bin/env -S deno run -A

import { dirname, join, resolve } from "@std/path";
import { findFfmpeg } from "@commonfabric/integration";
import { findIntegrationTestFiles } from "./integration.ts";

export type DemoOptions = {
  packageName: "patterns" | "shell";
  filter: string;
  outputPath?: string;
  keepFrames: boolean;
  portOffset?: number;
  viewport?: string;
};

export type DemoDependencies = {
  now(): Date;
  preflight(): Promise<void>;
  runIntegration(
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ success: boolean; code: number }>;
};

export const defaultDependencies: DemoDependencies = {
  now: () => new Date(),
  preflight: async () => {
    await findFfmpeg();
  },
  runIntegration: async (args, cwd, env) =>
    await new Deno.Command(Deno.execPath(), {
      args,
      cwd,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status,
};

export function parseDemoArgs(args: string[]): DemoOptions {
  const positional: string[] = [];
  let outputPath: string | undefined;
  let keepFrames = false;
  let portOffset: number | undefined;
  let viewport: string | undefined;
  for (const arg of args) {
    if (arg === "--keep-frames") keepFrames = true;
    else if (arg.startsWith("--output=")) outputPath = arg.slice(9);
    else if (arg.startsWith("--port-offset=")) {
      portOffset = Number(arg.slice(14));
      if (!Number.isInteger(portOffset) || portOffset < 0) {
        throw new Error(`invalid --port-offset: ${arg}`);
      }
    } else if (arg.startsWith("--viewport=")) viewport = arg.slice(11);
    else if (arg === "--help" || arg === "-h") throw new HelpRequested();
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2) {
    throw new Error(
      "usage: deno task demo <patterns|shell> <test-file-filter>",
    );
  }
  const packageName = positional[0];
  if (packageName !== "patterns" && packageName !== "shell") {
    throw new Error(`unsupported browser-test package: ${packageName}`);
  }
  return {
    packageName,
    filter: positional[1],
    outputPath,
    keepFrames,
    portOffset,
    viewport,
  };
}

export async function resolveDemoTest(
  rootDir: string,
  options: DemoOptions,
): Promise<string> {
  const integrationDir = join(
    rootDir,
    "packages",
    options.packageName,
    "integration",
  );
  const matches = await findIntegrationTestFiles(
    integrationDir,
    options.filter,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `no ${options.packageName} integration test matches "${options.filter}"`
        : `demo filter "${options.filter}" is ambiguous: ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

export async function runDemo(
  options: DemoOptions,
  rootDir = Deno.cwd(),
  dependencies: DemoDependencies = defaultDependencies,
): Promise<number> {
  const testFile = await resolveDemoTest(rootDir, options);
  const testName = testFile.replace(/\.test\.ts$/, "");
  await dependencies.preflight();
  const stamp = dependencies.now().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(
    rootDir,
    "tmp",
    "demos",
    `${options.packageName}-${testName}-${stamp}`,
  );
  await Deno.mkdir(runDir, { recursive: true });
  const integrationArgs = ["task", "integration"];
  if (options.portOffset !== undefined) {
    integrationArgs.push(`--port-offset=${options.portOffset}`);
  }
  integrationArgs.push(options.packageName, options.filter);
  const env = {
    ...Deno.env.toObject(),
    HEADLESS: "1",
    CF_DEMO_OUTPUT_DIR: runDir,
    CF_DEMO_NAME: testName,
    ...(options.keepFrames ? { CF_DEMO_KEEP_FRAMES: "1" } : {}),
    ...(options.viewport ? { CF_DEMO_VIEWPORT: options.viewport } : {}),
  };
  console.log(`Recording ${options.packageName}/${testFile}`);
  console.log(`Demo artifacts: ${runDir}`);
  const status = await dependencies.runIntegration(
    integrationArgs,
    rootDir,
    env,
  );
  if (!status.success) {
    const manifestPath = join(runDir, "manifest.json");
    try {
      const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
      if (manifest.status === "passed" || manifest.status === "recording") {
        manifest.status = "test-failed";
        manifest.error = `integration test exited with code ${status.code}`;
        await Deno.writeTextFile(
          manifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
      }
    } catch {
      // A setup failure may occur before presentation mode creates a manifest.
    }
    console.error(`Demo test failed; diagnostics retained at ${runDir}`);
    return status.code;
  }

  const generatedVideo = join(runDir, `${testName}.mp4`);
  try {
    await Deno.stat(generatedVideo);
  } catch (cause) {
    throw new Error(`the test passed but did not produce ${testName}.mp4`, {
      cause,
    });
  }
  let finalPath = generatedVideo;
  if (options.outputPath) {
    finalPath = resolve(rootDir, options.outputPath);
    await Deno.mkdir(dirname(finalPath), { recursive: true });
    await Deno.copyFile(generatedVideo, finalPath);
  }
  console.log(`Demo video: ${finalPath}`);
  return 0;
}

class HelpRequested extends Error {}

function printHelp(): void {
  console.log(`Integration-test video demo

Usage:
  deno task demo <patterns|shell> <test-file-filter> [options]

Options:
  --output=PATH       Copy the final MP4 to PATH
  --keep-frames       Retain JPEG frames and FFconcat inputs
  --viewport=WxH      Source viewport (default 1280x720)
  --port-offset=N     Reuse an explicit local-dev port offset
`);
}

export async function main(
  args: string[],
  run: (options: DemoOptions) => Promise<number> = runDemo,
): Promise<number> {
  try {
    return await run(parseDemoArgs(args));
  } catch (error) {
    if (error instanceof HelpRequested) {
      printHelp();
      return 0;
    }
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

if (import.meta.main) Deno.exitCode = await main(Deno.args);
