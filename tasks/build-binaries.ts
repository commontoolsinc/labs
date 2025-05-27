#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import { assets, cache as staticCache } from "@commontools/static";
import { exists } from "@std/fs";
import * as path from "@std/path";

interface BuildConfigInitializer {
  root: string;
  toolshedFlags: string[];
}

class BuildConfig {
  readonly root: string;
  readonly toolshedFlags: string[];
  private _manifest: object;

  constructor(options: BuildConfigInitializer) {
    this.root = options.root;
    this.toolshedFlags = options.toolshedFlags;
    this._manifest = JSON.parse(
      Deno.readTextFileSync(this.workspaceManifestPath()),
    );
  }

  private path(...args: string[]): string {
    return path.join(this.root, ...args);
  }

  manifest() {
    return JSON.parse(JSON.stringify(this._manifest));
  }

  workspaceManifestPath() {
    return this.path("deno.json");
  }

  workspaceLockPath() {
    return this.path("deno.lock");
  }

  workspaceTempLockPath() {
    return this.path("_deno.lock");
  }

  jumbleProjectPath() {
    return this.path("packages", "jumble");
  }

  jumbleOutPath() {
    return this.path("packages", "jumble", "dist");
  }

  toolshedProjectPath() {
    return this.path("packages", "toolshed");
  }

  toolshedFrontendPath() {
    return this.path("packages", "toolshed", "jumble-frontend");
  }

  toolshedEntryPath() {
    return this.path("packages", "toolshed", "index.ts");
  }

  bgCharmServiceEntryPath() {
    return this.path("packages", "background-charm-service", "src", "main.ts");
  }

  bgCharmServiceWorkerPath() {
    return this.path("packages", "background-charm-service", "src", "worker.ts");
  }

  toolshedEnvPath() {
    return this.path("packages", "toolshed", "COMPILED");
  }

  staticAssetsPath() {
    return this.path("packages", "static", "assets");
  }

  distDir() {
    return this.path("dist");
  }

  distPath(binary: string) {
    return this.path("dist", binary);
  }
}

async function build(config: BuildConfig): Promise<void> {
  let buildError: Error | void;
  try {
    // Ensure dist directory exists
    await ensureDistDir(config);

    // Build jumble first, do not remove deno.lock
    // until after this.
    await buildJumble(config);
    await prepareWorkspace(config);
    await buildToolshed(config);
    await buildBgCharmService(config);
  } catch (e: unknown) {
    buildError = e as Error;
  }
  await revertWorkspace(config);
  // @ts-ignore This is used after being assigned.
  if (buildError) {
    throw buildError;
  }
}

async function ensureDistDir(config: BuildConfig): Promise<void> {
  const distDir = config.distDir();
  if (!(await exists(distDir))) {
    await Deno.mkdir(distDir, { recursive: true });
  }
}

async function buildJumble(config: BuildConfig): Promise<void> {
  const { success } = await new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "build",
    ],
    cwd: config.jumbleProjectPath(),
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    Deno.exit(1);
    return;
  }

  // Move built jumble into toolshed so that the relative
  // path to the frontend in compiled code is within toolshed
  // https://docs.deno.com/runtime/reference/cli/compile/#including-data-files-or-directories
  const jumbleOut = config.jumbleOutPath();
  const toolshedFrontend = config.toolshedFrontendPath();
  if ((await exists(toolshedFrontend))) {
    await Deno.remove(toolshedFrontend, { recursive: true });
  }
  await Deno.rename(jumbleOut, toolshedFrontend);
}

async function buildToolshed(config: BuildConfig): Promise<void> {
  console.log("Building toolshed binary...");
  const { success } = await new Deno.Command(Deno.execPath(), {
    env: {
      OTEL_DENO: "true",
    },
    args: [
      "compile",
      "--unstable-otel",
      "--output",
      config.distPath("toolshed"),
      "--include",
      config.toolshedFrontendPath(),
      "--include",
      config.toolshedEnvPath(),
      "--include",
      config.staticAssetsPath(),
      ...config.toolshedFlags,
      config.toolshedEntryPath(),
    ],
    cwd: config.toolshedProjectPath(),
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    console.error("Failed to build toolshed binary");
    Deno.exit(1);
  }
  console.log("Toolshed binary built successfully");
}

async function buildBgCharmService(config: BuildConfig): Promise<void> {
  console.log("Building background charm service binary...");
  const { success } = await new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--output",
      config.distPath("bg-charm-service"),
      "--include",
      config.bgCharmServiceWorkerPath(),
      "--include",
      config.staticAssetsPath(),
      "-A", // All permissions
      "--unstable-worker-options", // Required by bg-charm-service
      config.bgCharmServiceEntryPath(),
    ],
    cwd: config.root,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    console.error("Failed to build background charm service binary");
    Deno.exit(1);
  }
  console.log("Background charm service binary built successfully");
}

// `deno compile` appears to bundle *all* workspace
// dependencies e.g. dev dependencies. We can sidestep
// this by removing the lock file, and only calling compile
// from `toolshed`, not the project root.
// https://github.com/denoland/deno/issues/21504
//
// Additionally, we have some frontend types that
// must be removed from the compiler options
// that do not work with toolshed.
async function prepareWorkspace(
  config: BuildConfig,
): Promise<void> {
  const denoJsonPath = config.workspaceManifestPath();
  const denoLockPath = config.workspaceLockPath();
  const denoTempLockPath = config.workspaceTempLockPath();

  // "Remove" the lock file
  await Deno.rename(denoLockPath, denoTempLockPath);
  // Remove `compilerOptions.types`
  const manifest = config.manifest();
  delete manifest.compilerOptions.types;
  await Deno.writeTextFile(denoJsonPath, JSON.stringify(manifest, null, 2));
  // Add a COMPILED file to toolshed. This could
  // contain buildargs/metadata in the future.
  await Deno.writeTextFile(config.toolshedEnvPath(), "");
}

async function revertWorkspace(config: BuildConfig): Promise<void> {
  const denoJsonPath = config.workspaceManifestPath();
  const denoLockPath = config.workspaceLockPath();
  const denoTempLockPath = config.workspaceTempLockPath();
  const toolshedEnvPath = config.toolshedEnvPath();

  // Move temp lock file back
  if ((await exists(denoTempLockPath))) {
    await Deno.rename(
      denoTempLockPath,
      denoLockPath,
    );
  }

  // Restore the workspace manifest
  await Deno.writeTextFile(
    denoJsonPath,
    JSON.stringify(config.manifest(), null, 2),
  );

  // Remove the COMPILED env file
  if ((await exists(toolshedEnvPath))) {
    await Deno.remove(toolshedEnvPath);
  }
}

const config = new BuildConfig({
  root: Deno.cwd(),
  toolshedFlags: [
    "--allow-env",
    "--allow-sys",
    "--allow-read",
    "--allow-ffi",
    "--allow-net",
    "--allow-write",
  ],
});

Deno.addSignalListener("SIGINT", async () => {
  await revertWorkspace(config);
});

await build(config);
