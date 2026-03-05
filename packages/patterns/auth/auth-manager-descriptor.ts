/**
 * Descriptor interface for auth manager factory.
 *
 * Each OAuth provider supplies a descriptor that parameterizes the
 * generic auth manager logic (wish tags, token field, scope handling, UI).
 */
import type { AuthState } from "./auth-types.ts";

export interface AuthManagerDescriptor {
  /** Internal name, e.g. "google", "airtable" */
  name: string;
  /** Display name, e.g. "Google", "Airtable" */
  displayName: string;
  /** Brand color hex, e.g. "#4285f4", "#18BFFF" */
  brandColor: string;
  /** Primary wish tag, e.g. "#googleAuth", "#airtableAuth" */
  wishTag: string;
  /** Variant wish tags for multi-account support, e.g. { personal: "#googleAuthPersonal" } */
  variantWishTags?: Record<string, string>;
  /** Token field name on the auth object */
  tokenField: "token" | "accessToken";
  /** Server endpoint for token refresh */
  refreshEndpoint: string;
  /** Scope key → scope URL (Google) or key → description (Airtable) */
  scopeDescriptions: Record<string, string>;
  /**
   * When true, scope keys are used directly as scope strings for verification.
   * When false, a scopeMap is needed to convert keys to scope URLs.
   */
  scopeKeysAreLiteral: boolean;
  /** Maps scope keys to scope URL strings (only needed when scopeKeysAreLiteral is false) */
  scopeMap?: Record<string, string>;
  /** Whether the provider supports user avatar images (Google: true, Airtable: false) */
  hasAvatarSupport: boolean;
}

/** Status colors shared across all auth managers */
export const STATUS_COLORS: Record<AuthState, string> = {
  loading: "var(--ct-color-yellow-500, #eab308)",
  "needs-login": "var(--ct-color-red-500, #ef4444)",
  "missing-scopes": "var(--ct-color-orange-500, #f97316)",
  "token-expired": "var(--ct-color-red-500, #ef4444)",
  ready: "var(--ct-color-green-500, #22c55e)",
};

/** Status messages shared across all auth managers */
export const STATUS_MESSAGES: Record<AuthState, string> = {
  loading: "Loading auth...",
  "needs-login": "Please sign in",
  "missing-scopes": "Additional permissions needed",
  "token-expired": "Session expired - click Refresh Session",
  ready: "Connected",
};
