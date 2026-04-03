import { isAbsolute, join } from "@std/path";
import type { ExperimentalOptions } from "@commonfabric/runner";
import { cliName } from "./cli-name.ts";

export function absPath(relpath: string, cwd = Deno.cwd()): string {
  // TODO(js): homedir check is not cross platform
  if (isAbsolute(relpath) || relpath[0] === "~") {
    // Do not join a home dir or absolute path
    return relpath;
  }
  return join(cwd, relpath);
}

/**
 * Read EXPERIMENTAL_* env vars and return an ExperimentalOptions object.
 * Mirrors the same env var names used by toolshed (env.ts) and shell
 * (felt.config.ts) so all three share one source of truth.
 */
export function experimentalOptionsFromEnv(): ExperimentalOptions {
  const read = (name: string) => Deno.env.get(name) === "true";
  const opts: ExperimentalOptions = {
    modernDataModel: read("EXPERIMENTAL_MODERN_DATA_MODEL"),
    unifiedJsonEncoding: read("EXPERIMENTAL_UNIFIED_JSON_ENCODING"),
    modernHash: read("EXPERIMENTAL_MODERN_HASH"),
    modernSchemaHash: read("EXPERIMENTAL_MODERN_SCHEMA_HASH"),
  };
  const active = Object.entries(opts).filter(([, v]) => v);
  if (active.length > 0) {
    console.error(
      `[${cliName()}] Experimental flags: ${active.map(([k]) => k).join(", ")}`,
    );
  }
  return opts;
}

const SYNC_TIMEOUT_MS = 30_000;

/**
 * Await a `synced()` promise with a timeout. If sync takes too long,
 * throw with an actionable error message instead of hanging silently.
 */
export async function awaitSyncWithTimeout(
  syncPromise: Promise<void>,
  timeoutMs: number = SYNC_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Sync timed out after ${timeoutMs / 1000}s. ` +
            `This often indicates a client/server configuration mismatch ` +
            `(e.g., EXPERIMENTAL_MODERN_HASH enabled on the server but not the CLI). ` +
            `Check toolshed logs for AuthorizationError details.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([syncPromise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
