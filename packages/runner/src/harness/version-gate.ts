/**
 * Version-skew gate for the system-pattern auto-update path.
 *
 * The toolshed answers `?identity` the *light* way (see
 * {@link ./entry-identity.ts}) — a computation that is only bit-for-bit
 * comparable to what the worker's runtime would produce when the two run the
 * **same build**. So before trusting a `?identity` value against a running
 * pattern's identity, the caller gates on build equality. The gate is exactly
 * what makes the light identity sound: we never compare identities across
 * builds.
 *
 * Both build versions are the deploy's git sha — the client's is threaded in as
 * `Runtime.clientVersion` (from the shell's `COMMIT_SHA`), the toolshed's comes
 * from `GET /api/meta` (`gitSha`, itself derived from the same `COMMIT_SHA` at
 * build time).
 */

/**
 * True only when both build versions are known AND equal. Any unknown
 * (`undefined`) side ⇒ `false` — fail safe: never auto-update against an
 * unknown build. A `null` `gitSha` from `/api/meta` (dev, no baked sha) is
 * normalized to `undefined` by {@link fetchToolshedGitSha}.
 */
export function buildsMatch(
  clientVersion: string | undefined,
  toolshedVersion: string | undefined,
): boolean {
  return clientVersion !== undefined &&
    toolshedVersion !== undefined &&
    clientVersion === toolshedVersion;
}

/**
 * Fetch a toolshed host's build git sha from `GET {host}/api/meta`. Returns
 * `undefined` on any failure (network error, non-2xx, missing/`null`/non-string
 * `gitSha`) — the gate treats every `undefined` as "unknown → do not update".
 */
export async function fetchToolshedGitSha(
  fetchImpl: typeof globalThis.fetch,
  host: string | URL,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(new URL("/api/meta", host));
    if (!res.ok) return undefined;
    const body = await res.json() as { gitSha?: unknown };
    return typeof body?.gitSha === "string" ? body.gitSha : undefined;
  } catch {
    return undefined;
  }
}
