import { isAbsolute, join } from "@std/path";

export function absPath(relpath: string, cwd = Deno.cwd()): string {
  // TODO(js): homedir check is not cross platform
  if (isAbsolute(relpath) || relpath[0] === "~") {
    // Do not join a home dir or absolute path
    return relpath;
  }
  return join(cwd, relpath);
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
            `(e.g., an EXPERIMENTAL_* option enabled on the server but not the CLI). ` +
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
