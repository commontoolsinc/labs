/**
 * Compute a fingerprint from the current git state.
 * Used for server-side compilation cache invalidation.
 *
 * Returns undefined when not in a git repository (e.g., Docker deployment).
 * In that case, the compilation cache should be disabled — without git
 * we have no way to detect code changes.
 *
 * See docs/specs/compilation-cache.md for design rationale.
 */
export async function computeGitFingerprint(): Promise<string | undefined> {
  try {
    const head = await exec("git", ["rev-parse", "HEAD"]);
    const dirty = await exec("git", ["diff", "--name-only", "HEAD"]);
    const untracked = await exec("git", [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);

    const dirtyFiles = [...dirty.split("\n"), ...untracked.split("\n")]
      .filter((f) => f.length > 0)
      .sort();

    let contentHash = "";
    if (dirtyFiles.length > 0) {
      const parts: string[] = [];
      for (const f of dirtyFiles) {
        try {
          parts.push(f + ":" + await Deno.readTextFile(f));
        } catch {
          // File was deleted — include path so deletion changes the hash
          parts.push(f + ":DELETED");
        }
      }
      contentHash = await sha256(parts.join("\n"));
    }

    return sha256(head + contentHash);
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
