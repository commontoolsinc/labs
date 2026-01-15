/// <cts-enable />
import {
  computed,
  Default,
  getRecipeEnvironment,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";

const env = getRecipeEnvironment();

// Debug logging - set to true when debugging token refresh issues
const DEBUG_AUTH = false;

function authDebugLog(...args: unknown[]) {
  if (DEBUG_AUTH) console.log("[google-auth]", ...args);
}

type CFC<T, C extends string> = T;
type Secret<T> = CFC<T, "secret">;

// Scope mapping for Google APIs
const SCOPE_MAP = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  calendarWrite: "https://www.googleapis.com/auth/calendar.events",
  drive: "https://www.googleapis.com/auth/drive",
  docs: "https://www.googleapis.com/auth/documents.readonly",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
} as const;

const SCOPE_DESCRIPTIONS = {
  gmail: "Gmail (read emails)",
  gmailSend: "Gmail (send emails)",
  gmailModify: "Gmail (add/remove labels)",
  calendar: "Calendar (read events)",
  calendarWrite: "Calendar (create/edit/delete events)",
  drive: "Drive (read/write files & comments)",
  docs: "Docs (read document content)",
  contacts: "Contacts (read contacts)",
} as const;

// Short names for scope summary display in previewUI
const SCOPE_SHORT_NAMES: Record<string, string> = {
  "https://www.googleapis.com/auth/gmail.readonly": "Gmail",
  "https://www.googleapis.com/auth/gmail.send": "Gmail Send",
  "https://www.googleapis.com/auth/gmail.modify": "Gmail",
  "https://www.googleapis.com/auth/calendar.readonly": "Calendar",
  "https://www.googleapis.com/auth/calendar.events": "Calendar",
  "https://www.googleapis.com/auth/drive": "Drive",
  "https://www.googleapis.com/auth/documents.readonly": "Docs",
  "https://www.googleapis.com/auth/contacts.readonly": "Contacts",
};

// Short names for scope keys (for configured scopes summary)
const SCOPE_KEY_SHORT_NAMES: Record<string, string> = {
  gmail: "Gmail",
  gmailSend: "Gmail",
  gmailModify: "Gmail",
  calendar: "Calendar",
  calendarWrite: "Calendar",
  drive: "Drive",
  docs: "Docs",
  contacts: "Contacts",
};

/** Get scope summary from granted scope URLs - exported for wrapper patterns */
export function getScopeSummary(grantedScopes: string[]): string {
  const names = new Set<string>();
  for (const scope of grantedScopes) {
    const name = SCOPE_SHORT_NAMES[scope];
    if (name) names.add(name);
  }
  const arr = Array.from(names);
  if (arr.length === 0) return "";
  if (arr.length <= 3) return arr.join(", ");
  return `${arr.slice(0, 2).join(", ")} +${arr.length - 2} more`;
}

/** Get scope summary from configured scope flags (for unauthenticated preview) */
function getConfiguredScopeSummary(
  selectedScopes: Record<string, boolean>,
): string {
  const names = new Set<string>();
  for (const [key, enabled] of Object.entries(selectedScopes)) {
    if (enabled) {
      const name = SCOPE_KEY_SHORT_NAMES[key];
      if (name) names.add(name);
    }
  }
  const arr = Array.from(names);
  if (arr.length === 0) return "";
  if (arr.length <= 3) return arr.join(", ");
  return `${arr.slice(0, 2).join(", ")} +${arr.length - 2} more`;
}

// Status indicator configuration
const STATUS_CONFIG = {
  ready: { dot: "#22c55e", bg: "#f0fdf4" },
  warning: { dot: "#eab308", bg: "#fefce8" },
  expired: { dot: "#ef4444", bg: "#fef2f2" },
  "needs-login": { dot: "#9ca3af", bg: "#f9fafb" },
} as const;

type AuthStatus = keyof typeof STATUS_CONFIG;

/**
 * Helper to create preview UI for picker display.
 * Exported for use by wrapper patterns (google-auth-personal, google-auth-work).
 */
export function createPreviewUI(
  auth: Auth | undefined,
  selectedScopes: Record<string, boolean>,
  badge?: { text: string; color: string },
): JSX.Element {
  const email = auth?.user?.email;
  const picture = auth?.user?.picture;
  const name = auth?.user?.name;
  const isAuthenticated = !!email;

  // Status detection
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

  // Show configured scopes when not logged in, granted when logged in
  const scopeSummary = isAuthenticated
    ? getScopeSummary(auth?.scope || [])
    : getConfiguredScopeSummary(selectedScopes);

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
      {/* Avatar with status dot overlay */}
      <div style={{ position: "relative", flexShrink: 0 }}>
        {picture
          ? (
            <img
              src={picture}
              alt=""
              style={{ width: "36px", height: "36px", borderRadius: "50%" }}
            />
          )
          : (
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "50%",
                backgroundColor: isAuthenticated ? "#10b981" : "#e5e7eb",
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
          )}
        {/* Status dot */}
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

      {/* Optional badge */}
      {badge && (
        <span
          style={{
            background: badge.color,
            color: "white",
            padding: "2px 6px",
            borderRadius: "4px",
            fontSize: "10px",
            fontWeight: "600",
            flexShrink: 0,
          }}
        >
          {badge.text}
        </span>
      )}

      {/* User info */}
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
 * Auth data structure for Google OAuth tokens.
 *
 * ⚠️ CRITICAL: When consuming this auth from another pattern, DO NOT use derive()!
 *
 * The framework automatically refreshes expired tokens by writing to this cell.
 * If you derive() the auth, it becomes read-only and token refresh silently fails.
 *
 * ❌ WRONG - creates read-only projection, token refresh fails silently:
 * ```typescript
 * const auth = derive(googleAuthCharm, (charm) => charm?.auth);
 * ```
 *
 * ✅ CORRECT - maintains writable cell reference:
 * ```typescript
 * const auth = googleAuthCharm.auth;  // Property access, not derive
 * ```
 *
 * ✅ ALSO CORRECT - use ifElse for conditional auth sources:
 * ```typescript
 * const auth = ifElse(hasDirectAuth, directAuth, wishedCharm.auth);
 * ```
 *
 * See: community-docs/superstitions/2025-12-03-derive-creates-readonly-cells-use-property-access.md
 */
export type Auth = {
  token: Default<Secret<string>, "">;
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

// Selected scopes configuration - exported for wrapper patterns
export type SelectedScopes = {
  gmail: Default<boolean, false>;
  gmailSend: Default<boolean, false>;
  gmailModify: Default<boolean, false>;
  calendar: Default<boolean, false>;
  calendarWrite: Default<boolean, false>;
  drive: Default<boolean, false>;
  docs: Default<boolean, false>;
  contacts: Default<boolean, false>;
};

interface Input {
  selectedScopes: Default<SelectedScopes, {
    gmail: true;
    gmailSend: true;
    gmailModify: true;
    calendar: true;
    calendarWrite: true;
    drive: true;
    docs: true;
    contacts: true;
  }>;
  auth: Default<Auth, {
    token: "";
    tokenType: "";
    scope: [];
    expiresIn: 0;
    expiresAt: 0;
    refreshToken: "";
    user: { email: ""; name: ""; picture: "" };
  }>;
}

/** Google OAuth authentication for Google APIs. #googleAuth */
interface Output {
  auth: Auth;
  scopes: string[];
  selectedScopes: SelectedScopes;
  /** Compact user display with avatar, name, and email */
  userChip: unknown;
  /** Minimal preview for picker display with scope summary */
  previewUI: unknown;
  /**
   * Refresh the OAuth token. Call this from other charms when the token expires.
   *
   * This handler runs in google-auth's transaction context, so it can write to
   * the auth cell even when called from another charm's handler.
   *
   * Usage from consuming charm:
   * ```typescript
   * await new Promise<void>((resolve, reject) => {
   *   authCharm.refreshToken.send({}, (tx) => {
   *     const status = tx.status();
   *     if (status.status === "done") resolve();
   *     else reject(status.error);
   *   });
   * });
   * ```
   */
  refreshToken: Stream<Record<string, never>>;
}

// Handler for toggling scope selection
const toggleScope = handler<
  { target: { checked: boolean } },
  { selectedScopes: Writable<SelectedScopes>; scopeKey: string }
>(
  ({ target }, { selectedScopes, scopeKey }) => {
    const current = selectedScopes.get();
    selectedScopes.set({
      ...current,
      [scopeKey]: target.checked,
    });
  },
);

// Handler for refreshing OAuth tokens from UI button
// Must be at module scope, not inside pattern
const handleRefresh = handler<unknown, { auth: Writable<Auth> }>(
  async (_event, { auth: authCell }) => {
    const currentAuth = authCell.get();
    const refreshToken = currentAuth?.refreshToken;

    if (!refreshToken) {
      console.error("[google-auth] No refresh token available");
      throw new Error("No refresh token available");
    }

    const res = await fetch(
      new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      },
    );

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[google-auth] Refresh failed:", res.status, errorText);
      throw new Error(`Token refresh failed: ${res.status}`);
    }

    const json = await res.json();
    if (!json.tokenInfo) {
      console.error("[google-auth] No tokenInfo in response:", json);
      throw new Error("Invalid refresh response");
    }

    // Update auth with new token, keeping user info
    authCell.update({
      ...json.tokenInfo,
      user: currentAuth.user,
    });
  },
);

// Helper function to get friendly scope name
// Must be at module scope, not inside pattern
const getScopeFriendlyName = (scope: string): string => {
  const friendly = Object.entries(SCOPE_MAP).find(
    ([, url]) => url === scope,
  );
  return friendly
    ? SCOPE_DESCRIPTIONS[friendly[0] as keyof typeof SCOPE_DESCRIPTIONS]
    : scope;
};

/**
 * Handler for refreshing OAuth tokens.
 *
 * This runs in google-auth's transaction context, allowing it to write to the
 * auth cell even when called from another charm. This solves the cross-charm
 * write isolation issue where a consuming charm's handler cannot write to
 * cells owned by a different charm's DID.
 *
 * The handler reads the current refreshToken from the auth cell, calls the
 * server refresh endpoint, and updates the auth cell with the new token.
 */
const refreshTokenHandler = handler<
  Record<string, never>,
  { auth: Writable<Auth> }
>(async (_event, { auth }) => {
  authDebugLog("refreshTokenHandler called");
  const currentAuth = auth.get();
  const refreshToken = currentAuth?.refreshToken;

  authDebugLog(
    "Current token (first 20 chars):",
    currentAuth?.token?.slice(0, 20),
  );
  authDebugLog("Has refreshToken:", !!refreshToken);

  if (!refreshToken) {
    console.error("[google-auth] No refresh token available");
    throw new Error("No refresh token available");
  }

  authDebugLog("Refreshing OAuth token...");

  const res = await fetch(
    new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    },
  );

  if (!res.ok) {
    const errorText = await res.text();
    console.error("[google-auth] Refresh failed:", res.status, errorText);
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const json = await res.json();
  authDebugLog("Server response received");
  authDebugLog(
    "New token (first 20 chars):",
    json.tokenInfo?.token?.slice(0, 20),
  );
  authDebugLog("New expiresAt:", json.tokenInfo?.expiresAt);

  if (!json.tokenInfo) {
    console.error("[google-auth] No tokenInfo in response:", json);
    throw new Error("Invalid refresh response");
  }

  authDebugLog("Token refreshed successfully");

  // Update the auth cell with new token data
  // Keep existing user info since refresh doesn't return it
  authDebugLog("Calling auth.update()...");
  auth.update({
    ...json.tokenInfo,
    user: currentAuth.user,
  });
  authDebugLog("auth.update() completed");
  authDebugLog(
    "Verifying - token now (first 20 chars):",
    auth.get()?.token?.slice(0, 20),
  );
});

export default pattern<Input, Output>(
  ({ auth, selectedScopes }) => {
    // Compute active scopes based on selection
    const scopes = computed(() => {
      const base = ["email", "profile"];
      for (const [key, enabled] of Object.entries(selectedScopes)) {
        if (enabled && SCOPE_MAP[key as keyof typeof SCOPE_MAP]) {
          base.push(SCOPE_MAP[key as keyof typeof SCOPE_MAP]);
        }
      }
      return base;
    });

    // Track if any scope is selected (needed to enable auth)
    const hasSelectedScopes = computed(() =>
      Object.values(selectedScopes).some(Boolean)
    );

    // Check if re-auth is needed (selected scopes differ from granted scopes)
    const needsReauth = computed(() => {
      if (!auth?.token) return false;
      const grantedScopes: string[] = auth?.scope || [];
      for (const [key, enabled] of Object.entries(selectedScopes)) {
        const scopeUrl = SCOPE_MAP[key as keyof typeof SCOPE_MAP];
        if (enabled && scopeUrl && !grantedScopes.includes(scopeUrl)) {
          return true;
        }
      }
      return false;
    });

    // Check if token is expired (need refresh)
    const isTokenExpired = computed(() => {
      if (!auth?.token || !auth?.expiresAt) return false;
      return auth.expiresAt < Date.now();
    });

    // Format time remaining until token expiry
    const tokenExpiryDisplay = computed(() => {
      if (!auth?.expiresAt || auth.expiresAt === 0) return null;
      const now = Date.now();
      const remaining = auth.expiresAt - now;
      if (remaining <= 0) return "Expired";

      const minutes = Math.floor(remaining / (60 * 1000));
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;

      if (hours > 0) {
        return `${hours}h ${mins}m`;
      }
      return `${mins}m`;
    });

    // PERFORMANCE FIX: Pre-compute disabled state (same for all checkboxes)
    // Avoids creating computed() inside .map() loop
    // See: community-docs/superstitions/2025-12-16-expensive-computation-inside-map-jsx.md
    const checkboxesDisabled = computed(() => !!auth?.user?.email);

    // Pre-compute the scopes string for display
    const scopesDisplay = computed(() => scopes.join(", "));

    // Compact user chip for display in other patterns
    const userChip = computed(() => {
      if (!auth?.user?.email) {
        return (
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
          </div>
        );
      }
      return (
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {auth.user.picture
            ? (
              <img
                src={auth.user.picture}
                alt=""
                style={{ width: "24px", height: "24px", borderRadius: "50%" }}
              />
            )
            : (
              <span
                style={{
                  width: "24px",
                  height: "24px",
                  borderRadius: "50%",
                  backgroundColor: "#10b981",
                  display: "inline-block",
                }}
              />
            )}
          <div>
            <div style={{ fontWeight: 500, fontSize: "14px" }}>
              {auth.user.name || auth.user.email}
            </div>
            {auth.user.name && (
              <div style={{ fontSize: "12px", color: "#6b7280" }}>
                {auth.user.email}
              </div>
            )}
          </div>
        </div>
      );
    });

    // Minimal preview chip for picker display using shared helper
    const previewUI = computed(() =>
      createPreviewUI(auth, {
        gmail: selectedScopes.gmail,
        gmailSend: selectedScopes.gmailSend,
        gmailModify: selectedScopes.gmailModify,
        calendar: selectedScopes.calendar,
        calendarWrite: selectedScopes.calendarWrite,
        drive: selectedScopes.drive,
        docs: selectedScopes.docs,
        contacts: selectedScopes.contacts,
      })
    );

    return {
      [NAME]: computed(() => {
        if (auth?.user?.email) {
          return `Google Auth (${auth.user.email})`;
        }
        return "Google Auth";
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
            Google Authentication
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
              Status:{" "}
              {auth?.user?.email ? "Authenticated" : "Not Authenticated"}
            </h3>

            {auth?.user?.email
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
                  Select permissions below and authenticate with Google
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
              opacity: auth?.user?.email ? 0.7 : 1,
            }}
          >
            <h4 style={{ marginTop: "0", marginBottom: "12px" }}>
              Permissions
              {auth?.user?.email && (
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
              {/* PERFORMANCE FIX: Reference pre-computed cells, no computed() inside .map() */}
              {Object.entries(SCOPE_DESCRIPTIONS).map(([key, description]) => (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: auth?.user?.email ? "not-allowed" : "pointer",
                    color: auth?.user?.email ? "#9ca3af" : "inherit",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedScopes[key as keyof SelectedScopes]}
                    onChange={toggleScope({ selectedScopes, scopeKey: key })}
                    disabled={checkboxesDisabled}
                  />
                  <span>{description}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Re-auth warning */}
          {computed(() =>
            needsReauth
              ? (
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
                  You've selected new permissions. Click "Sign in with Google"
                  below to grant access.
                </div>
              )
              : null
          )}

          {/* Favorite reminder */}
          {auth?.user?.email && (
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
              Favorite this charm (click ⭐) to share your Google auth across
              all your patterns. Any pattern using{" "}
              <code>wish("#googleAuth")</code>{" "}
              will automatically find and use it.
            </div>
          )}

          {/* Show selected scopes if no auth yet */}
          {computed(() =>
            !auth?.user?.email && hasSelectedScopes
              ? (
                <div style={{ fontSize: "14px", color: "#666" }}>
                  Will request: {scopesDisplay}
                </div>
              )
              : null
          )}

          {/* Token expired warning with refresh button */}
          {computed(() =>
            isTokenExpired
              ? (
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
                    Your Google token has expired. Click below to refresh it
                    automatically.
                  </p>
                  <button
                    onClick={handleRefresh({ auth })}
                    style={{
                      padding: "10px 20px",
                      backgroundColor: "#3b82f6",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontWeight: "500",
                      fontSize: "14px",
                    }}
                  >
                    Refresh Token
                  </button>
                </div>
              )
              : null
          )}

          <ct-google-oauth
            $auth={auth}
            scopes={scopes}
          />

          {/* Show granted scopes if authenticated */}
          {auth?.user?.email && (
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
                {(auth?.scope || []).map((scope: string, i: number) => (
                  <li key={i}>{getScopeFriendlyName(scope)}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Manual token refresh section - visible when authenticated and NOT expired */}
          {computed(() =>
            auth?.user?.email && !isTokenExpired
              ? (
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
                      onClick={handleRefresh({ auth })}
                      style={{
                        padding: "8px 16px",
                        backgroundColor: "#0ea5e9",
                        color: "white",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: "500",
                        fontSize: "13px",
                      }}
                    >
                      Refresh Now
                    </button>
                  </div>
                </div>
              )
              : null
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
            This charm provides unified Google OAuth authentication. Link its
            {" "}
            <code>auth</code> output to any Google importer charm's{" "}
            <code>auth</code> input, or favorite it for automatic discovery.
          </div>
        </div>
      ),
      auth,
      scopes,
      selectedScopes,
      userChip,
      previewUI,
      // Export the refresh handler for cross-charm calling
      refreshToken: refreshTokenHandler({ auth }),
    };
  },
);
