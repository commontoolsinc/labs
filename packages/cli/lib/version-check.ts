// Detects a cf ↔ server version skew before it turns into confusing failures.
//
// The join key is the git commit SHA — the only version identity this repo
// deploys by. The server reports its commit on `/api/meta` (`gitSha`, null
// when unknown); this cf invocation resolves its own commit via
// `lib/build-info.ts`. When both sides are known and differ, every
// server-touching command prints one warning to stderr. Either side being
// unknown (old server, no git, no baked marker) skips the check silently —
// absence of metadata is not evidence of a mismatch.

import { resolveCliGitSha } from "./build-info.ts";

/** Set (to any non-empty value) to skip the version check entirely. */
export const SKIP_VERSION_CHECK_ENV = "CF_SKIP_VERSION_CHECK";

/**
 * The server's self-reported commit from `GET /api/meta`, or null when the
 * route is absent, the response is malformed, or the fetch fails. Never
 * throws — connectivity problems are the health check's to report.
 */
export async function fetchServerGitSha(
  apiUrl: string | URL,
): Promise<string | null> {
  try {
    const response = await fetch(new URL("/api/meta", apiUrl));
    if (!response.ok) return null;
    const body = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const sha = (body as { gitSha?: unknown }).gitSha;
    return typeof sha === "string" && sha.trim() ? sha.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The warning to print for this (cf, server) commit pair, or null when the
 * pair warrants none: either side unknown, or both sides equal.
 */
export function versionMismatchWarning(
  cliSha: string | null,
  serverSha: string | null,
  apiUrl: string | URL,
): string | null {
  if (!cliSha || !serverSha || cliSha === serverSha) return null;
  return `⚠️  cf and the server are running different versions of ` +
    `Common Fabric.\n` +
    `    cf:     ${cliSha}\n` +
    `    server: ${serverSha} (${new URL(apiUrl).origin})\n` +
    `    Mismatched versions can fail in confusing ways; update whichever ` +
    `side is stale,\n` +
    `    or set ${SKIP_VERSION_CHECK_ENV}=1 to skip this check.`;
}

/**
 * Compare this cf's commit with the server's and warn on stderr when they
 * differ. Resolves both sides concurrently and never throws, so callers can
 * start it early and await it after their own connectivity check.
 */
export async function warnOnVersionMismatch(
  apiUrl: string | URL,
  options: { env?: (key: string) => string | undefined } = {},
): Promise<void> {
  const env = options.env ?? Deno.env.get.bind(Deno.env);
  if (env(SKIP_VERSION_CHECK_ENV)) return;
  const [cliSha, serverSha] = await Promise.all([
    resolveCliGitSha(),
    fetchServerGitSha(apiUrl),
  ]);
  const warning = versionMismatchWarning(cliSha, serverSha, apiUrl);
  if (warning) console.error(warning);
}
