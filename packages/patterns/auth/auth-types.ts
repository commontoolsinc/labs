/**
 * Shared types for OAuth auth patterns and auth managers.
 */
import type { VNode, Writable } from "commonfabric";

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

/** Common fields the shared auth manager reads from provider auth data. */
export interface OAuthAuthData {
  token?: unknown;
  accessToken?: unknown;
  scope?: readonly string[];
  expiresAt?: number;
  refreshToken?: unknown;
  user?: {
    email?: string;
    name?: string;
    picture?: string;
  };
}

/** Live writable provider auth cell. */
export type AuthCell<TAuth extends OAuthAuthData = OAuthAuthData> = Writable<
  TAuth
>;

/** Auth availability mirrors AuthState and carries auth only when a cell exists. */
export type AuthAvailability<TAuth extends OAuthAuthData = OAuthAuthData> =
  | { state: "loading"; auth: null }
  | { state: "needs-login"; auth: AuthCell<TAuth> }
  | {
    state: "missing-scopes";
    auth: AuthCell<TAuth>;
    missingScopes: string[];
  }
  | { state: "token-expired"; auth: AuthCell<TAuth> }
  | { state: "ready"; auth: AuthCell<TAuth> };

/** Complete auth info bundle returned by auth managers */
export interface AuthInfo<TAuth extends OAuthAuthData = OAuthAuthData> {
  state: AuthState;
  availability: AuthAvailability<TAuth>;
  auth: AuthCell<TAuth> | null;
  authCell: AuthCell<TAuth> | null;
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
  userChip: VNode | null;
}
