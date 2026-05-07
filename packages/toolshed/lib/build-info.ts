// Build metadata baked into the toolshed binary at compile time.
//
// `tasks/build-binaries.ts` writes `packages/toolshed/COMPILED` and includes
// it in the binary via `deno compile --include`. At runtime we read it
// (synchronously, once) to surface the deployed commit on `/api/meta` and to
// fingerprint the server-side compilation cache.
//
// In non-compiled runs (e.g. `deno task production` from a checkout) the
// file does not exist and `commitSha` is null — `resolveGitSha()` then
// returns the operator-set env var if any, otherwise null.

import env from "@/env.ts";

const COMPILED_PATH = new URL("../COMPILED", import.meta.url);

export interface BuildInfo {
  commitSha: string | null;
  builtAt: string | null;
}

function normalize(s: string | null | undefined): string | null {
  const trimmed = s?.trim();
  return trimmed ? trimmed : null;
}

function read(): BuildInfo {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(COMPILED_PATH);
  } catch {
    return { commitSha: null, builtAt: null };
  }
  if (!raw.trim()) return { commitSha: null, builtAt: null };
  try {
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    return {
      commitSha: normalize(parsed.commitSha),
      builtAt: normalize(parsed.builtAt),
    };
  } catch {
    return { commitSha: null, builtAt: null };
  }
}

export const buildInfo: BuildInfo = read();

/**
 * Canonical git SHA for this server. Used by both `/api/meta` (to surface
 * the deployed commit) and `index.ts` (to fingerprint the compilation
 * cache), so the two stay in lockstep.
 *
 * Precedence:
 *   1. `TOOLSHED_GIT_SHA` env var — operator attestation, useful for
 *      hot-patched binaries where you want to declare a different commit
 *      than what was compiled.
 *   2. SHA baked into the binary at build time (read above).
 *   3. `null` — caller decides what to do (the cache falls back to live
 *      git detection; `/api/meta` reports null).
 *
 * Empty / whitespace-only values at any level are treated as unset.
 */
export function resolveGitSha(): string | null {
  return normalize(env.TOOLSHED_GIT_SHA) ?? buildInfo.commitSha;
}
