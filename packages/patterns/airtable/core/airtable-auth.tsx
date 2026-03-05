/// <cts-enable />
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
 * Uses `accessToken` field (OAuth2TokenSchema convention).
 *
 * CRITICAL: When consuming from another pattern, DO NOT use derive()!
 * Use direct property access: `airtableAuthPiece.auth`
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

// Create guarded refresh function for Airtable OAuth
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
          return `Airtable Auth (${auth.user.email})`;
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
              Status: {loggedIn ? "Authenticated" : "Not Authenticated"}
            </h3>

            {loggedIn
              ? (
                <div>
                  <p style={{ margin: "8px 0" }}>
                    <strong>Email:</strong> {auth.user.email}
                  </p>
                  <p style={{ margin: "8px 0" }}>
                    <strong>Name:</strong> {auth.user.name}
                  </p>
                </div>
              )
              : (
                <p style={{ color: "#666" }}>
                  Select permissions below and authenticate with Airtable
                </p>
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
              {loggedIn && (
                <span
                  style={{
                    fontWeight: "normal",
                    fontSize: "12px",
                    color: "#6b7280",
                    marginLeft: "8px",
                  }}
                >
                  (locked while authenticated)
                </span>
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
          {needsReauth &&
            (
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
              </div>
            )}

          {/* Favorite reminder */}
          {loggedIn && (
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
            </div>
          )}

          {/* Show selected scopes */}
          {(!loggedIn && hasSelectedScopes) &&
            (
              <div style={{ fontSize: "14px", color: "#666" }}>
                Will request: {scopesDisplay}
              </div>
            )}

          {/* Token expired warning */}
          {isTokenExpired &&
            (
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
                  {refreshing ? "Refreshing..." : "Refresh Token"}
                </button>
                {refreshFailed && (
                  <p
                    style={{
                      margin: "8px 0 0 0",
                      fontSize: "13px",
                      color: "#dc2626",
                      fontWeight: "500",
                    }}
                  >
                    Refresh failed — try signing in again below.
                  </p>
                )}
              </div>
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
          {loggedIn &&
            (
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
              </div>
            )}

          {/* Token status when authenticated and NOT expired */}
          {(auth?.user?.email && !isTokenExpired) &&
            (
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
                    {refreshing ? "Refreshing..." : "Refresh Now"}
                  </button>
                </div>
              </div>
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
