/**
 * Shared types for OAuth auth patterns and auth managers.
 */

/** Status of auth in preview UI */
export type AuthStatus =
  | "needs-login"
  | "missing-scopes"
  | "expired"
  | "warning"
  | "ready";

/** Token expiry warning level used in auth managers */
export type TokenExpiryWarning = "ok" | "warning" | "expired";

/** Auth state enumeration for auth managers */
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
