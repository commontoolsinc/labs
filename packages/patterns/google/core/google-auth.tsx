/// <cts-enable />
import {
  computed,
  Default,
  getPatternEnvironment,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";

const env = getPatternEnvironment();

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
 * const auth = derive(googleAuthPiece, (piece) => piece?.auth);
 * ```
 *
 * ✅ CORRECT - maintains writable cell reference:
 * ```typescript
 * const auth = googleAuthPiece.auth;  // Property access, not derive
 * ```
 *
 * ✅ ALSO CORRECT - use ifElse for conditional auth sources:
 * ```typescript
 * const auth = ifElse(hasDirectAuth, directAuth, wishedPiece.auth);
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
   * Refresh the OAuth token. Call this from other pieces when the token expires.
   *
   * This handler runs in google-auth's transaction context, so it can write to
   * the auth cell even when called from another piece's handler.
   *
   * Usage from consuming piece:
   * ```typescript
   * await new Promise<void>((resolve, reject) => {
   *   authPiece.refreshToken.send({}, (tx) => {
   *     const status = tx.status();
   *     if (status.status === "done") resolve();
   *     else reject(status.error);
   *   });
   * });
   * ```
   */
  refreshToken: Stream<Record<string, never>>;
  /** Background updater for proactive token refresh via background-charm-service */
  bgUpdater: Stream<Record<string, never>>;
}

/**
 * Shared token refresh logic. Calls the server refresh endpoint and updates
 * the auth cell with new token data. Throws on failure.
 *
 * Guarded against concurrent invocations — if a refresh is already in progress,
 * subsequent calls return silently (no-op, no error). Callers that need to know
 * whether a refresh actually happened should watch the auth cell reactively.
 */
let refreshInProgress = false;

async function refreshAuthToken(
  authCell: Writable<Auth>,
): Promise<boolean> {
  if (refreshInProgress) return false;
  refreshInProgress = true;

  try {
    const currentAuth = authCell.get();
    const refreshToken = currentAuth?.refreshToken;

    if (!refreshToken) {
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
      const error = new Error(
        `Token refresh failed: ${res.status} ${errorText}`,
      ) as Error & { status: number };
      error.status = res.status;
      throw error;
    }

    const json = await res.json();
    if (!json.tokenInfo) {
      throw new Error("Invalid refresh response: no tokenInfo");
    }

    authCell.update({
      ...json.tokenInfo,
      user: currentAuth.user,
    });
    return true;
  } finally {
    refreshInProgress = false;
  }
}

// Handler for refreshing OAuth tokens from UI button.
// Must be at module scope (sandbox rule) and uses handler() (not action()) because
// the auth cell is typed as OpaqueCell in pattern context — handler bindings allow
// explicit Writable<Auth> typing which matches the runtime type.
const handleRefresh = handler<
  unknown,
  {
    auth: Writable<Auth>;
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
      if (!didRefresh) {
        // Another refresh was already in-flight; don't claim success or failure.
        // The UI will update reactively when the other refresh completes.
        return;
      }
      refreshFailed.set(false);
    } catch {
      refreshing.set(false);
      refreshFailed.set(true);
    }
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
 * auth cell even when called from another piece. This solves the cross-piece
 * write isolation issue where a consuming piece's handler cannot write to
 * cells owned by a different piece's DID.
 *
 * The handler reads the current refreshToken from the auth cell, calls the
 * server refresh endpoint, and updates the auth cell with the new token.
 */
const refreshTokenHandler = handler<
  Record<string, never>,
  { auth: Writable<Auth> }
>(async (_event, { auth }) => {
  authDebugLog("refreshTokenHandler called");
  authDebugLog(
    "Current token (first 20 chars):",
    auth.get()?.token?.slice(0, 20),
  );
  authDebugLog("Has refreshToken:", !!auth.get()?.refreshToken);

  await refreshAuthToken(auth);

  authDebugLog("Token refreshed successfully");
  authDebugLog(
    "New token (first 20 chars):",
    auth.get()?.token?.slice(0, 20),
  );
});

// TODO(CT-1163): Replace with wish("#now:30000") when reactive time wish is available.
// Date.now() is non-idiomatic (will be blocked in future sandbox versions).
// This setInterval workaround makes time-dependent computeds reactive.
// Interval is intentionally never cleared — pattern lifecycle matches page lifecycle.
function startReactiveClock(cell: Writable<number>): void {
  setInterval(() => cell.set(Date.now()), 30_000);
}

// Threshold: refresh when less than 10 minutes remain
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Background updater handler for proactive token refresh.
 *
 * When google-auth is registered with background-charm-service, this handler
 * is called every ~60 seconds. It checks if the token is about to expire
 * (< 10 min remaining) and refreshes it proactively, preventing expiry.
 */
const bgRefreshHandler = handler<
  Record<string, never>,
  { auth: Writable<Auth> }
>(
  async (_event, { auth }) => {
    const currentAuth = auth.get();
    if (!currentAuth?.token || !currentAuth?.refreshToken) return;

    const expiresAt = currentAuth.expiresAt ?? 0;
    if (expiresAt <= 0) return;

    const timeRemaining = expiresAt - Date.now();
    if (timeRemaining > REFRESH_THRESHOLD_MS) return; // Still fresh, skip

    console.log("[google-auth bgUpdater] Token expiring soon, refreshing...");

    try {
      await refreshAuthToken(auth);
      console.log("[google-auth bgUpdater] Token refreshed successfully");
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = e instanceof Error ? e.message : String(e);
      // Permanent failures (revoked token, invalid grant) — clear auth entirely
      // so the UI shows "not authenticated" instead of silently retrying forever.
      // 400 = invalid_grant, 401 = invalid credentials, 403 = token revoked
      if (status === 400 || status === 401 || status === 403) {
        console.error(
          "[google-auth bgUpdater] Permanent refresh failure, clearing auth:",
          msg,
        );
        auth.set({
          token: "",
          tokenType: "",
          scope: [],
          expiresIn: 0,
          expiresAt: 0,
          refreshToken: "",
          user: { email: "", name: "", picture: "" },
        });
      } else {
        // Transient failure (network, 5xx) — log and retry next cycle
        console.error(
          "[google-auth bgUpdater] Transient refresh failure:",
          msg,
        );
      }
    }
  },
);

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

    const now = Writable.of(Date.now());
    startReactiveClock(now);

    // Check if token is expired (need refresh)
    const isTokenExpired = computed(() => {
      if (!auth?.token || !auth?.expiresAt) return false;
      return auth.expiresAt < now.get();
    });

    // Format time remaining until token expiry
    const tokenExpiryDisplay = computed(() => {
      if (!auth?.expiresAt || auth.expiresAt === 0) return null;
      const currentTime = now.get();
      const remaining = auth.expiresAt - currentTime;
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

    // UI feedback state for token refresh
    const refreshing = Writable.of(false);
    const refreshFailed = Writable.of(false);

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

    const loggedIn = computed(() => !!auth?.user?.email);

    const grantedScopesUI = computed(() => {
      const scopes = auth.scope;
      if (!scopes || scopes.length === 0) {
        return <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }} />;
      }
      const friendlyScopes = scopes.map(getScopeFriendlyName) as string[];
      return (
        <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
          {friendlyScopes.map((scope) => <li>{scope}</li>)}
        </ul>
      );
    });

    return {
      [NAME]: computed(() => {
        if (loggedIn) {
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
              {/* PERFORMANCE FIX: Reference pre-computed cells, no computed() inside .map() */}
              {Object.entries(SCOPE_DESCRIPTIONS).map(([key, description]) => (
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
                You've selected new permissions. Click "Sign in with Google"
                below to grant access.
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
              Favorite this piece (click ⭐) to share your Google auth across
              all your patterns. Any pattern using{" "}
              <code>wish({"{"} query: "#googleAuth" {"}"})</code>{" "}
              will automatically find and use it.
            </div>
          )}

          {/* Show selected scopes if no auth yet */}
          {(!loggedIn && hasSelectedScopes) &&
            (
              <div style={{ fontSize: "14px", color: "#666" }}>
                Will request: {scopesDisplay}
              </div>
            )}

          {/* Token expired warning with refresh button */}
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
                  Your Google token has expired. Click below to refresh it
                  automatically.
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

          <ct-google-oauth
            $auth={auth}
            scopes={scopes}
          />

          {/* Show granted scopes if authenticated */}
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
                {grantedScopesUI}
              </div>
            )}

          {/* Manual token refresh section - visible when authenticated and NOT expired */}
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
            This piece provides unified Google OAuth authentication. Link its
            {" "}
            <code>auth</code> output to any Google importer piece's{" "}
            <code>auth</code> input, or favorite it for automatic discovery.
          </div>
        </div>
      ),
      auth,
      scopes,
      selectedScopes,
      userChip,
      previewUI,
      // Export the refresh handler for cross-piece calling
      refreshToken: refreshTokenHandler({ auth }),
      // Background updater for proactive token refresh via background-charm-service
      bgUpdater: bgRefreshHandler({ auth }),
    };
  },
);
