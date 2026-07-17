/**
 * Airtable Auth Manager - Unified auth management utility
 *
 * Encapsulates Airtable Auth best practices:
 * - Uses wish() with framework picker for account selection
 * - Detects missing scopes and navigates to auth piece
 * - Detects expired tokens and provides recovery UI
 * - Pre-composed UI components for consistent UX
 *
 * Usage:
 * ```typescript
 * const { availability, fullUI, isReady } = AirtableAuthManager({
 *   requiredScopes: ["data.records:read", "schema.bases:read"],
 * });
 *
 * const auth = availability.state === "ready" ? availability.auth : null;
 * const providerUI = auth
 *   ? <Importer auth={auth} />
 *   : <div>Connect Airtable first.</div>;
 *
 * return { [UI]: <div>{fullUI}{providerUI}</div> };
 * ```
 *
 * Use authIsReady(availability) for shared boolean readiness checks.
 * Keep the writable auth cell selection next to the code that uses it.
 */

import { action, navigateTo, pattern, UI, Writable } from "commonfabric";
import { AuthManagerBase } from "../../../auth/create-auth-manager.tsx";
import type { AuthManagerDescriptor } from "../../../auth/auth-manager-descriptor.ts";
import { authIsReady } from "../../../auth/auth-types.ts";
import type { AuthManagerOutput } from "../../../auth/create-auth-manager.tsx";
import AirtableAuth, {
  type AirtableAuth as AirtableAuthData,
} from "../airtable-auth.tsx";

// Re-export shared types for consumers
export type {
  AuthInfo,
  AuthState,
  TokenExpiryWarning,
} from "../../../auth/auth-types.ts";
export type {
  AuthManagerInput as AirtableAuthManagerInput,
} from "../../../auth/create-auth-manager.tsx";
export type { AirtableAuth as AirtableAuthType } from "../airtable-auth.tsx";

export type AirtableAuthManagerOutput = AuthManagerOutput<AirtableAuthData>;

/** Airtable scope keys */
export type ScopeKey =
  | "data.records:read"
  | "data.records:write"
  | "data.recordComments:read"
  | "data.recordComments:write"
  | "schema.bases:read"
  | "schema.bases:write"
  | "webhook:manage";

/** Human-readable scope descriptions */
const AIRTABLE_SCOPE_DESCRIPTIONS = {
  "data.records:read": "Read records",
  "data.records:write": "Write records",
  "data.recordComments:read": "Read record comments",
  "data.recordComments:write": "Write record comments",
  "schema.bases:read": "Read base schemas",
  "schema.bases:write": "Write base schemas",
  "webhook:manage": "Manage webhooks",
} as const;
export const SCOPE_DESCRIPTIONS: Record<ScopeKey, string> =
  AIRTABLE_SCOPE_DESCRIPTIONS;

/** Unified scope registry for the auth manager base */
const SCOPES: AuthManagerDescriptor["scopes"] = Object.fromEntries(
  Object.entries(SCOPE_DESCRIPTIONS).map(([key, desc]) => [
    key,
    { description: desc, scopeString: key },
  ]),
);

const AirtableAuthManagerDescriptor: AuthManagerDescriptor = {
  name: "airtable",
  displayName: "Airtable",
  brandColor: "#18BFFF",
  wishTag: "#airtableAuth",
  tokenField: "accessToken",
  scopes: SCOPES,
  hasAvatarSupport: false,
};

export const AirtableAuthManager = pattern<
  import("../../../auth/create-auth-manager.tsx").AuthManagerInput,
  AirtableAuthManagerOutput
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
      accessToken: "",
    };

    // Cell initials are schema defaults and must be compile-time static
    // (CT-1880); runtime scope selections are written explicitly.
    const scopeFlag = (enabled: boolean) => {
      const flag = new Writable(false);
      flag.set(enabled);
      return flag;
    };
    return navigateTo(
      AirtableAuth(
        {
          selectedScopes: {
            "data.records:read": scopeFlag(required.includes("data.records:read")),
            "data.records:write": scopeFlag(required.includes("data.records:write")),
            "data.recordComments:read": scopeFlag(required.includes("data.recordComments:read")),
            "data.recordComments:write": scopeFlag(required.includes("data.recordComments:write")),
            "schema.bases:read": scopeFlag(required.includes("schema.bases:read")),
            "schema.bases:write": scopeFlag(required.includes("schema.bases:write")),
            "webhook:manage": scopeFlag(required.includes("webhook:manage")),
          },
          auth: emptyAuth,
        } as Parameters<typeof AirtableAuth>[0],
      ),
    );
  });

  const base = AuthManagerBase<AirtableAuthData>({
    requiredScopes,
    accountType,
    debugMode,
    descriptor: AirtableAuthManagerDescriptor,
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

export default AirtableAuthManager;
