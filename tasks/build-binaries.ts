#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import { exists } from "@std/fs";
import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  computeCompilerVersion,
  renderVersionModule,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";

export interface BuildConfigInitializer {
  root: string;
  toolshedFlags: string[];
  cliOnly?: boolean;
}

export class BuildConfig {
  readonly root: string;
  readonly toolshedFlags: string[];
  readonly cliOnly: boolean;
  private _manifestOriginal: string;
  private _compileCacheVersionOriginal: string;

  constructor(options: BuildConfigInitializer) {
    this.root = options.root;
    this.toolshedFlags = options.toolshedFlags;
    this.cliOnly = !!options.cliOnly;
    this._manifestOriginal = Deno.readTextFileSync(
      this.workspaceManifestPath(),
    );
    this._compileCacheVersionOriginal = Deno.readTextFileSync(
      this.compileCacheVersionPath(),
    );
  }

  private path(...args: string[]): string {
    return path.join(this.root, ...args);
  }

  // A fresh, mutable copy of the workspace manifest, parsed from its original
  // bytes. The build mutates this copy; the original bytes stay untouched so
  // the revert can restore the file exactly.
  manifest(): Record<string, any> {
    return parseJsonc(this._manifestOriginal) as Record<string, any>;
  }

  manifestOriginal() {
    return this._manifestOriginal;
  }

  compileCacheVersionOriginal() {
    return this._compileCacheVersionOriginal;
  }

  workspaceManifestPath() {
    return this.path("deno.jsonc");
  }

  compileCacheVersionPath() {
    return this.path(
      "packages",
      "runner",
      "src",
      "compilation-cache",
      "compile-cache-version.ts",
    );
  }

  workspaceLockPath() {
    return this.path("deno.lock");
  }

  shellProjectPath() {
    return this.path("packages", "shell");
  }

  shellOutPath() {
    return this.path("packages", "shell", "dist");
  }

  toolshedProjectPath() {
    return this.path("packages", "toolshed");
  }

  toolshedShellFrontendPath() {
    return this.path("packages", "toolshed", "shell-frontend");
  }

  toolshedShellFrontendPathDev() {
    return this.path("packages", "toolshed", "shell-frontend-dev");
  }

  toolshedEntryPath() {
    return this.path("packages", "toolshed", "index.ts");
  }

  bgPieceServiceEntryPath() {
    return this.path("packages", "background-piece-service", "src", "main.ts");
  }

  bgPieceServiceWorkerPath() {
    return this.path(
      "packages",
      "background-piece-service",
      "src",
      "worker.ts",
    );
  }

  toolshedEnvPath() {
    return this.path("packages", "toolshed", "COMPILED");
  }

  staticAssetsPath() {
    return this.path("packages", "static", "assets");
  }

  patternsPath() {
    return this.path("packages", "patterns");
  }

  staticTypesPath() {
    return this.path("packages", "static", "assets", "types");
  }

  docsCommonPath() {
    return this.path("docs", "common");
  }

  cliEntryPath() {
    return this.path("packages", "cli", "mod.ts");
  }

  cliMultiUserTestWorkerPath() {
    return this.path("packages", "cli", "lib", "multi-user-test-worker.ts");
  }

  fusePackagePath() {
    return this.path("packages", "fuse");
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

    if (!config.cliOnly) await buildShell(config);
    await prepareWorkspace(config);
    if (!config.cliOnly) await buildToolshed(config);
    if (!config.cliOnly) await buildBgPieceService(config);
    await buildCli(config);
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

async function buildShell(config: BuildConfig): Promise<void> {
  for (const mode of ["development", "production"]) {
    console.log(`Building shell app in ${mode}...`);
    const task = mode === "production" ? "production" : "build";
    const toolshedShellFrontend = mode === "production"
      ? config.toolshedShellFrontendPath()
      : config.toolshedShellFrontendPathDev();
    const { success } = await new Deno.Command(Deno.execPath(), {
      args: [
        "task",
        task,
      ],
      cwd: config.shellProjectPath(),
      stdout: "inherit",
      stderr: "inherit",
      env: {
        COMMIT_SHA: Deno.env.get("COMMIT_SHA") || mode,
      },
    }).output();
    if (!success) {
      throw new Error("Failed to build shell app");
    }

    // Shell now serves at root path
    console.log(`Shell app ${mode} built for root path`);

    const shellOut = config.shellOutPath();
    if ((await exists(toolshedShellFrontend))) {
      await Deno.remove(toolshedShellFrontend, { recursive: true });
    }
    await Deno.rename(shellOut, toolshedShellFrontend);
  }
  console.log("Shell app built successfully");
}

async function buildToolshed(config: BuildConfig): Promise<void> {
  console.log("Building toolshed binary...");
  const { success } = await new Deno.Command(Deno.execPath(), {
    env: {
      OTEL_DENO: "true",
    },
    args: [
      ...lockedCompileArgs(config),
      // Run `--no-check` here, as the `--include`'d
      // `es2023.d.ts` file will attempt to be checked
      // as a non-static asset. Checking should be done
      // prior to building.
      "--no-check",
      "--unstable-otel",
      "--output",
      config.distPath("toolshed"),
      "--include",
      config.toolshedShellFrontendPath(),
      "--include",
      config.toolshedShellFrontendPathDev(),
      "--include",
      config.toolshedEnvPath(),
      "--include",
      config.staticAssetsPath(),
      "--include",
      config.patternsPath(),
      ...config.toolshedFlags,
      config.toolshedEntryPath(),
    ],
    cwd: config.toolshedProjectPath(),
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    throw new Error("Failed to build toolshed binary");
  }
  console.log("Toolshed binary built successfully");
}

async function buildBgPieceService(config: BuildConfig): Promise<void> {
  console.log("Building background piece service binary...");
  const { success } = await new Deno.Command(Deno.execPath(), {
    args: [
      ...lockedCompileArgs(config),
      // Run `--no-check` here, as the `--include`'d
      // `es2023.d.ts` file will attempt to be checked
      // as a non-static asset. Checking should be done
      // prior to building.
      "--no-check",
      "--output",
      config.distPath("bg-piece-service"),
      "--include",
      config.bgPieceServiceWorkerPath(),
      "--include",
      config.staticAssetsPath(),
      "-A", // All permissions
      "--unstable-worker-options", // Required by bg-piece-service
      config.bgPieceServiceEntryPath(),
    ],
    cwd: config.root,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    throw new Error("Failed to build background piece service binary");
  }
  console.log("Background piece service binary built successfully");
}

async function buildCli(config: BuildConfig): Promise<void> {
  console.log("Building CLI binary...");
  // Figure out the full list requested by typescript and
  // friends
  // Globs don't work for compile(?)
  const _envs = [
    "API_URL",
    "TSC_WATCHFILE",
    "TSC_NONPOLLING_WATCHER",
    "TSC_WATCHDIRECTORY",
    "TSC_WATCH_POLLINGINTERVAL_LOW",
    "TSC_WATCH_POLLINGINTERVAL_MEDIUM",
    "TSC_WATCH_POLLINGINTERVAL_HIGH",
    "TSC_WATCH_POLLINGCHUNKSIZE_LOW",
    "TSC_WATCH_POLLINGCHUNKSIZE_MEDIUM",
    "TSC_WATCH_POLLINGCHUNKSIZE_HIGH",
    "TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_LOW",
    "TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_MEDIUM",
    "TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_HIGH",
    "NODE_INSPECTOR_IPC",
    "VSCODE_INSPECTOR_OPTIONS",
    "NODE_ENV",
    // sqlite3 library requires these
    "DENO_SQLITE_PATH",
    "DENO_SQLITE_LOCAL",
    "DENO_DIR",
    "HOME",
    "XDG_CACHE_HOME",
  ];
  const { success } = await new Deno.Command(Deno.execPath(), {
    args: [
      ...lockedCompileArgs(config),
      "--output",
      config.distPath("cf"),
      // Run `--no-check` here, as the `--include`'d
      // `es2023.d.ts` file will attempt to be checked
      // as a non-static asset. Checking should be done
      // prior to building.
      "--no-check",
      "--allow-write",
      "--allow-read",
      "--allow-env",
      "--allow-run",
      "--allow-ffi", // for @db/sqlite
      "--allow-net", // for @db/sqlite lazy download
      "--include",
      config.staticTypesPath(),
      "--include",
      config.docsCommonPath(),
      "--include",
      config.fusePackagePath(),
      // Worker module spawned by cf test's multi-user mode — workers are not
      // followed by compile's static analysis, so include it explicitly.
      "--include",
      config.cliMultiUserTestWorkerPath(),
      config.cliEntryPath(),
    ],
    cwd: config.root,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    throw new Error("Failed to build CLI binary");
  }
  console.log("CLI binary built successfully");
}

function lockedCompileArgs(config: BuildConfig): string[] {
  // Keep compiled binaries on the same resolved dependency graph as normal
  // install/test flows, even when compile runs from a package cwd.
  return [
    "compile",
    "--lock",
    config.workspaceLockPath(),
    "--frozen=true",
  ];
}

// Some frontend types in the workspace manifest
// must be removed from the compiler options
// that do not work with toolshed.
export async function prepareWorkspace(
  config: BuildConfig,
): Promise<void> {
  const denoJsonPath = config.workspaceManifestPath();

  if (!(await exists(config.workspaceLockPath()))) {
    throw new Error(
      `Cannot build binaries without ${config.workspaceLockPath()}`,
    );
  }

  // Write the current compile-cache version before compiling binaries. The value
  // is computed before `deno.jsonc` changes so it reflects the committed
  // compiler options.
  const compileCacheVersion = await computeCompilerVersion(config.root);
  await Deno.writeTextFile(
    config.compileCacheVersionPath(),
    renderVersionModule(compileCacheVersion),
  );

  // Remove `compilerOptions.types`
  const manifest = config.manifest();
  delete manifest.compilerOptions.types;
  await Deno.writeTextFile(
    denoJsonPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  // Write build metadata into the COMPILED file. Included via `--include`
  // when the toolshed binary is compiled, so the values travel with the
  // artifact and can be read at runtime (see packages/toolshed/lib/build-info.ts).
  const buildInfo = {
    commitSha: Deno.env.get("COMMIT_SHA") ?? "",
    builtAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    config.toolshedEnvPath(),
    JSON.stringify(buildInfo, null, 2) + "\n",
  );
}

export async function revertWorkspace(config: BuildConfig): Promise<void> {
  const denoJsonPath = config.workspaceManifestPath();
  const toolshedEnvPath = config.toolshedEnvPath();

  // Restore the workspace manifest from its original bytes, keeping any
  // comments and formatting intact.
  await Deno.writeTextFile(denoJsonPath, config.manifestOriginal());

  // Restore the checked-in compile-cache version module.
  await Deno.writeTextFile(
    config.compileCacheVersionPath(),
    config.compileCacheVersionOriginal(),
  );

  // Remove the COMPILED env file
  if ((await exists(toolshedEnvPath))) {
    await Deno.remove(toolshedEnvPath);
  }
}

// Only run the build when invoked directly (`deno task build-binaries`), not
// when imported by tests, which exercise BuildConfig / prepareWorkspace /
// revertWorkspace against a temporary tree.
if (import.meta.main) {
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
    cliOnly: Deno.args.includes("--cli-only"),
  });

  Deno.addSignalListener("SIGINT", async () => {
    await revertWorkspace(config);
  });

  await build(config);
}
