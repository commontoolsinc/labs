/**
 * Version-skew gate for the system-pattern auto-update path.
 *
 * The toolshed answers `?identity` the *light* way (see
 * {@link ./entry-identity.ts}) — a computation that is only bit-for-bit
 * comparable to what the worker's runtime would produce when the two run the
 * **same build**. Before trusting a `?identity` value against a running
 * pattern's identity, the caller gates on build equality and then requires the
 * identity/source responses themselves to attest that build. Together those
 * checks make the light identity sound even across a rolling deployment: we
 * never compare or compile responses from another build.
 *
 * Both build versions are the deploy's git sha — the client's is threaded in as
 * `Runtime.clientVersion`, and the toolshed's comes from `GET /api/meta`.
 */

import type { RuntimeFetch } from "../runtime.ts";

/**
 * Response header that binds a served system-pattern identity/source to the
 * toolshed process build that produced it. Browsers may read it because the
 * patterns route exposes it through CORS.
 */
export const PATTERN_RESPONSE_BUILD_HEADER = "X-Common-Fabric-Build";

/** The normalized build attestation on a system-pattern response, if any. */
export function patternResponseBuild(
  response: Pick<Response, "headers">,
): string | undefined {
  const value = response.headers.get(PATTERN_RESPONSE_BUILD_HEADER)?.trim();
  return value || undefined;
}

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
  fetchImpl: RuntimeFetch,
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
