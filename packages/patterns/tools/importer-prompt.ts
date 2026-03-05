/**
 * importer-prompt.ts — Generate a structured prompt for Claude to produce a
 * complete importer pattern suite (auth, auth-manager, API client, importer)
 * for an arbitrary OAuth2-backed API provider.
 *
 * Usage:
 *   import { generateImporterPrompt } from "./importer-prompt.ts";
 *
 *   const prompt = generateImporterPrompt({
 *     providerName: "notion",
 *     brandColor: "#000000",
 *     api: extractedAPI,
 *     providerConfig: providerConfig,
 *     primaryListEndpoint: "/v1/search",
 *   });
 *
 * The returned string is a self-contained prompt that Claude can use to
 * generate four working pattern files in one shot.
 *
 * @module
 */

import type { ExtractedProviderConfig } from "./openapi-to-provider.ts";
import type {
  ExtractedAPI,
  ExtractedEndpoint,
  ExtractedParameter,
  PaginationInfo,
} from "./openapi-extract.ts";
import { toPascalCase } from "./openapi-utils.ts";

export type {
  ExtractedAPI,
  ExtractedEndpoint,
  ExtractedParameter,
  PaginationInfo,
};

// ---------------------------------------------------------------------------
// Prompt context
// ---------------------------------------------------------------------------

export interface PromptContext {
  providerName: string;
  brandColor: string;
  api: ExtractedAPI;
  providerConfig: ExtractedProviderConfig;
  /** Optional: user-provided hint for the primary list endpoint */
  primaryListEndpoint?: string;
  /** Optional: user-provided hint for the primary get endpoint */
  primaryGetEndpoint?: string;
}

// ---------------------------------------------------------------------------
// Reference source code (embedded as template literals)
// ---------------------------------------------------------------------------

// Read from: packages/patterns/airtable/core/airtable-auth.tsx
const AIRTABLE_AUTH_SOURCE = `/// <cts-enable />
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  Secret,
  Stream,
  UI,
  Writable,
} from "commontools";

import { createRefreshFunction } from "../../auth/auth-refresh.ts";
import {
  REFRESH_THRESHOLD_MS,
  startReactiveClock,
} from "../../auth/auth-reactive.ts";
import type { AuthStatus } from "../../auth/auth-types.ts";
import {
  formatTokenExpiry,
  getScopeSummary as getScopeSummaryGeneric,
  getSelectedScopeSummary,
  STATUS_CONFIG,
} from "../../auth/auth-ui-helpers.tsx";

// Airtable scope descriptions
const SCOPE_MAP = {
  "data.records:read": "Read records",
  "data.records:write": "Write records",
  "data.recordComments:read": "Read record comments",
  "data.recordComments:write": "Write record comments",
  "schema.bases:read": "Read base schemas",
  "schema.bases:write": "Write base schemas",
  "webhook:manage": "Manage webhooks",
} as const;

// Short names for scope summary in previewUI
const SCOPE_SHORT_NAMES: Record<string, string> = {
  "data.records:read": "Records (R)",
  "data.records:write": "Records (W)",
  "data.recordComments:read": "Comments (R)",
  "data.recordComments:write": "Comments (W)",
  "schema.bases:read": "Schema (R)",
  "schema.bases:write": "Schema (W)",
  "webhook:manage": "Webhooks",
};

/** Get scope summary from granted scope strings */
export function getScopeSummary(grantedScopes: string[]): string {
  return getScopeSummaryGeneric(grantedScopes, SCOPE_SHORT_NAMES);
}

/**
 * Helper to create preview UI for picker display.
 */
export function createPreviewUI(
  auth: AirtableAuth | undefined,
  selectedScopes: Record<string, boolean>,
): JSX.Element {
  const email = auth?.user?.email;
  const name = auth?.user?.name;
  const isAuthenticated = !!email;

  // Date.now() capture is intentional — createPreviewUI produces a static
  // snapshot for picker display, not a live-updating component. The main
  // pattern UI uses a reactive clock (startReactiveClock) separately.
  const now = Date.now();
  const expiresAt = auth?.expiresAt || 0;
  const isExpired = isAuthenticated && expiresAt > 0 && expiresAt < now;
  const isWarning = isAuthenticated && !isExpired && expiresAt > 0 &&
    expiresAt - now < 10 * 60 * 1000;

  const status: AuthStatus = !isAuthenticated
    ? "needs-login"
    : isExpired
    ? "expired"
    : isWarning
    ? "warning"
    : "ready";

  const scopeSummary = isAuthenticated
    ? getScopeSummary(auth?.scope || [])
    : getSelectedScopeSummary(selectedScopes, SCOPE_SHORT_NAMES);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 16px",
        backgroundColor: STATUS_CONFIG[status].bg,
        borderRadius: "8px",
      }}
    >
      <div style={{ position: "relative", flexShrink: 0 }}>
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "50%",
            backgroundColor: isAuthenticated ? "#18BFFF" : "#e5e7eb",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {isAuthenticated && (
            <span
              style={{
                color: "white",
                fontSize: "14px",
                fontWeight: "600",
              }}
            >
              {(name || email || "?")[0]?.toUpperCase()}
            </span>
          )}
        </div>
        <div
          style={{
            position: "absolute",
            bottom: "-2px",
            right: "-2px",
            width: "12px",
            height: "12px",
            borderRadius: "50%",
            backgroundColor: STATUS_CONFIG[status].dot,
            border: "2px solid white",
          }}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: "14px" }}>
          {isAuthenticated ? name || email : "Sign in required"}
        </div>
        {isAuthenticated && name && email && (
          <div style={{ fontSize: "12px", color: "#6b7280" }}>{email}</div>
        )}
        {scopeSummary && (
          <div
            style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}
          >
            {scopeSummary}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Airtable OAuth token data.
 *
 * Uses \`accessToken\` field (OAuth2TokenSchema convention).
 *
 * CRITICAL: When consuming from another pattern, DO NOT use derive()!
 * Use direct property access: \`airtableAuthPiece.auth\`
 */
export type AirtableAuth = {
  accessToken: Default<Secret<string>, "">;
  tokenType: Default<string, "">;
  scope: Default<string[], []>;
  expiresIn: Default<number, 0>;
  expiresAt: Default<number, 0>;
  refreshToken: Default<Secret<string>, "">;
  user: Default<{
    email: string;
    name: string;
    picture: string;
  }, { email: ""; name: ""; picture: "" }>;
};

// Selected scopes configuration
export type SelectedScopes = {
  "data.records:read": Default<boolean, true>;
  "data.records:write": Default<boolean, false>;
  "data.recordComments:read": Default<boolean, false>;
  "data.recordComments:write": Default<boolean, false>;
  "schema.bases:read": Default<boolean, true>;
  "schema.bases:write": Default<boolean, false>;
  "webhook:manage": Default<boolean, false>;
};

interface Input {
  selectedScopes: Default<SelectedScopes, {
    "data.records:read": true;
    "data.records:write": false;
    "data.recordComments:read": false;
    "data.recordComments:write": false;
    "schema.bases:read": true;
    "schema.bases:write": false;
    "webhook:manage": false;
  }>;
  auth: Default<AirtableAuth, {
    accessToken: "";
    tokenType: "";
    scope: [];
    expiresIn: 0;
    expiresAt: 0;
    refreshToken: "";
    user: { email: ""; name: ""; picture: "" };
  }>;
}

/** Airtable OAuth authentication for Airtable APIs. #airtableAuth */
interface Output {
  auth: AirtableAuth;
  scopes: string[];
  selectedScopes: SelectedScopes;
  /** Compact user display */
  userChip: unknown;
  /** Minimal preview for picker display */
  previewUI: unknown;
  /** Refresh the OAuth token from other pieces */
  refreshToken: Stream<Record<string, never>>;
  /** Background updater for proactive token refresh */
  bgUpdater: Stream<Record<string, never>>;
}

// Module-scope singleton refresh guard for Airtable OAuth.
// This is intentional: all instances of this auth pattern share one guard,
// preventing concurrent refresh requests. This is correct because each
// provider (e.g. Airtable, Google) has its own module with its own guard.
const refreshAuthToken = createRefreshFunction(
  "/api/integrations/airtable-oauth/refresh",
);

// Handler for refreshing tokens from UI button
const handleRefresh = handler<
  unknown,
  {
    auth: Writable<AirtableAuth>;
    refreshing: Writable<boolean>;
    refreshFailed: Writable<boolean>;
  }
>(
  async (_event, { auth, refreshing, refreshFailed }) => {
    refreshing.set(true);
    refreshFailed.set(false);
    try {
      const didRefresh = await refreshAuthToken(auth);
      refreshing.set(false);
      if (!didRefresh) return;
      refreshFailed.set(false);
    } catch {
      refreshing.set(false);
      refreshFailed.set(true);
    }
  },
);

// Handler for refreshing tokens from other pieces
const refreshTokenHandler = handler<
  Record<string, never>,
  { auth: Writable<AirtableAuth> }
>(async (_event, { auth }) => {
  await refreshAuthToken(auth);
});

// Background updater handler for proactive token refresh
const bgRefreshHandler = handler<
  Record<string, never>,
  { auth: Writable<AirtableAuth> }
>(
  async (_event, { auth }) => {
    const currentAuth = auth.get();
    if (!currentAuth?.accessToken || !currentAuth?.refreshToken) return;

    const expiresAt = currentAuth.expiresAt ?? 0;
    if (expiresAt <= 0) return;

    const timeRemaining = expiresAt - Date.now();
    if (timeRemaining > REFRESH_THRESHOLD_MS) return;

    console.log(
      "[airtable-auth bgUpdater] Token expiring soon, refreshing...",
    );

    try {
      await refreshAuthToken(auth);
      console.log("[airtable-auth bgUpdater] Token refreshed successfully");
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = e instanceof Error ? e.message : String(e);
      if (status === 400 || status === 401 || status === 403) {
        console.error(
          "[airtable-auth bgUpdater] Permanent refresh failure, clearing auth:",
          msg,
        );
        auth.set({
          accessToken: "",
          tokenType: "",
          scope: [],
          expiresIn: 0,
          expiresAt: 0,
          refreshToken: "",
          user: { email: "", name: "", picture: "" },
        });
      } else {
        console.error(
          "[airtable-auth bgUpdater] Transient refresh failure:",
          msg,
        );
      }
    }
  },
);

export default pattern<Input, Output>(
  ({ auth, selectedScopes }) => {
    // Compute active scopes based on selection.
    // Always include user.email:read so the whoami endpoint returns the email.
    const scopes = computed(() => {
      const base: string[] = ["user.email:read"];
      for (const [key, enabled] of Object.entries(selectedScopes)) {
        if (enabled) {
          base.push(key);
        }
      }
      return base;
    });

    const hasSelectedScopes = computed(() =>
      Object.values(selectedScopes).some(Boolean)
    );

    // Check if re-auth is needed (selected scopes differ from granted)
    const needsReauth = computed(() => {
      if (!auth?.accessToken) return false;
      const grantedScopes: string[] = auth?.scope || [];
      for (const [key, enabled] of Object.entries(selectedScopes)) {
        if (enabled && !grantedScopes.includes(key)) {
          return true;
        }
      }
      return false;
    });

    const now = Writable.of(Date.now());
    startReactiveClock(now);

    const isTokenExpired = computed(() => {
      if (!auth?.accessToken || !auth?.expiresAt) return false;
      return auth.expiresAt < now.get();
    });

    const tokenExpiryDisplay = computed(() =>
      formatTokenExpiry(auth?.expiresAt || 0, now.get())
    );

    const checkboxesDisabled = computed(() => !!auth?.accessToken);

    const refreshing = Writable.of(false);
    const refreshFailed = Writable.of(false);

    const scopesDisplay = computed(() => scopes.join(", "));

    const hasEmail = computed(() => !!auth?.user?.email);
    const hasUserName = computed(() => !!auth?.user?.name);

    // Data-only computed for previewUI — resolves reactive values to plain scalars
    const previewState = computed(() => {
      const email = auth?.user?.email || "";
      const name = auth?.user?.name || "";
      const isAuthenticated = !!email;
      const now = Date.now();
      const expiresAt = auth?.expiresAt || 0;
      const isExpired = isAuthenticated && expiresAt > 0 && expiresAt < now;
      const isWarning = isAuthenticated && !isExpired && expiresAt > 0 &&
        expiresAt - now < 10 * 60 * 1000;
      const status: AuthStatus = !isAuthenticated
        ? "needs-login"
        : isExpired
        ? "expired"
        : isWarning
        ? "warning"
        : "ready";
      const scopeSummary = isAuthenticated
        ? getScopeSummary(auth?.scope || [])
        : getSelectedScopeSummary({
          "data.records:read": !!selectedScopes["data.records:read"],
          "data.records:write": !!selectedScopes["data.records:write"],
          "data.recordComments:read":
            !!selectedScopes["data.recordComments:read"],
          "data.recordComments:write":
            !!selectedScopes["data.recordComments:write"],
          "schema.bases:read": !!selectedScopes["schema.bases:read"],
          "schema.bases:write": !!selectedScopes["schema.bases:write"],
          "webhook:manage": !!selectedScopes["webhook:manage"],
        }, SCOPE_SHORT_NAMES);
      const initial = (name || email || "?")[0]?.toUpperCase() || "";
      const bgColor = STATUS_CONFIG[status].bg;
      const dotColor = STATUS_CONFIG[status].dot;
      return {
        email,
        name,
        isAuthenticated,
        bgColor,
        dotColor,
        scopeSummary,
        initial,
      };
    });

    const loggedIn = computed(() => !!auth?.accessToken);
    const notLoggedInWithScopes = computed(() => !loggedIn && hasSelectedScopes);
    const showTokenStatus = computed(() =>
      !!auth?.user?.email && !isTokenExpired
    );

    // Data-only computed for granted scopes
    const grantedScopesList = computed(() => {
      const scopeList: string[] = auth?.scope || [];
      return scopeList.map(
        (s: string) => SCOPE_MAP[s as keyof typeof SCOPE_MAP] || s,
      );
    });

    return {
      [NAME]: computed(() => {
        if (loggedIn) {
          return \`Airtable Auth (\${auth.user.email})\`;
        }
        return "Airtable Auth";
      }),
      [UI]: (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            padding: "25px",
            maxWidth: "600px",
          }}
        >
          <h2 style={{ fontSize: "24px", fontWeight: "bold", margin: "0" }}>
            Airtable Authentication
          </h2>

          <div
            style={{
              padding: "20px",
              backgroundColor: "#f8f9fa",
              borderRadius: "8px",
              border: "1px solid #e0e0e0",
            }}
          >
            <h3 style={{ fontSize: "16px", marginTop: "0" }}>
              Status: {ifElse(loggedIn, "Authenticated", "Not Authenticated")}
            </h3>

            {ifElse(
              loggedIn,
              <div>
                <p style={{ margin: "8px 0" }}>
                  <strong>Email:</strong> {auth.user.email}
                </p>
                <p style={{ margin: "8px 0" }}>
                  <strong>Name:</strong> {auth.user.name}
                </p>
              </div>,
              <p style={{ color: "#666" }}>
                Select permissions below and authenticate with Airtable
              </p>,
            )}
          </div>

          {/* Permissions checkboxes */}
          <div
            style={{
              padding: "20px",
              backgroundColor: auth?.user?.email ? "#e5e7eb" : "#f0f4f8",
              borderRadius: "8px",
              border: "1px solid #d0d7de",
              opacity: loggedIn ? 0.7 : 1,
            }}
          >
            <h4 style={{ marginTop: "0", marginBottom: "12px" }}>
              Permissions
              {ifElse(
                loggedIn,
                <span
                  style={{
                    fontWeight: "normal",
                    fontSize: "12px",
                    color: "#6b7280",
                    marginLeft: "8px",
                  }}
                >
                  (locked while authenticated)
                </span>,
                null,
              )}
            </h4>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              {Object.entries(SCOPE_MAP).map(([key, description]) => (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: loggedIn ? "not-allowed" : "pointer",
                    color: loggedIn ? "#9ca3af" : "inherit",
                  }}
                >
                  <ct-checkbox
                    $checked={selectedScopes[key as keyof SelectedScopes]}
                    disabled={checkboxesDisabled}
                  >
                    {description}
                  </ct-checkbox>
                </label>
              ))}
            </div>
          </div>

          {/* Re-auth warning */}
          {ifElse(
            needsReauth,
            <div
              style={{
                padding: "12px",
                backgroundColor: "#fff3cd",
                borderRadius: "8px",
                border: "1px solid #ffc107",
                fontSize: "14px",
              }}
            >
              <strong>Note:</strong>{" "}
              You've selected new permissions. Click "Authenticate with
              Airtable" below to grant access.
            </div>,
            null,
          )}

          {/* Favorite reminder */}
          {ifElse(
            loggedIn,
            <div
              style={{
                padding: "15px",
                backgroundColor: "#d4edda",
                borderRadius: "8px",
                border: "1px solid #28a745",
                fontSize: "14px",
              }}
            >
              <strong>Tip:</strong>{" "}
              Favorite this piece to share your Airtable auth across all your
              patterns. Any pattern using{" "}
              <code>wish({"{"} query: "#airtableAuth" {"}"})</code>{" "}
              will automatically find and use it.
            </div>,
            null,
          )}

          {/* Show selected scopes */}
          {ifElse(
            notLoggedInWithScopes,
            <div style={{ fontSize: "14px", color: "#666" }}>
              Will request: {scopesDisplay}
            </div>,
            null,
          )}

          {/* Token expired warning */}
          {ifElse(
            isTokenExpired,
            <div
              style={{
                padding: "16px",
                backgroundColor: "#fee2e2",
                borderRadius: "8px",
                border: "1px solid #ef4444",
                marginBottom: "15px",
              }}
            >
              <h4
                style={{
                  margin: "0 0 8px 0",
                  color: "#dc2626",
                  fontSize: "14px",
                }}
              >
                Session Expired
              </h4>
              <p
                style={{
                  margin: "0 0 12px 0",
                  fontSize: "13px",
                  color: "#4b5563",
                }}
              >
                Your Airtable token has expired. Click below to refresh it.
              </p>
              <button
                type="button"
                onClick={handleRefresh({ auth, refreshing, refreshFailed })}
                disabled={refreshing}
                style={{
                  padding: "10px 20px",
                  backgroundColor: refreshing ? "#93c5fd" : "#3b82f6",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: refreshing ? "not-allowed" : "pointer",
                  fontWeight: "500",
                  fontSize: "14px",
                }}
              >
                {ifElse(refreshing, "Refreshing...", "Refresh Token")}
              </button>
              {ifElse(
                refreshFailed,
                <p
                  style={{
                    margin: "8px 0 0 0",
                    fontSize: "13px",
                    color: "#dc2626",
                    fontWeight: "500",
                  }}
                >
                  Refresh failed — try signing in again below.
                </p>,
                null,
              )}
            </div>,
            null,
          )}

          <ct-oauth
            $auth={auth}
            scopes={scopes}
            provider="airtable"
            providerLabel="Airtable"
            brandColor="#18BFFF"
            loginEndpoint="/api/integrations/airtable-oauth/login"
            tokenField="accessToken"
          />

          {/* Show granted scopes */}
          {ifElse(
            loggedIn,
            <div
              style={{
                padding: "15px",
                backgroundColor: "#e3f2fd",
                borderRadius: "8px",
                fontSize: "14px",
              }}
            >
              <strong>Granted Scopes:</strong>
              <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
                {grantedScopesList.map((scope) => <li>{scope}</li>)}
              </ul>
            </div>,
            null,
          )}

          {/* Token status when authenticated and NOT expired */}
          {ifElse(
            showTokenStatus,
            <div
              style={{
                padding: "16px",
                backgroundColor: "#f0f9ff",
                borderRadius: "8px",
                border: "1px solid #0ea5e9",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                <div>
                  <h4
                    style={{
                      margin: "0 0 4px 0",
                      fontSize: "14px",
                      color: "#0369a1",
                    }}
                  >
                    Token Status
                  </h4>
                  <p
                    style={{
                      margin: "0",
                      fontSize: "13px",
                      color: "#4b5563",
                    }}
                  >
                    Expires in: <strong>{tokenExpiryDisplay}</strong>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleRefresh({ auth, refreshing, refreshFailed })}
                  disabled={refreshing}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: refreshing ? "#7dd3fc" : "#0ea5e9",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    cursor: refreshing ? "not-allowed" : "pointer",
                    fontWeight: "500",
                    fontSize: "13px",
                  }}
                >
                  {ifElse(refreshing, "Refreshing...", "Refresh Now")}
                </button>
              </div>
            </div>,
            null,
          )}

          <div
            style={{
              padding: "15px",
              backgroundColor: "#e3f2fd",
              borderRadius: "8px",
              fontSize: "14px",
            }}
          >
            <strong>Usage:</strong>{" "}
            This piece provides Airtable OAuth authentication. Link its{" "}
            <code>auth</code> output to any Airtable importer piece's{" "}
            <code>auth</code> input, or favorite it for automatic discovery.
          </div>
        </div>
      ),
      auth,
      scopes,
      selectedScopes,
      userChip: ifElse(
        hasEmail,
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              width: "24px",
              height: "24px",
              borderRadius: "50%",
              backgroundColor: "#18BFFF",
              display: "inline-block",
            }}
          />
          <div>
            <div style={{ fontWeight: 500, fontSize: "14px" }}>
              {ifElse(hasUserName, auth.user.name, auth.user.email)}
            </div>
            {ifElse(
              hasUserName,
              <div style={{ fontSize: "12px", color: "#6b7280" }}>
                {auth.user.email}
              </div>,
              null,
            )}
          </div>
        </div>,
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              width: "24px",
              height: "24px",
              borderRadius: "50%",
              backgroundColor: "#e5e7eb",
              display: "inline-block",
            }}
          />
          <span style={{ color: "#6b7280" }}>Not signed in</span>
        </div>,
      ),
      previewUI: (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "12px 16px",
            backgroundColor: previewState.bgColor,
            borderRadius: "8px",
          }}
        >
          <div style={{ position: "relative", flexShrink: 0 }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "50%",
                backgroundColor: previewState.isAuthenticated
                  ? "#18BFFF"
                  : "#e5e7eb",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {ifElse(
                previewState.isAuthenticated,
                <span
                  style={{
                    color: "white",
                    fontSize: "14px",
                    fontWeight: "600",
                  }}
                >
                  {previewState.initial}
                </span>,
                null,
              )}
            </div>
            <div
              style={{
                position: "absolute",
                bottom: "-2px",
                right: "-2px",
                width: "12px",
                height: "12px",
                borderRadius: "50%",
                backgroundColor: previewState.dotColor,
                border: "2px solid white",
              }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: "14px" }}>
              {ifElse(
                previewState.isAuthenticated,
                <span>{previewState.name || previewState.email}</span>,
                <span>Sign in required</span>,
              )}
            </div>
            {ifElse(
              previewState.isAuthenticated && !!previewState.name &&
                !!previewState.email,
              <div style={{ fontSize: "12px", color: "#6b7280" }}>
                {previewState.email}
              </div>,
              null,
            )}
            {ifElse(
              !!previewState.scopeSummary,
              <div
                style={{
                  fontSize: "12px",
                  color: "#6b7280",
                  marginTop: "2px",
                }}
              >
                {previewState.scopeSummary}
              </div>,
              null,
            )}
          </div>
        </div>
      ),
      refreshToken: refreshTokenHandler({ auth }),
      bgUpdater: bgRefreshHandler({ auth }),
    };
  },
);
`;

// Read from: packages/patterns/airtable/core/util/airtable-auth-manager.tsx
const AIRTABLE_AUTH_MANAGER_SOURCE = `/// <cts-enable />
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
 * \`\`\`typescript
 * const { auth, fullUI, isReady } = AirtableAuthManager({
 *   requiredScopes: ["data.records:read", "schema.bases:read"],
 * });
 *
 * if (!isReady) return;
 * // Use auth.accessToken for API calls
 *
 * return { [UI]: <div>{fullUI}</div> };
 * \`\`\`
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

/** Unified scope registry for the auth manager factory */
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

export const AirtableAuthManager = createAuthManager(
  AirtableAuthManagerDescriptor,
  AirtableAuth,
);

export default AirtableAuthManager;
`;

// Read from: packages/patterns/airtable/core/util/airtable-client.ts
const AIRTABLE_CLIENT_SOURCE = `/**
 * Airtable API client with automatic token refresh and retry logic.
 *
 * Usage:
 * \\\`\\\`\\\`typescript
 * import { AirtableClient } from "./util/airtable-client.ts";
 *
 * const client = new AirtableClient(authCell, { debugMode: true });
 * const bases = await client.listBases();
 * const tables = await client.listTables(baseId);
 * const records = await client.listRecords(baseId, tableId);
 * \\\`\\\`\\\`
 */
import { getPatternEnvironment, Writable } from "commontools";

const env = getPatternEnvironment();

import type { AirtableAuth as AirtableAuthType } from "../airtable-auth.tsx";

// ============================================================================
// TYPES
// ============================================================================

export interface AirtableClientConfig {
  retries?: number;
  delay?: number;
  debugMode?: boolean;
  /** External refresh callback for cross-piece token refresh */
  onRefresh?: () => Promise<void>;
}

export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  description?: string;
  primaryFieldId: string;
  fields: AirtableField[];
}

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface ListRecordsOptions {
  pageSize?: number;
  maxRecords?: number;
  view?: string;
  filterByFormula?: string;
  sort?: Array<{ field: string; direction?: "asc" | "desc" }>;
  fields?: string[];
}

// ============================================================================
// HELPERS
// ============================================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function debugLog(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.log("[AirtableClient]", ...args);
}

// ============================================================================
// CLIENT
// ============================================================================

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const AIRTABLE_META_BASE = "https://api.airtable.com/v0/meta";

export class AirtableClient {
  private authCell: Writable<AirtableAuthType>;
  private retries: number;
  private delay: number;
  private debugMode: boolean;
  private onRefresh?: () => Promise<void>;

  constructor(
    authCell: Writable<AirtableAuthType>,
    config: AirtableClientConfig = {},
  ) {
    this.authCell = authCell;
    this.retries = config.retries ?? 2;
    this.delay = config.delay ?? 1000;
    this.debugMode = config.debugMode ?? false;
    this.onRefresh = config.onRefresh;
  }

  private getToken(): string {
    const auth = this.authCell.get();
    return auth?.accessToken || "";
  }

  /**
   * Make an authenticated API request with retry and token refresh.
   */
  private async request<T>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const token = this.getToken();
      if (!token) {
        throw new Error("No access token available");
      }

      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            Authorization: \\\`Bearer \\\${token}\\\`,
            "Content-Type": "application/json",
            ...options.headers,
          },
        });

        if (response.status === 401) {
          debugLog(this.debugMode, "Got 401, attempting token refresh...");
          await this.refreshToken();
          continue;
        }

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter
            ? parseInt(retryAfter) * 1000
            : this.delay * (attempt + 1);
          debugLog(
            this.debugMode,
            \\\`Rate limited, waiting \\\${waitMs}ms...\\\`,
          );
          await sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(
            \\\`Airtable API error \\\${response.status}: \\\${errorBody}\\\`,
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.retries) {
          debugLog(
            this.debugMode,
            \\\`Request failed (attempt \\\${attempt + 1}/\\\${this.retries + 1}):\\\`,
            lastError.message,
          );
          await sleep(this.delay);
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  /**
   * Refresh the access token via the server endpoint.
   */
  private async refreshToken(): Promise<void> {
    if (this.onRefresh) {
      await this.onRefresh();
      return;
    }

    const auth = this.authCell.get();
    const refreshToken = auth?.refreshToken;
    if (!refreshToken) {
      throw new Error("No refresh token available");
    }

    const res = await fetch(
      new URL("/api/integrations/airtable-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      },
    );

    if (!res.ok) {
      throw new Error(\\\`Token refresh failed: \\\${res.status}\\\`);
    }

    const json = await res.json();
    if (!json.tokenInfo) {
      throw new Error("Invalid refresh response");
    }

    this.authCell.update({
      ...json.tokenInfo,
      user: auth.user,
    });

    debugLog(this.debugMode, "Token refreshed successfully");
  }

  // ==========================================================================
  // API METHODS
  // ==========================================================================

  /**
   * List all accessible bases.
   */
  async listBases(): Promise<AirtableBase[]> {
    debugLog(this.debugMode, "Listing bases...");

    const bases: AirtableBase[] = [];
    let offset: string | undefined;

    do {
      const url = new URL(\\\`\\\${AIRTABLE_META_BASE}/bases\\\`);
      if (offset) url.searchParams.set("offset", offset);

      const response = await this.request<{
        bases: AirtableBase[];
        offset?: string;
      }>(url.toString());

      bases.push(...response.bases);
      offset = response.offset;
    } while (offset);

    debugLog(this.debugMode, \\\`Found \\\${bases.length} bases\\\`);
    return bases;
  }

  /**
   * List all tables in a base.
   */
  async listTables(baseId: string): Promise<AirtableTable[]> {
    debugLog(this.debugMode, \\\`Listing tables for base \\\${baseId}...\\\`);

    const response = await this.request<{ tables: AirtableTable[] }>(
      \\\`\\\${AIRTABLE_META_BASE}/bases/\\\${baseId}/tables\\\`,
    );

    debugLog(this.debugMode, \\\`Found \\\${response.tables.length} tables\\\`);
    return response.tables;
  }

  /**
   * List records from a table with pagination.
   */
  async listRecords(
    baseId: string,
    tableIdOrName: string,
    options: ListRecordsOptions = {},
  ): Promise<AirtableRecord[]> {
    debugLog(
      this.debugMode,
      \\\`Listing records from \\\${baseId}/\\\${tableIdOrName}...\\\`,
    );

    const records: AirtableRecord[] = [];
    let offset: string | undefined;
    const maxRecords = options.maxRecords ?? 1000;

    do {
      const url = new URL(
        \\\`\\\${AIRTABLE_API_BASE}/\\\${baseId}/\\\${encodeURIComponent(tableIdOrName)}\\\`,
      );

      if (options.pageSize) {
        url.searchParams.set(
          "pageSize",
          String(Math.min(options.pageSize, 100)),
        );
      }
      if (offset) url.searchParams.set("offset", offset);
      if (options.view) url.searchParams.set("view", options.view);
      if (options.filterByFormula) {
        url.searchParams.set("filterByFormula", options.filterByFormula);
      }
      if (options.fields) {
        for (const field of options.fields) {
          url.searchParams.append("fields[]", field);
        }
      }
      if (options.sort) {
        for (let i = 0; i < options.sort.length; i++) {
          url.searchParams.set(\\\`sort[\\\${i}][field]\\\`, options.sort[i].field);
          if (options.sort[i].direction) {
            url.searchParams.set(
              \\\`sort[\\\${i}][direction]\\\`,
              options.sort[i].direction!,
            );
          }
        }
      }

      const response = await this.request<{
        records: AirtableRecord[];
        offset?: string;
      }>(url.toString());

      records.push(...response.records);
      offset = response.offset;

      if (records.length >= maxRecords) {
        break;
      }
    } while (offset);

    const result = records.slice(0, maxRecords);
    debugLog(this.debugMode, \\\`Fetched \\\${result.length} records\\\`);
    return result;
  }
}`;

// Read from: packages/patterns/airtable/airtable-importer.tsx
const AIRTABLE_IMPORTER_SOURCE = `/// <cts-enable />
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

import {
  AirtableAuthManager,
  type ScopeKey,
} from "./core/util/airtable-auth-manager.tsx";
import { AirtableClient } from "./core/util/airtable-client.ts";
import type { AirtableAuth } from "./core/airtable-auth.tsx";

// ============================================================================
// TYPES
// ============================================================================

/** An Airtable record with its fields */
type AirtableRecordData = {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
};

type BaseInfo = { id: string; name: string };
type TableInfo = { id: string; name: string };

interface Input {
  selectedBaseId: Default<string, "">;
  selectedTableId: Default<string, "">;
}

/** Import records from an Airtable base. #airtableImporter */
interface Output {
  records: readonly AirtableRecordData[];
  bases: readonly BaseInfo[];
  tables: readonly TableInfo[];
  selectedBaseId: string;
  selectedTableId: string;
  selectedBaseName: string;
  selectedTableName: string;
  recordCount: number;
}

// ============================================================================
// REQUIRED SCOPES
// ============================================================================

const REQUIRED_SCOPES: ScopeKey[] = [
  "data.records:read",
  "schema.bases:read",
];

// ============================================================================
// MODULE-SCOPE HANDLERS
// ============================================================================

const fetchBases = handler<
  unknown,
  {
    auth: Writable<AirtableAuth>;
    bases: Writable<BaseInfo[]>;
    loading: Writable<boolean>;
    error: Writable<string>;
  }
>(async (_event, { auth, bases, loading, error }) => {
  loading.set(true);
  error.set("");
  try {
    const client = new AirtableClient(auth);
    const result = await client.listBases();
    bases.set(result.map((b) => ({ id: b.id, name: b.name })));
  } catch (e) {
    error.set(e instanceof Error ? e.message : String(e));
  } finally {
    loading.set(false);
  }
});

const fetchTables = handler<
  unknown,
  {
    auth: Writable<AirtableAuth>;
    baseId: string;
    tables: Writable<TableInfo[]>;
    loading: Writable<boolean>;
    error: Writable<string>;
  }
>(async (_event, { auth, baseId, tables, loading, error }) => {
  if (!baseId) return;
  loading.set(true);
  error.set("");
  try {
    const client = new AirtableClient(auth);
    const result = await client.listTables(baseId);
    tables.set(result.map((t) => ({ id: t.id, name: t.name })));
  } catch (e) {
    error.set(e instanceof Error ? e.message : String(e));
  } finally {
    loading.set(false);
  }
});

const fetchRecords = handler<
  unknown,
  {
    auth: Writable<AirtableAuth>;
    baseId: string;
    tableId: string;
    records: Writable<AirtableRecordData[]>;
    loading: Writable<boolean>;
    error: Writable<string>;
  }
>(async (_event, { auth, baseId, tableId, records, loading, error }) => {
  if (!baseId || !tableId) return;
  loading.set(true);
  error.set("");
  try {
    const client = new AirtableClient(auth);
    const result = await client.listRecords(baseId, tableId, {
      maxRecords: 500,
    });
    records.set(
      result.map((r) => ({
        id: r.id,
        createdTime: r.createdTime,
        fields: r.fields,
      })),
    );
  } catch (e) {
    error.set(e instanceof Error ? e.message : String(e));
  } finally {
    loading.set(false);
  }
});

const onSelectBase = handler<
  { target: { dataset: { baseId: string } } },
  {
    selectedBaseId: Writable<string>;
    selectedTableId: Writable<string>;
    tables: Writable<TableInfo[]>;
    records: Writable<AirtableRecordData[]>;
  }
>((event, { selectedBaseId, selectedTableId, tables, records }) => {
  const baseId = event.target.dataset.baseId;
  if (!baseId) return;
  selectedBaseId.set(baseId);
  selectedTableId.set("");
  tables.set([]);
  records.set([]);
});

const onSelectTable = handler<
  { target: { dataset: { tableId: string } } },
  {
    selectedTableId: Writable<string>;
    records: Writable<AirtableRecordData[]>;
  }
>((event, { selectedTableId, records }) => {
  const tableId = event.target.dataset.tableId;
  if (!tableId) return;
  selectedTableId.set(tableId);
  records.set([]);
});

// ============================================================================
// PATTERN
// ============================================================================

export default pattern<Input, Output>(
  ({ selectedBaseId, selectedTableId }) => {
    // Auth manager
    const {
      auth: authResult,
      isReady,
      fullUI: authUI,
    } = AirtableAuthManager({
      requiredScopes: REQUIRED_SCOPES,
    });

    const auth = authResult as any;

    // State
    const bases = Writable.of<BaseInfo[]>([]);
    const tables = Writable.of<TableInfo[]>([]);
    const records = Writable.of<AirtableRecordData[]>([]);
    const loading = Writable.of(false);
    const error = Writable.of("");

    const hasBases = computed(() => bases.get().length > 0);
    const hasTables = computed(() => tables.get().length > 0);
    const hasRecords = computed(
      () => records.get().length > 0,
    );
    const recordCount = computed(
      () => records.get().length,
    );

    const selectedBaseName = computed(() => {
      if (!selectedBaseId) return "";
      const base = bases.get().find(
        (b) => b.id === selectedBaseId,
      );
      return base?.name || "";
    });

    const selectedTableName = computed(() => {
      if (!selectedTableId) return "";
      const table = tables.get().find(
        (t) => t.id === selectedTableId,
      );
      return table?.name || "";
    });

    // Bound handlers -- pass reactive inputs directly (no double-cast)
    const boundFetchBases = fetchBases({ auth, bases, loading, error });
    const boundFetchTables = fetchTables({
      auth,
      baseId: selectedBaseId,
      tables,
      loading,
      error,
    });
    const boundFetchRecords = fetchRecords({
      auth,
      baseId: selectedBaseId,
      tableId: selectedTableId,
      records,
      loading,
      error,
    });

    const boundSelectBase = onSelectBase({
      selectedBaseId,
      selectedTableId,
      tables,
      records,
    });
    const boundSelectTable = onSelectTable({
      selectedTableId,
      records,
    });

    // Column headers extracted from records
    const columnHeaders = computed(() => {
      const recs = records.get();
      if (recs.length === 0) return [] as string[];
      const allKeys = new Set<string>();
      for (const rec of recs.slice(0, 10)) {
        for (const key of Object.keys(rec.fields)) {
          allKeys.add(key);
        }
      }
      return Array.from(allKeys);
    });

    const hasBaseSelected = computed(() => !!selectedBaseId);
    const hasTableSelected = computed(() => !!selectedTableId);

    // Pre-compute base/table lists for JSX
    const baseListUI = computed(() =>
      bases.get().map((base) => (
        <button
          type="button"
          onClick={boundSelectBase}
          data-base-id={base.id}
          style={{
            padding: "10px 14px",
            backgroundColor: selectedBaseId === base.id ? "#e0f2fe" : "white",
            border: selectedBaseId === base.id
              ? "1px solid #18BFFF"
              : "1px solid #e0e0e0",
            borderRadius: "6px",
            cursor: "pointer",
            textAlign: "left",
            fontSize: "14px",
            fontWeight: selectedBaseId === base.id ? "600" : "normal",
          }}
        >
          {base.name}
        </button>
      ))
    );

    const tableListUI = computed(() =>
      tables.get().map((table) => (
        <button
          type="button"
          onClick={boundSelectTable}
          data-table-id={table.id}
          style={{
            padding: "10px 14px",
            backgroundColor: selectedTableId === table.id ? "#e0f2fe" : "white",
            border: selectedTableId === table.id
              ? "1px solid #18BFFF"
              : "1px solid #e0e0e0",
            borderRadius: "6px",
            cursor: "pointer",
            textAlign: "left",
            fontSize: "14px",
            fontWeight: selectedTableId === table.id ? "600" : "normal",
          }}
        >
          {table.name}
        </button>
      ))
    );

    // Precompute table rows as plain data
    const tableRows = computed(() => {
      const recs = records.get();
      const hdrs = columnHeaders;
      return recs.map((rec) => ({
        cells: hdrs.map((col) => formatCellValue(rec.fields[col])),
      }));
    });

    const hasError = computed(() => !!error.get());

    return {
      [NAME]: computed(() => {
        if (selectedBaseName && selectedTableName) {
          return \\\`Airtable: \\\${selectedBaseName} / \\\${selectedTableName}\\\`;
        }
        return "Airtable Importer";
      }),
      [UI]: (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            padding: "25px",
            maxWidth: "900px",
          }}
        >
          <h2 style={{ fontSize: "24px", fontWeight: "bold", margin: "0" }}>
            Airtable Importer
          </h2>

          {/* Auth section */}
          {authUI}

          {/* Main content - only when authenticated */}
          {ifElse(
            isReady,
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              {/* Base selection */}
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#f8f9fa",
                  borderRadius: "8px",
                  border: "1px solid #e0e0e0",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "12px",
                  }}
                >
                  <h3 style={{ fontSize: "16px", margin: "0" }}>
                    Select a Base
                  </h3>
                  <button
                    type="button"
                    onClick={boundFetchBases}
                    disabled={loading}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: loading ? "#93c5fd" : "#18BFFF",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      cursor: loading ? "not-allowed" : "pointer",
                      fontWeight: "500",
                      fontSize: "14px",
                    }}
                  >
                    {ifElse(loading, "Loading...", "Load Bases")}
                  </button>
                </div>

                {ifElse(
                  hasBases,
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    {baseListUI}
                  </div>,
                  <p style={{ color: "#666", fontSize: "14px", margin: "0" }}>
                    Click "Load Bases" to see your Airtable bases.
                  </p>,
                )}
              </div>

              {/* Table selection */}
              {ifElse(
                hasBaseSelected,
                <div
                  style={{
                    padding: "16px",
                    backgroundColor: "#f8f9fa",
                    borderRadius: "8px",
                    border: "1px solid #e0e0e0",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "12px",
                    }}
                  >
                    <h3 style={{ fontSize: "16px", margin: "0" }}>
                      Select a Table from {selectedBaseName}
                    </h3>
                    <button
                      type="button"
                      onClick={boundFetchTables}
                      disabled={loading}
                      style={{
                        padding: "8px 16px",
                        backgroundColor: loading ? "#93c5fd" : "#18BFFF",
                        color: "white",
                        border: "none",
                        borderRadius: "6px",
                        cursor: loading ? "not-allowed" : "pointer",
                        fontWeight: "500",
                        fontSize: "14px",
                      }}
                    >
                      {ifElse(loading, "Loading...", "Load Tables")}
                    </button>
                  </div>

                  {ifElse(
                    hasTables,
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                      }}
                    >
                      {tableListUI}
                    </div>,
                    <p
                      style={{ color: "#666", fontSize: "14px", margin: "0" }}
                    >
                      Click "Load Tables" to see tables in this base.
                    </p>,
                  )}
                </div>,
                null,
              )}

              {/* Fetch records */}
              {ifElse(
                hasTableSelected,
                <div
                  style={{
                    padding: "16px",
                    backgroundColor: "#f8f9fa",
                    borderRadius: "8px",
                    border: "1px solid #e0e0e0",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "12px",
                    }}
                  >
                    <h3 style={{ fontSize: "16px", margin: "0" }}>
                      Records from {selectedTableName}
                    </h3>
                    <button
                      type="button"
                      onClick={boundFetchRecords}
                      disabled={loading}
                      style={{
                        padding: "8px 16px",
                        backgroundColor: loading ? "#93c5fd" : "#18BFFF",
                        color: "white",
                        border: "none",
                        borderRadius: "6px",
                        cursor: loading ? "not-allowed" : "pointer",
                        fontWeight: "500",
                        fontSize: "14px",
                      }}
                    >
                      {ifElse(loading, "Fetching...", "Fetch Records")}
                    </button>
                  </div>

                  {ifElse(
                    hasRecords,
                    <div>
                      <p
                        style={{
                          fontSize: "14px",
                          color: "#666",
                          margin: "0 0 12px 0",
                        }}
                      >
                        {recordCount} records loaded
                      </p>
                      <div
                        style={{
                          overflow: "auto",
                          maxHeight: "500px",
                          border: "1px solid #e0e0e0",
                          borderRadius: "6px",
                        }}
                      >
                        <table
                          style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontSize: "13px",
                          }}
                        >
                          <thead>
                            <tr
                              style={{
                                backgroundColor: "#f3f4f6",
                                position: "sticky",
                                top: "0",
                              }}
                            >
                              {columnHeaders.map((col) => (
                                <th
                                  style={{
                                    padding: "8px 12px",
                                    textAlign: "left",
                                    borderBottom: "2px solid #e0e0e0",
                                    fontWeight: "600",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {tableRows.map(
                              (row) => (
                                <tr>
                                  {row.cells.map((cell) => (
                                    <td
                                      style={{
                                        padding: "8px 12px",
                                        borderBottom: "1px solid #f0f0f0",
                                        maxWidth: "300px",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {cell}
                                    </td>
                                  ))}
                                </tr>
                              ),
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>,
                    <p
                      style={{ color: "#666", fontSize: "14px", margin: "0" }}
                    >
                      Click "Fetch Records" to load data from this table.
                    </p>,
                  )}
                </div>,
                null,
              )}

              {/* Error display */}
              {ifElse(
                hasError,
                <div
                  style={{
                    padding: "12px",
                    backgroundColor: "#fee2e2",
                    borderRadius: "8px",
                    border: "1px solid #ef4444",
                    fontSize: "14px",
                    color: "#dc2626",
                  }}
                >
                  <strong>Error:</strong> {error}
                </div>,
                null,
              )}
            </div>,
            null,
          )}
        </div>
      ),
      records: computed(() => records.get()),
      bases: computed(() => bases.get()),
      tables: computed(() => tables.get()),
      selectedBaseId,
      selectedTableId,
      selectedBaseName,
      selectedTableName,
      recordCount,
    };
  },
);

// ============================================================================
// HELPERS
// ============================================================================

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => formatCellValue(v)).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}`;

// ---------------------------------------------------------------------------
// Prompt generation
// ---------------------------------------------------------------------------

/**
 * Generate a comprehensive prompt for Claude to produce a complete importer
 * pattern suite for the given API provider.
 */
export function generateImporterPrompt(ctx: PromptContext): string {
  const {
    providerName,
    brandColor,
    api,
    providerConfig,
    primaryListEndpoint,
    primaryGetEndpoint,
  } = ctx;

  const pascalName = toPascalCase(providerName);
  const camelName = pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
  const hashTag = `#${camelName}Auth`;
  const providerLabel = pascalName;

  const sections: string[] = [];

  // =========================================================================
  // SECTION 1: System context — Pattern framework overview
  // =========================================================================
  sections.push(`<system>
You are generating Common Tools pattern files for the "${providerLabel}" API integration.

## Common Tools Pattern Framework

Common Tools patterns are reactive programs (similar to Solid.js components)
that define a reactive graph once upfront. They are NOT re-invoked like React
components.

### Imports

All patterns start with:
\`\`\`tsx
/// <cts-enable />
import {
  computed, Default, handler, ifElse, NAME, pattern, Secret,
  Stream, UI, Writable, getPatternEnvironment, wish, action, navigateTo,
} from "commontools";
\`\`\`

Import only what you need from the above list.

### Core Concepts

- **\`pattern<Input, Output>(fn)\`** — Defines a pattern. The function runs once
  and returns an object with output cells.
- **\`computed(() => expr)\`** — Derived reactive value. Re-evaluates when
  dependencies change. NEVER access \`wishResult[UI]\` inside a computed.
- **\`Writable.of(initialValue)\`** — Mutable reactive cell. Use \`.get()\` to read,
  \`.set(value)\` to write, \`.update(partial)\` for partial updates.
- **\`handler<EventType, ContextType>(async (event, context) => { ... })\`** —
  Async event handler. Declare at module scope, bind inside the pattern by
  passing context: \`myHandler({ cell1, cell2 })\`.
- **\`ifElse(condition, trueNode, falseNode)\`** — Conditional rendering.
  condition must be a reactive value (computed or cell).
- **\`wish<T>({ query, scope })\`** — Discover pieces across the space. Returns
  \`{ result, [UI] }\`. The \`[UI]\` is a picker component. NEVER access
  \`wishResult[UI]\` inside a \`computed()\` — it crashes the reactive graph.
  Scope values: \`"."\` means the current space, \`"~"\` means the user's home space.
- **\`action(() => expr)\`** — Create an inline handler inside the pattern body
  that closes over local variables (e.g. for navigation side-effects). Use
  \`handler()\` instead for module-scope handlers that receive context via binding.
- **\`navigateTo(piece)\`** — Navigate to another piece.
- **\`[NAME]\`** — Special symbol for the piece's display name.
- **\`[UI]\`** — Special symbol for the piece's rendered UI.
- **\`Default<T, D>\`** — Type with a default value. For mutable arrays in schemas,
  the standard pattern is \`Writable<Default<T[], []>>\`.
- **\`Secret<T>\`** — Type wrapper marking a value as secret.
- **\`Stream<T>\`** — Stateless channel. Written via \`.send()\`. Used for handlers
  that can be called from other pieces.

### UI Components

Use \`ct-*\` custom elements:

- \`<ct-oauth $auth={auth} scopes={scopes} provider="..." providerLabel="..." brandColor="..." loginEndpoint="..." tokenField="...">\` — OAuth flow component
- \`<ct-checkbox $checked={cell}>Label</ct-checkbox>\` — Checkbox with bidirectional binding
- \`<ct-input $value={cell} placeholder="..." />\` — Text input with bidirectional binding
- \`<ct-select $value={cell} items={[{label, value}]} />\` — Select dropdown
- \`<ct-button onClick={handler}>Label</ct-button>\` — Button
- \`<ct-card>...</ct-card>\` — Styled card container
- \`<ct-vstack gap={N}>...</ct-vstack>\` — Vertical stack layout
- \`<ct-render $cell={patternInstance} />\` — Render a sub-pattern

Native HTML elements (\`<div>\`, \`<table>\`, \`<button>\`) work with object-style
\`style={{ camelCase: "value" }}\`. Custom \`ct-*\` elements use string-style
\`style="kebab-case: value;"\`.

### Anti-Patterns to Avoid

1. **NEVER** access \`wishResult[UI]\` inside a \`computed()\` — crashes silently
2. **NEVER** use React patterns (useState, useEffect, etc.)
3. **NEVER** re-invoke the pattern function — it runs exactly once
4. \`computed()\` failures propagate silently — downstream values become undefined
5. Always use \`handler()\` for async operations (API calls), not inline async
6. Use module-scope \`handler()\` definitions, bind inside the pattern
7. **NEVER** wrap JSX in \`computed()\` — the transformer automatically handles reactivity in JSX expressions

### File Structure Convention

For a provider named "acme":
\`\`\`
packages/patterns/acme/
  acme-importer.tsx          # Main importer pattern
  core/
    acme-auth.tsx            # Auth pattern (thin, uses ct-oauth)
    util/
      acme-auth-manager.tsx  # Auth manager (token lifecycle, wish-based discovery)
      acme-client.ts         # Typed API client with pagination + retry
\`\`\`
</system>`);

  // =========================================================================
  // SECTION 2: Reference implementations
  // =========================================================================
  sections.push(`<reference-implementations>
Study these working implementations carefully. Your generated code must follow
the same patterns exactly.

## Reference: Airtable Auth Pattern (airtable-auth.tsx)

${AIRTABLE_AUTH_SOURCE}

## Reference: Airtable Auth Manager (airtable-auth-manager.tsx)

${AIRTABLE_AUTH_MANAGER_SOURCE}

## Reference: Airtable API Client (airtable-client.ts)

${AIRTABLE_CLIENT_SOURCE}

## Reference: Airtable Importer (airtable-importer.tsx)

${AIRTABLE_IMPORTER_SOURCE}
</reference-implementations>`);

  // =========================================================================
  // SECTION 3: Extracted API information
  // =========================================================================
  sections.push(`<api-info>
## Provider: ${providerLabel}

- **Provider name (slug):** ${providerName}
- **Brand color:** ${brandColor}
- **Base URL:** ${api.baseUrl}
- **Security scheme:** ${providerConfig.securitySchemeType}${
    providerConfig.oauthFlowType ? ` (${providerConfig.oauthFlowType})` : ""
  }
${
    providerConfig.authorizationEndpoint
      ? `- **Authorization endpoint:** ${providerConfig.authorizationEndpoint}`
      : ""
  }
${
    providerConfig.tokenEndpoint
      ? `- **Token endpoint:** ${providerConfig.tokenEndpoint}`
      : ""
  }

### OAuth2 Scopes

${
    Object.keys(providerConfig.scopes).length > 0
      ? Object.entries(providerConfig.scopes)
        .map(([scope, desc]) => `- \`${scope}\` — ${desc}`)
        .join("\n")
      : "(No scopes defined in the spec — the provider may use a flat token without scopes.)"
  }

### Pagination

${
    api.pagination
      ? `- **Style:** ${api.pagination.style}
- **Request param:** ${api.pagination.requestParam ?? "(not detected)"}
- **Response cursor path:** ${
        api.pagination.responseCursorPath ?? "(not detected)"
      }
- **Response data path:** ${api.pagination.responseDataPath ?? "(not detected)"}
- **Page size param:** ${api.pagination.pageSizeParam ?? "(not detected)"}`
      : "(No pagination pattern detected. Check endpoints below for cursor/offset params.)"
  }

${
    api.rateLimit
      ? `### Rate Limiting
- Requests per second: ${api.rateLimit.requestsPerSecond ?? "unknown"}
- Header: ${api.rateLimit.headerName ?? "unknown"}`
      : ""
  }

### Available Endpoints

${
    api.endpoints.map((ep) => {
      let block = `#### ${ep.method.toUpperCase()} ${ep.path}`;
      if (ep.summary) block += `\n${ep.summary}`;
      if (ep.description) block += `\n${ep.description}`;
      if (ep.isPaginated) {
        block += `\nPagination: ${ep.paginationStyle ?? "detected"}`;
      }

      const pathParams = ep.parameters.filter((p) => p.in === "path");
      const queryParams = ep.parameters.filter((p) => p.in === "query");

      if (pathParams.length) {
        block += "\n\nPath parameters:";
        for (const p of pathParams) {
          block += `\n  - \`${p.name}\`${p.required ? " (required)" : ""}${
            p.description ? `: ${p.description}` : ""
          } (${p.type})`;
        }
      }

      if (queryParams.length) {
        block += "\n\nQuery parameters:";
        for (const p of queryParams) {
          block += `\n  - \`${p.name}\`${p.required ? " (required)" : ""}${
            p.description ? `: ${p.description}` : ""
          } (${p.type})`;
        }
      }

      if (ep.responseSchema) {
        block += `\n\nResponse schema:\n\`\`\`json\n${
          JSON.stringify(ep.responseSchema, null, 2)
        }\n\`\`\``;
      }

      return block;
    }).join("\n\n")
  }

${
    primaryListEndpoint
      ? `### Primary List Endpoint (user hint): ${primaryListEndpoint}`
      : ""
  }
${
    primaryGetEndpoint
      ? `### Primary Get Endpoint (user hint): ${primaryGetEndpoint}`
      : ""
  }
</api-info>`);

  // =========================================================================
  // SECTION 4: Generation instructions
  // =========================================================================
  sections.push(`<instructions>
Generate four complete files for the **${providerLabel}** provider. Output each
file in a fenced code block with the file path as a comment on the first line.

## File 1: \`packages/patterns/${providerName}/core/${providerName}-auth.tsx\`

A thin auth pattern that wraps the \`<ct-oauth>\` component. Follow the Airtable
auth reference exactly, adapting for ${providerLabel}. Uses shared utilities
from \`../../auth/\` (auth-refresh, auth-reactive, auth-types, auth-ui-helpers):

- First line: \`/// <cts-enable />\`
- Export a type \`${pascalName}Auth\` with fields:
  - \`accessToken: Default<Secret<string>, "">\`  (or \`token\` if the provider uses that convention)
  - \`tokenType: Default<string, "">\`
  - \`scope: Default<string[], []>\`
  - \`expiresIn: Default<number, 0>\`
  - \`expiresAt: Default<number, 0>\`
  - \`refreshToken: Default<Secret<string>, "">\`
  - \`user: Default<{ email: string; name: string; picture: string }, { email: ""; name: ""; picture: "" }>\`
- Use the \`#${
    hashTag.slice(1)
  }\` tag in the Output interface JSDoc comment for wish() discovery
- Use \`<ct-oauth>\` with:
  - \`provider="${providerName}"\`
  - \`providerLabel="${providerLabel}"\`
  - \`brandColor="${brandColor}"\`
  - \`loginEndpoint="/api/integrations/${providerName}-oauth/login"\`
  - \`tokenField="accessToken"\`
- Handle token refresh via \`/api/integrations/${providerName}-oauth/refresh\`
- Include a \`bgUpdater\` stream handler for background-charm-service
- Define scope checkboxes matching the available scopes:
${
    Object.entries(providerConfig.scopes).map(([s, d]) =>
      `  - \`${s}\`: "${d}"`
    ).join("\n") || "  (define reasonable defaults based on the API endpoints)"
  }

## File 2: \`packages/patterns/${providerName}/core/util/${providerName}-auth-manager.tsx\`

Auth manager utility pattern. Uses the shared \`createAuthManager()\` factory — follow the Airtable auth manager reference exactly:

- First line: \`/// <cts-enable />\`
- Import \`createAuthManager\` from \`"../../../auth/create-auth-manager.tsx"\`
- Import \`AuthManagerDescriptor\` type from \`"../../../auth/auth-manager-descriptor.ts"\`
- Import the auth pattern: \`import ${pascalName}Auth from "../${providerName}-auth.tsx";\`
- Re-export shared types: \`AuthInfo\`, \`AuthState\`, \`TokenExpiryWarning\`, \`AuthManagerInput\`, \`AuthManagerOutput\`
- Re-export the auth type from the auth pattern
- Define a descriptor object with: name, displayName, brandColor (\`${brandColor}\`), wishTag (\`"${hashTag}"\`), tokenField, refreshEndpoint, scopeDescriptions, scopeKeysAreLiteral (true for Airtable-style, where scope keys ARE scope strings), hasAvatarSupport
- Call \`createAuthManager(descriptor, ${pascalName}Auth)\` and export result as both named and default
- This file should be ~50-70 lines total

## File 3: \`packages/patterns/${providerName}/core/util/${providerName}-client.ts\`

Typed API client class. Follow the Airtable client reference:

- Import \`getPatternEnvironment\` and \`Writable\` from "commontools"
- Import auth type from the auth pattern
- Base URL: \`${api.baseUrl}\`
- Implement:
  - \`private request<T>(url, options)\` with:
    - Bearer token auth from \`this.authCell.get().accessToken\`
    - Retry logic (default 2 retries)
    - 401 -> auto refresh token via \`/api/integrations/${providerName}-oauth/refresh\`
    - 429 -> respect Retry-After header${
    api.rateLimit?.requestsPerSecond
      ? `, max ${api.rateLimit.requestsPerSecond} req/s`
      : ""
  }
  - \`private refreshToken()\` — calls the server refresh endpoint
  - Public methods for each key API endpoint, with proper TypeScript types
  - Pagination support using the ${api.pagination?.style ?? "detected"} pattern:
${
    api.pagination
      ? `    - Request param: \`${api.pagination.requestParam}\`
    - Response cursor: \`${api.pagination.responseCursorPath}\`
    - Data path: \`${api.pagination.responseDataPath}\``
      : "    - Implement based on the endpoint response schemas"
  }

## File 4: \`packages/patterns/${providerName}/${providerName}-importer.tsx\`

Main importer pattern. Follow the Airtable importer reference:

- First line: \`/// <cts-enable />\`
- Import from \`"commontools"\`: computed, Default, handler, ifElse, NAME, pattern, UI, Writable
- Import the auth manager and client
- Define module-scope \`handler()\` functions for each API call:
  - Each handler takes \`auth\`, relevant state cells (\`loading\`, \`error\`, result cells)
  - Each uses \`try/catch/finally\` with \`loading.set(true/false)\`
  - Creates a client instance: \`new ${pascalName}Client(auth)\`
- The pattern function:
  1. Creates auth manager: \`const { auth, isReady, fullUI: authUI } = ${pascalName}AuthManager({ requiredScopes: [...] })\`
  2. Defines Writable cells for mutable state (lists, loading, error)
  3. Defines computed cells for derived state (hasList, recordCount, etc.)
  4. Binds handlers with reactive context
  5. Returns [NAME], [UI], and data outputs
- UI structure:
  1. Title header
  2. \`{authUI}\` for auth status/picker
  3. \`ifElse(isReady, mainContent, null)\` — main content only when authenticated
  4. Inside main content:
     - Resource selection (hierarchical if applicable, like base -> table)
     - Fetch button with loading state: \`{ifElse(loading, "Loading...", "Fetch Data")}\`
     - Data display in an HTML \`<table>\` with sticky headers
     - Error display with \`ifElse(hasError, errorDiv, null)\`
  5. Use brand color \`${brandColor}\` for buttons and highlights

## Critical Patterns to Follow

1. **wish() for auth discovery** — Always use \`wish({ query: "${hashTag}", scope: [".", "~"] })\`
2. **handler() for async ops** — Define at module scope, bind inside pattern
3. **ifElse() for conditional rendering** — condition must be computed/cell, not raw boolean
4. **Writable.of() for mutable state** — Use \`.get()\` in handlers, \`.set()\` to update
5. **computed() for derived values** — Pure computations only, no side effects
6. **Token refresh on 401** — Client auto-refreshes via server endpoint
7. **No React patterns** — No useState, useEffect, hooks, or re-rendering
8. **Data in <table>** — Use standard HTML table with inline styles for data display
9. **First line: \`/// <cts-enable />\`** — Required for all .tsx pattern files
10. **Import from "commontools"** — Not from individual packages
</instructions>`);

  return sections.join("\n\n");
}
