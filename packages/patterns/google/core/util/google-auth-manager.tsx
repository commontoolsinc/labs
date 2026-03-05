/// <cts-enable />
/**
 * Google Auth Manager - Unified auth management utility
 *
 * This utility encapsulates all Google Auth best practices:
 * - Uses wish() with framework's built-in picker for multi-account selection
 * - Detects missing scopes and navigates to auth piece
 * - Detects expired tokens and provides recovery UI
 * - Pre-composed UI components for consistent UX
 *
 * Usage:
 * ```typescript
 * const { auth, fullUI, isReady } = createGoogleAuth({
 *   requiredScopes: ["gmail", "drive"],
 * });
 *
 * // Guard API calls with isReady
 * if (!isReady) return;
 * // Use auth.token for API calls
 *
 * // In UI: {fullUI} handles all auth states
 * return { [UI]: <div>{fullUI}</div> };
 * ```
 *
 * Token refresh: Tokens auto-refresh via background-charm-service (when registered).
 * For fallback, a "Refresh Session" button is shown in the expired UI.
 */

import { createAuthManager } from "../../../auth/create-auth-manager.tsx";
import type { AuthManagerDescriptor } from "../../../auth/auth-manager-descriptor.ts";
import GoogleAuth from "../google-auth.tsx";

// Re-export shared types for consumers
export type {
  AuthInfo,
  AuthState,
  TokenExpiryWarning,
} from "../../../auth/auth-types.ts";
export type {
  AuthManagerInput as GoogleAuthManagerInput,
  AuthManagerOutput as GoogleAuthManagerOutput,
} from "../../../auth/create-auth-manager.tsx";
export type { Auth } from "../google-auth.tsx";

/** Scope mapping for Google APIs - friendly names to URLs */
export const SCOPE_MAP = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  calendarWrite: "https://www.googleapis.com/auth/calendar.events",
  drive: "https://www.googleapis.com/auth/drive",
  docs: "https://www.googleapis.com/auth/documents.readonly",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
} as const;

/** Human-readable scope descriptions */
export const SCOPE_DESCRIPTIONS = {
  gmail: "Gmail (read emails)",
  gmailSend: "Gmail (send emails)",
  gmailModify: "Gmail (add/remove labels)",
  calendar: "Calendar (read events)",
  calendarWrite: "Calendar (create/edit/delete events)",
  drive: "Drive (read/write files & comments)",
  docs: "Docs (read document content)",
  contacts: "Contacts (read contacts)",
} as const;

export type ScopeKey = keyof typeof SCOPE_MAP;

/** Account type for multi-account support */
export type AccountType = "default" | "personal" | "work";

/** Unified scope registry for the auth manager factory */
const SCOPES: AuthManagerDescriptor["scopes"] = Object.fromEntries(
  Object.entries(SCOPE_MAP).map(([key, url]) => [
    key,
    { description: SCOPE_DESCRIPTIONS[key as ScopeKey], scopeString: url },
  ]),
);

const GoogleAuthManagerDescriptor: AuthManagerDescriptor = {
  name: "google",
  displayName: "Google",
  brandColor: "#4285f4",
  wishTag: "#googleAuth",
  variantWishTags: {
    personal: "#googleAuthPersonal",
    work: "#googleAuthWork",
  },
  tokenField: "token",
  scopes: SCOPES,
  hasAvatarSupport: true,
};

export const GoogleAuthManager = createAuthManager(
  GoogleAuthManagerDescriptor,
  GoogleAuth,
);

export default GoogleAuthManager;

// Backward-compatible export for existing code that uses createGoogleAuth()
export const createGoogleAuth = GoogleAuthManager;
