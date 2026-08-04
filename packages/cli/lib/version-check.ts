// Detects a cf ↔ server version skew before it turns into confusing failures.
//
// The join key is the git commit SHA — the only version identity this repo
// deploys by. The server reports its commit on its `/_health` response (and
// `/api/meta`); the runtime captures it from that response's header during
// the health check it already performs, so learning the server side costs
// no request of its own and completes exactly when the health probe does —
// no body read that a stalled stream could hold open. This cf invocation
// resolves its own commit via `lib/build-info.ts` (baked metadata or local
// git — no network). Either side being unknown (old server, no git, no
// baked marker) skips silently — absence of metadata is not evidence of a
// mismatch.
//
// A mismatch is not one problem but two, with different severities. In local
// development it is completely normal for cf to be NEWER than the server it
// talks to (the checkout moved on; the server kept running, or the deploy
// trails main) — that gets a compact heads-up. cf being OLDER than the
// server is the dangerous direction: the server speaks a protocol this cf
// predates, and commands will likely fail in confusing ways — that gets the
// loud warning. Direction is proven by git ancestry in the checkout's
// history, so it is only available to source runs whose history contains
// the server's commit; compiled binaries and unorderable pairs fall back to
// the undirected wording.

import {
  relateShasIn,
  resolveCliVersion,
  type ShaRelation,
} from "./build-info.ts";

/** Set (to any non-empty value) to skip the version check entirely. */
export const SKIP_VERSION_CHECK_ENV = "CF_SKIP_VERSION_CHECK";

/** Injectable effects, for tests. */
export interface VersionCheckDeps {
  env?: (key: string) => string | undefined;
  resolveCliVersion?: typeof resolveCliVersion;
  relate?: (
    checkoutDir: string,
    cliSha: string,
    serverSha: string,
  ) => Promise<ShaRelation>;
  warn?: (message: string) => void;
}

export interface VersionCheck {
  /**
   * Print the warning, if the pair warrants one. `serverGitSha` is the
   * runtime's capture from the health round trip. Awaits only local work
   * (the cli-side resolution, plus git ancestry on a proven mismatch);
   * never rejects.
   */
  finish(serverGitSha: string | null, apiUrl: string | URL): Promise<void>;
}

const SILENCE_HINT = `set ${SKIP_VERSION_CHECK_ENV}=1 to skip this check.`;

/**
 * The warning to print for this (cf, server) commit pair, or null when the
 * pair warrants none: either side unknown, or both sides equal. The
 * relation grades the severity — see the module comment.
 */
export function versionMismatchWarning(
  cliSha: string | null,
  serverSha: string | null,
  apiUrl: string | URL,
  relation: ShaRelation = { kind: "unknown" },
): string | null {
  if (!cliSha || !serverSha || cliSha === serverSha) return null;
  const origin = new URL(apiUrl).origin;
  switch (relation.kind) {
    case "cli-ahead": {
      const behind = relation.serverBehindBy !== null
        ? `${relation.serverBehindBy} commit(s) behind`
        : "behind";
      return `⚠️  cf is newer than the server at ${origin} — the server ` +
        `(${serverSha}) is ${behind} this cf (${cliSha}).\n` +
        `    Commands may fail where cf relies on newer behavior; restart ` +
        `or redeploy the\n` +
        `    server to match, or ` + SILENCE_HINT;
    }
    case "cli-behind":
      return `⚠️  This cf is OUTDATED: the server at ${origin} runs a ` +
        `newer version.\n` +
        `    cf:     ${cliSha}\n` +
        `    server: ${serverSha}\n` +
        `    Commands will likely fail in confusing ways — update this cf ` +
        `(pull the checkout\n` +
        `    or reinstall the binary), or ` + SILENCE_HINT;
    case "diverged":
      return `⚠️  cf and the server at ${origin} are running diverged ` +
        `versions of Common Fabric.\n` +
        `    cf:     ${cliSha}\n` +
        `    server: ${serverSha}\n` +
        `    Neither side contains the other's commit; commands may fail ` +
        `in confusing ways.\n` +
        `    Align the two, or ` + SILENCE_HINT;
    case "unknown":
      return `⚠️  cf and the server are running different versions of ` +
        `Common Fabric.\n` +
        `    cf:     ${cliSha}\n` +
        `    server: ${serverSha} (${origin})\n` +
        `    Mismatched versions can fail in confusing ways; update ` +
        `whichever side is stale,\n` +
        `    or ` + SILENCE_HINT;
  }
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
  const resolve = deps.resolveCliVersion ?? resolveCliVersion;
  const relate = deps.relate ?? relateShasIn;
  const warn = deps.warn ?? console.error;
  const cliVersion = resolve().catch(() => ({
    sha: null,
    checkoutDir: null,
  }));
  return {
    async finish(serverGitSha, apiUrl) {
      const { sha: cliSha, checkoutDir } = await cliVersion;
      if (!cliSha || !serverGitSha || cliSha === serverGitSha) return;
      const relation: ShaRelation = checkoutDir === null
        ? { kind: "unknown" }
        : await relate(checkoutDir, cliSha, serverGitSha).catch(
          (): ShaRelation => ({ kind: "unknown" }),
        );
      const warning = versionMismatchWarning(
        cliSha,
        serverGitSha,
        apiUrl,
        relation,
      );
      if (warning) warn(warning);
    },
  };
}
