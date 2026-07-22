import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";

export interface DenoCommandWithTemporaryLockOptions {
  root: string;
  cwd?: string;
  args: (lockPath: string) => string[];
  env?: Record<string, string>;
}

export interface DenoCheckWithTemporaryConfigOptions {
  root: string;
  /**
   * A copy of the root config with the same workspace dependency graph.
   * Compiler options may differ for the check.
   */
  config: unknown;
  files: string[];
  tempConfigPrefix: string;
}

// Read and parse a Deno config file (`deno.json` / `deno.jsonc`) with the JSONC
// parser, so a config that carries comments is read correctly.
export async function readDenoConfig(
  path: string,
): Promise<Record<string, any>> {
  return parseJsonc(await Deno.readTextFile(path)) as Record<string, any>;
}

async function removeIfPresent(path: string, options?: Deno.RemoveOptions) {
  try {
    await Deno.remove(path, options);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

export async function runDenoCommandWithTemporaryLock(
  options: DenoCommandWithTemporaryLockOptions,
): Promise<Deno.CommandOutput> {
  const tempDir = await Deno.makeTempDir({
    prefix: "commonfabric-deno-lock-",
  });
  const tempLock = join(tempDir, "deno.lock");

  try {
    await Deno.copyFile(join(options.root, "deno.lock"), tempLock);
    const commandOptions: Deno.CommandOptions = {
      cwd: options.cwd ?? options.root,
      args: options.args(tempLock),
      stdout: "piped",
      stderr: "piped",
    };
    if (options.env) {
      commandOptions.env = options.env;
    }
    // Invoke through the command name so package tasks can grant only
    // `--allow-run=deno`. `Deno.execPath()` resolves Homebrew-style symlinks to
    // a versioned absolute path, which cannot be named portably in the task.
    return await new Deno.Command("deno", commandOptions).output();
  } finally {
    await removeIfPresent(tempDir, { recursive: true });
  }
}

export async function runDenoCheckWithTemporaryConfig(
  options: DenoCheckWithTemporaryConfigOptions,
): Promise<Deno.CommandOutput> {
  const safePrefix = options.tempConfigPrefix.replaceAll(
    /[^a-zA-Z0-9._-]/g,
    "-",
  );
  const tempConfig = join(
    options.root,
    `.${safePrefix}.${Deno.pid}.${crypto.randomUUID()}.json`,
  );

  try {
    await Deno.writeTextFile(
      tempConfig,
      JSON.stringify(options.config, null, 2),
    );

    return await runDenoCommandWithTemporaryLock({
      root: options.root,
      cwd: options.root,
      args: (tempLock) => [
        "check",
        "--config",
        tempConfig,
        "--lock",
        tempLock,
        // Verification uses the dependency graph pinned by the checked-in lock.
        "--frozen=true",
        ...options.files,
      ],
    });
  } finally {
    await removeIfPresent(tempConfig);
  }
}
