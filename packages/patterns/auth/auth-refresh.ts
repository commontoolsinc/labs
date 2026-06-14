/**
 * Shared token refresh logic for OAuth auth patterns.
 *
 * Creates a guarded refresh function parameterized by endpoint.
 */
import { getPatternEnvironment, Writable } from "commonfabric";

/**
 * Refresh an OAuth token using explicit piece state instead of module-scope
 * closure state, so auth patterns remain SES-safe.
 *
 * @param authCell - Writable auth state to update
 * @param refreshEndpoint - Server-relative path, e.g. "/api/integrations/google-oauth/refresh"
 * @param refreshInProgress - Explicit in-flight guard shared by the pattern
 */
export async function refreshOAuthToken(
  // deno-lint-ignore no-explicit-any
  authCell: Writable<any>,
  refreshEndpoint: string,
  refreshInProgress: Writable<boolean>,
): Promise<boolean> {
  if (refreshInProgress.get()) return false;
  refreshInProgress.set(true);

  try {
    const env = getPatternEnvironment();
    const currentAuth = authCell.get();
    const refreshToken = currentAuth?.refreshToken;

    if (!refreshToken) {
      throw new Error("No refresh token available");
    }

    const res = await fetch(
      new URL(refreshEndpoint, env.apiUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      },
    );

    if (!res.ok) {
      const errorText = await res.text();
      const error = new Error(
        `Token refresh failed: ${res.status} ${errorText}`,
      ) as Error & { status: number };
      error.status = res.status;
      throw error;
    }

    const json = await res.json();
    if (!json.tokenInfo) {
      throw new Error("Invalid refresh response: no tokenInfo");
    }

    authCell.update({
      ...json.tokenInfo,
      user: currentAuth.user,
    });
    return true;
  } finally {
    refreshInProgress.set(false);
  }
}
