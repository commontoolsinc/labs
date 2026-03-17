/**
 * Compute a fingerprint for server-side compilation cache invalidation.
 *
 * **Server-only.** Requires Deno APIs. In the browser, use
 * `InitializationData.buildHash` (the worker bundle hash) instead.
 *
 * Priority:
 * 1. `explicitSha` (e.g. `TOOLSHED_GIT_SHA` env var) — returned as-is.
 *    Used in Docker / binary deployments where the operator declares the
 *    deployed commit.
 * 2. Clean git repo — returns HEAD SHA as-is.
 * 3. Dirty git repo — returns `sha256(head + contentHash)` (opaque, since
 *    it combines HEAD with dirty file contents).
 * 4. Returns `undefined` — no fingerprint available, cache should be disabled.
 *
 * In production and clean-tree scenarios (1, 2) the fingerprint is a
 * recognizable commit SHA, useful for tracing which server version compiled
 * a cached entry. Only during active local editing (3) is it an opaque hash.
 *
 * See docs/specs/compilation-cache.md for design rationale.
 */
export async function computeGitFingerprint(
  explicitSha?: string,
): Promise<string | undefined> {
  // Explicit SHA takes priority — the operator knows what's deployed.
  if (explicitSha) {
    return explicitSha;
  }

  // Fall back to live git state for local dev.
  try {
    // Resolve repo root so dirty file reads work regardless of CWD
    const repoRoot = await exec("git", ["rev-parse", "--show-toplevel"]);
    const head = await exec("git", ["rev-parse", "HEAD"]);
    const dirty = await exec("git", ["diff", "--name-only", "HEAD"]);
    const untracked = await exec("git", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
    ]);

    const dirtyFiles = [...dirty.split("\n"), ...untracked.split("\n")]
      .filter((f) => f.length > 0)
      .sort();

    // Clean tree — return HEAD SHA directly for traceability.
    if (dirtyFiles.length === 0) {
      return head;
    }

    // Dirty tree — hash HEAD + file contents into an opaque fingerprint.
    const parts: string[] = [];
    for (const f of dirtyFiles) {
      try {
        // git returns paths relative to repo root
        parts.push(f + ":" + await Deno.readTextFile(`${repoRoot}/${f}`));
      } catch {
        // File was deleted — include path so deletion changes the hash
        parts.push(f + ":DELETED");
      }
    }
    return sha256(head + await sha256(parts.join("\n")));
  } catch {
    // Not in a git repository — cache disabled
    return undefined;
  }
}

async function exec(cmd: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!result.success) {
    throw new Error(`${cmd} ${args.join(" ")} failed`);
  }

  return new TextDecoder().decode(result.stdout).trim();
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
