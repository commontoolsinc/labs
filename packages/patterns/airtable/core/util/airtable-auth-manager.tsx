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
export const SCOPE_DESCRIPTIONS: Record<ScopeKey, string> = {
  "data.records:read": "Read records",
  "data.records:write": "Write records",
  "data.recordComments:read": "Read record comments",
  "data.recordComments:write": "Write record comments",
  "schema.bases:read": "Read base schemas",
  "schema.bases:write": "Write base schemas",
  "webhook:manage": "Manage webhooks",
};

const AirtableAuthManagerDescriptor: AuthManagerDescriptor = {
  name: "airtable",
  displayName: "Airtable",
  brandColor: "#18BFFF",
  wishTag: "#airtableAuth",
  tokenField: "accessToken",
  refreshEndpoint: "/api/integrations/airtable-oauth/refresh",
  scopeDescriptions: SCOPE_DESCRIPTIONS,
  scopeKeysAreLiteral: true,
  hasAvatarSupport: false,
};

export const AirtableAuthManager = createAuthManager(
  AirtableAuthManagerDescriptor,
  AirtableAuth,
);

export default AirtableAuthManager;
