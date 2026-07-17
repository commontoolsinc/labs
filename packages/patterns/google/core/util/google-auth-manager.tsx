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
 * const { availability, fullUI, isReady } = createGoogleAuth({
 *   requiredScopes: ["gmail", "drive"],
 * });
 *
 * const auth = availability.state === "ready" ? availability.auth : null;
 * const providerUI = auth
 *   ? <Importer auth={auth} />
 *   : <div>Connect Google first.</div>;
 *
 * // In UI: {fullUI} handles all auth states
 * return { [UI]: <div>{fullUI}{providerUI}</div> };
 * ```
 *
 * Use authIsReady(availability) for shared boolean readiness checks.
 * Keep the writable auth cell selection next to the code that uses it.
 *
 * Token refresh: Tokens auto-refresh via background-piece-service (when registered).
 * For fallback, a "Refresh Session" button is shown in the expired UI.
 */

import { action, navigateTo, pattern, UI, Writable } from "commonfabric";
import { AuthManagerBase } from "../../../auth/create-auth-manager.tsx";
import type { AuthManagerDescriptor } from "../../../auth/auth-manager-descriptor.ts";
import { authIsReady } from "../../../auth/auth-types.ts";
import GoogleAuth, { type Auth } from "../google-auth.tsx";

// Re-export shared types for consumers
export type {
  AuthInfo,
  AuthState,
  TokenExpiryWarning,
} from "../../../auth/auth-types.ts";
import type {
  AuthManagerInput as GoogleAuthManagerInput,
  AuthManagerOutput,
} from "../../../auth/create-auth-manager.tsx";
export type GoogleAuthManagerOutput = AuthManagerOutput<Auth>;
export type { GoogleAuthManagerInput };
export type { Auth, GoogleAuthCell } from "../google-auth.tsx";

const GOOGLE_SCOPE_MAP_VALUES = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  calendarWrite: "https://www.googleapis.com/auth/calendar.events",
  drive: "https://www.googleapis.com/auth/drive",
  docs: "https://www.googleapis.com/auth/documents.readonly",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
} as const;
export type ScopeKey = keyof typeof GOOGLE_SCOPE_MAP_VALUES;

/** Scope mapping for Google APIs - friendly names to URLs */
const GOOGLE_SCOPE_MAP: Record<ScopeKey, string> = GOOGLE_SCOPE_MAP_VALUES;
export const SCOPE_MAP = GOOGLE_SCOPE_MAP;

/** Human-readable scope descriptions */
const GOOGLE_SCOPE_DESCRIPTIONS = {
  gmail: "Gmail (read emails)",
  gmailSend: "Gmail (send emails)",
  gmailModify: "Gmail (add/remove labels)",
  calendar: "Calendar (read events)",
  calendarWrite: "Calendar (create/edit/delete events)",
  drive: "Drive (read/write files & comments)",
  docs: "Docs (read document content)",
  contacts: "Contacts (read contacts)",
} as const;
export const SCOPE_DESCRIPTIONS = GOOGLE_SCOPE_DESCRIPTIONS;

/** Account type for multi-account support */
export type AccountType = "default" | "personal" | "work";

/** Unified scope registry for the auth manager base */
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

export const GoogleAuthManager = pattern<
  GoogleAuthManagerInput,
  GoogleAuthManagerOutput
>(({ requiredScopes, accountType, debugMode }) => {
  const createAuth = action(() => {
    const required = Array.isArray(requiredScopes) ? requiredScopes : [];
    const emptyAuth: Record<string, unknown> = {
      tokenType: "",
      scope: [],
      expiresIn: 0,
      expiresAt: 0,
      refreshToken: "",
      user: { email: "", name: "", picture: "" },
      token: "",
    };

    // Cell initials are schema defaults and must be compile-time static
    // (CT-1880); runtime scope selections are written explicitly.
    const scopeFlag = (enabled: boolean) => {
      const flag = new Writable(false);
      flag.set(enabled);
      return flag;
    };
    return navigateTo(
      GoogleAuth(
        {
          selectedScopes: {
            gmail: scopeFlag(required.includes("gmail")),
            gmailSend: scopeFlag(required.includes("gmailSend")),
            gmailModify: scopeFlag(required.includes("gmailModify")),
            calendar: scopeFlag(required.includes("calendar")),
            calendarWrite: scopeFlag(required.includes("calendarWrite")),
            drive: scopeFlag(required.includes("drive")),
            docs: scopeFlag(required.includes("docs")),
            contacts: scopeFlag(required.includes("contacts")),
          },
          auth: emptyAuth,
        } as Parameters<typeof GoogleAuth>[0],
      ),
    );
  });

  const base = AuthManagerBase<Auth>({
    requiredScopes,
    accountType,
    debugMode,
    descriptor: GoogleAuthManagerDescriptor,
    createAuth,
  });

  return {
    auth: base.auth,
    availability: base.availability,
    authInfo: base.authInfo,
    isReady: authIsReady(base.availability),
    currentEmail: base.currentEmail,
    currentState: base.currentState,
    pickerUI: base.pickerUI,
    statusUI: base.statusUI,
    fullUI: base.fullUI,
    [UI]: base.fullUI,
  };
});

// Backward-compatible export for existing code that uses createGoogleAuth()
export const createGoogleAuth = GoogleAuthManager;

export default GoogleAuthManager;
