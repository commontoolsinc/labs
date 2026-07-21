// Build metadata baked into the toolshed binary at compile time.
//
// `tasks/build-binaries.ts` writes `packages/toolshed/COMPILED` and includes
// it in the binary via `deno compile --include`. At runtime we read it
// (synchronously, once) to surface the deployed commit on `/api/meta`.
//
// In non-compiled runs (e.g. `deno task production` from a checkout) the
// file does not exist and `commitSha` is null — `resolveGitSha()` then
// returns an operator-set attestation if any, then falls back to the shared
// source-run COMMIT_SHA, otherwise null.

import env from "@/env.ts";

const COMPILED_PATH = new URL("../COMPILED", import.meta.url);

export interface BuildInfo {
  commitSha: string | null;
  builtAt: string | null;
}

export function normalize(s: string | null | undefined): string | null {
  const trimmed = s?.trim();
  return trimmed ? trimmed : null;
}

export function readBuildInfoFrom(path: URL | string): BuildInfo {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch {
    return { commitSha: null, builtAt: null };
  }
  if (!raw.trim()) return { commitSha: null, builtAt: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { commitSha: null, builtAt: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { commitSha: null, builtAt: null };
  }
  const obj = parsed as Partial<BuildInfo>;
  return {
    commitSha: normalize(obj.commitSha),
    builtAt: normalize(obj.builtAt),
  };
}

export const buildInfo: BuildInfo = readBuildInfoFrom(COMPILED_PATH);

/**
 * Pure precedence function used by `resolveGitSha()`. Exposed so it can be
 * tested without manipulating env or filesystem state.
 */
export function resolveGitShaFrom(
  envValue: string | null | undefined,
  baked: string | null,
  runtimeValue: string | null | undefined,
): string | null {
  return normalize(envValue) ?? normalize(baked) ?? normalize(runtimeValue);
}

/**
 * Canonical git SHA for this server, surfaced on `/api/meta` to report
 * the deployed commit.
 *
 * Precedence:
 *   1. `TOOLSHED_GIT_SHA` env var — operator attestation, useful for
 *      hot-patched binaries where you want to declare a different commit
 *      than what was compiled.
 *   2. SHA baked into the binary at build time (read above).
 *   3. Shared `COMMIT_SHA` env var — source-run attestation, used only when
 *      there is no explicit toolshed override or compiled build metadata.
 *   4. `null` — `/api/meta` reports null.
 *
 * Empty / whitespace-only values at any level are treated as unset.
 */
export function resolveGitSha(): string | null {
  return resolveGitShaFrom(
    env.TOOLSHED_GIT_SHA,
    buildInfo.commitSha,
    env.COMMIT_SHA,
  );
}
