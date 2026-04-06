/// <cts-enable />
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
 * const { auth, fullUI, isReady } = AirtableAuthManager({
 *   requiredScopes: ["data.records:read", "schema.bases:read"],
 * });
 *
 * if (!isReady) return;
 * // Use auth.accessToken for API calls
 *
 * return { [UI]: <div>{fullUI}</div> };
 * ```
 */

import { __ct_data, type Opaque } from "commonfabric";
import { createAuthManager } from "../../../auth/create-auth-manager.tsx";
import type { AuthManagerDescriptor } from "../../../auth/auth-manager-descriptor.ts";
import AirtableAuth from "../airtable-auth.tsx";

// Re-export shared types for consumers
export type {
  AuthInfo,
  AuthState,
  TokenExpiryWarning,
} from "../../../auth/auth-types.ts";
export type {
  AuthManagerInput as AirtableAuthManagerInput,
  AuthManagerOutput as AirtableAuthManagerOutput,
} from "../../../auth/create-auth-manager.tsx";
export type { AirtableAuth as AirtableAuthType } from "../airtable-auth.tsx";

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
const AIRTABLE_SCOPE_DESCRIPTIONS = __ct_data(
  {
    "data.records:read": "Read records",
    "data.records:write": "Write records",
    "data.recordComments:read": "Read record comments",
    "data.recordComments:write": "Write record comments",
    "schema.bases:read": "Read base schemas",
    "schema.bases:write": "Write base schemas",
    "webhook:manage": "Manage webhooks",
  } as const,
);
export const SCOPE_DESCRIPTIONS: Record<ScopeKey, string> =
  AIRTABLE_SCOPE_DESCRIPTIONS;

/** Unified scope registry for the auth manager factory */
const SCOPES: AuthManagerDescriptor["scopes"] = __ct_data(
  Object.fromEntries(
    Object.entries(SCOPE_DESCRIPTIONS).map(([key, desc]) => [
      key,
      { description: desc, scopeString: key },
    ]),
  ),
);

const AirtableAuthManagerDescriptor: AuthManagerDescriptor = __ct_data({
  name: "airtable",
  displayName: "Airtable",
  brandColor: "#18BFFF",
  wishTag: "#airtableAuth",
  tokenField: "accessToken",
  scopes: SCOPES,
  hasAvatarSupport: false,
});

export function AirtableAuthManager(
  input: Opaque<
    import("../../../auth/create-auth-manager.tsx").AuthManagerInput
  >,
) {
  return createAuthManager(
    AirtableAuthManagerDescriptor,
    AirtableAuth,
  )(input);
}

export default AirtableAuthManager;
