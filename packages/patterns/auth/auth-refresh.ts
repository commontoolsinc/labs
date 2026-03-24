/**
 * Shared token refresh logic for OAuth auth patterns.
 *
 * Creates a guarded refresh function parameterized by endpoint.
 */
import { getPatternEnvironment, Writable } from "commonfabric";

/**
 * Create a guarded token refresh function for a specific OAuth provider.
 *
 * The returned function:
 * - Calls the server refresh endpoint with the current refreshToken
 * - Updates the auth cell with the new token info (preserving user data)
 * - Guards against concurrent invocations (returns false if one is in-flight)
 *
 * @param refreshEndpoint - Server-relative path, e.g. "/api/integrations/google-oauth/refresh"
 */
export function createRefreshFunction(refreshEndpoint: string) {
  const env = getPatternEnvironment();
  let refreshInProgress = false;

  return async function refreshAuthToken(
    // deno-lint-ignore no-explicit-any
    authCell: Writable<any>,
  ): Promise<boolean> {
    if (refreshInProgress) return false;
    refreshInProgress = true;

    try {
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
      refreshInProgress = false;
    }
  };
}
