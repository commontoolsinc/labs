/**
 * Shared types for OAuth auth patterns and auth managers.
 */

/**
 * Visual status of auth in preview/consumer UI components.
 *
 * This type drives the preview indicator dot color and background.
 * It is intentionally separate from AuthState: AuthStatus collapses
 * several manager states (e.g. "loading" is not represented here)
 * and adds "warning" which is a time-based visual hint, not a
 * distinct manager state.
 */
export type AuthStatus =
  | "needs-login"
  | "missing-scopes"
  | "expired"
  | "warning"
  | "ready";

/** Token expiry warning level used in auth managers */
export type TokenExpiryWarning = "ok" | "warning" | "expired";

/**
 * State machine enumeration for the auth manager's internal lifecycle.
 *
 * Each value maps to a distinct UI panel in the fullUI output and
 * determines which actions are available. Unlike AuthStatus (which
 * is a simplified visual indicator for consumers), AuthState tracks
 * the full set of states the manager can be in, including "loading"
 * and "token-expired" (which AuthStatus calls "expired").
 */
export type AuthState =
  | "loading"
  | "needs-login"
  | "missing-scopes"
  | "token-expired"
  | "ready";

/** Complete auth info bundle returned by auth managers */
export interface AuthInfo {
  state: AuthState;
  // deno-lint-ignore no-explicit-any
  auth: any | null;
  authCell: unknown;
  email: string;
  hasRequiredScopes: boolean;
  grantedScopes: string[];
  missingScopes: string[];
  tokenExpiresAt: number | null;
  isTokenExpired: boolean;
  tokenTimeRemaining: number | null;
  tokenExpiryWarning: TokenExpiryWarning;
  tokenExpiryDisplay: string;
  statusDotColor: string;
  statusText: string;
  piece: unknown;
  userChip: unknown;
}
