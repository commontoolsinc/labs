// Detects a cf ↔ server version skew before it turns into confusing failures.
//
// The join key is the git commit SHA — the only version identity this repo
// deploys by. The server reports its commit on its `/_health` response (and
// `/api/meta`); the runtime captures it during the health check it already
// performs, so learning the server side costs no request of its own and can
// never gate a command on extra network work. This cf invocation resolves
// its own commit via `lib/build-info.ts` (baked metadata or local git — no
// network). When both sides are known and differ, one warning goes to
// stderr. Either side being unknown (old server, no git, no baked marker)
// skips silently — absence of metadata is not evidence of a mismatch.

import { resolveCliGitSha } from "./build-info.ts";

/** Set (to any non-empty value) to skip the version check entirely. */
export const SKIP_VERSION_CHECK_ENV = "CF_SKIP_VERSION_CHECK";

/** Injectable effects, for tests. */
export interface VersionCheckDeps {
  env?: (key: string) => string | undefined;
  resolveCliSha?: () => Promise<string | null>;
  warn?: (message: string) => void;
}

export interface VersionCheck {
  /**
   * Print the warning, if the pair warrants one. `serverGitSha` is the
   * runtime's capture from the health round trip. Awaits only the local
   * cli-side resolution; never rejects.
   */
  finish(serverGitSha: string | null, apiUrl: string | URL): Promise<void>;
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
 * Begin resolving this cf's own commit (baked metadata or a local git call —
 * no network). Callers start it before their health check and `finish()` it
 * with the runtime's captured server commit afterwards. When the skip env
 * var is set, nothing is resolved and `finish` is a no-op.
 */
export function startVersionCheck(deps: VersionCheckDeps = {}): VersionCheck {
  const env = deps.env ?? Deno.env.get.bind(Deno.env);
  if (env(SKIP_VERSION_CHECK_ENV)) {
    return { finish: () => Promise.resolve() };
  }
  const resolveCliSha = deps.resolveCliSha ?? resolveCliGitSha;
  const warn = deps.warn ?? console.error;
  const cliSha = resolveCliSha().catch(() => null);
  return {
    async finish(serverGitSha, apiUrl) {
      const warning = versionMismatchWarning(
        await cliSha,
        serverGitSha,
        apiUrl,
      );
      if (warning) warn(warning);
    },
  };
}
