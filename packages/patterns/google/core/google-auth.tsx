/// <cts-enable />
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";

type Secret<T> = T;

import { createRefreshFunction } from "../../auth/auth-refresh.ts";
import {
  REFRESH_THRESHOLD_MS,
  startReactiveClock,
} from "../../auth/auth-reactive.ts";
import type { AuthStatus } from "../../auth/auth-types.ts";
import {
  formatTokenExpiry,
  getScopeSummary,
  getSelectedScopeSummary,
  STATUS_CONFIG,
} from "../../auth/auth-ui-helpers.tsx";

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

/**
 * Helper to create preview UI for picker display.
 * Exported for use by wrapper patterns (google-auth-personal, google-auth-work).
 *
 * NOTE: Date.now() is captured at call time. This is intentional — the preview
 * is a snapshot shown in the picker card, not a live-updating display. The main
 * pattern UI has its own reactive clock for real-time expiry tracking.
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
    ? getScopeSummary(auth?.scope || [], SCOPE_SHORT_NAMES)
    : getSelectedScopeSummary(selectedScopes, SCOPE_KEY_SHORT_NAMES);

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
 * Use direct property access: `googleAuthPiece.auth`
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
   */
  refreshToken: Stream<Record<string, never>>;
  /** Background updater for proactive token refresh via background-charm-service */
  bgUpdater: Stream<Record<string, never>>;
}

// Create guarded refresh function for Google OAuth.
// Module-scope singleton is intentional: google-auth is loaded once per provider
// (google-auth-personal and google-auth-work are separate modules that compose
// this one, so each provider gets its own guard instance).
const refreshAuthToken = createRefreshFunction(
  "/api/integrations/google-oauth/refresh",
);

// Handler for refreshing OAuth tokens from UI button
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
      if (!didRefresh) return;
      refreshFailed.set(false);
    } catch {
      refreshing.set(false);
      refreshFailed.set(true);
    }
  },
);

// Helper function to get friendly scope name
const getScopeFriendlyName = (scope: string): string => {
  const friendly = Object.entries(SCOPE_MAP).find(
    ([, url]) => url === scope,
  );
  return friendly
    ? SCOPE_DESCRIPTIONS[friendly[0] as keyof typeof SCOPE_DESCRIPTIONS]
    : scope;
};

// Handler for refreshing tokens from other pieces (cross-piece calling)
const refreshTokenHandler = handler<
  Record<string, never>,
  { auth: Writable<Auth> }
>(async (_event, { auth }) => {
  await refreshAuthToken(auth);
});

// Background updater handler for proactive token refresh
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
    if (timeRemaining > REFRESH_THRESHOLD_MS) return;

    console.log("[google-auth bgUpdater] Token expiring soon, refreshing...");

    try {
      await refreshAuthToken(auth);
      console.log("[google-auth bgUpdater] Token refreshed successfully");
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = e instanceof Error ? e.message : String(e);
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

    const isTokenExpired = computed(() => {
      if (!auth?.token || !auth?.expiresAt) return false;
      return auth.expiresAt < now.get();
    });

    const tokenExpiryDisplay = computed(() =>
      formatTokenExpiry(auth?.expiresAt || 0, now.get())
    );

    // PERFORMANCE FIX: Pre-compute disabled state (same for all checkboxes)
    const checkboxesDisabled = computed(() => !!auth?.user?.email);

    const refreshing = Writable.of(false);
    const refreshFailed = Writable.of(false);

    const scopesDisplay = computed(() => scopes.join(", "));

    // Compact user chip for display in other patterns
    const hasEmail = computed(() => !!auth?.user?.email);
    const hasPicture = computed(() => !!auth?.user?.picture);
    const hasUserName = computed(() => !!auth?.user?.name);

    const userChipAvatar = ifElse(
      hasPicture,
      <img
        src={auth.user.picture}
        alt=""
        style={{ width: "24px", height: "24px", borderRadius: "50%" }}
      />,
      <span
        style={{
          width: "24px",
          height: "24px",
          borderRadius: "50%",
          backgroundColor: "#10b981",
          display: "inline-block",
        }}
      />,
    );

    const userChipEmailLine = ifElse(
      hasUserName,
      <div style={{ fontSize: "12px", color: "#6b7280" }}>
        {auth.user.email}
      </div>,
      null,
    );

    const userChip = ifElse(
      hasEmail,
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {userChipAvatar}
        <div>
          <div style={{ fontWeight: 500, fontSize: "14px" }}>
            {auth.user.name || auth.user.email}
          </div>
          {userChipEmailLine}
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
    );

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

    // Compound conditions for ifElse in JSX
    const showScopePreview = computed(() => !loggedIn && hasSelectedScopes);
    const showTokenStatus = computed(() =>
      !!auth?.user?.email && !isTokenExpired
    );

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
                Select permissions below and authenticate with Google
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
                  <cf-checkbox
                    $checked={selectedScopes[key as keyof SelectedScopes]}
                    disabled={checkboxesDisabled}
                  >
                    {description}
                  </cf-checkbox>
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
              You've selected new permissions. Click "Sign in with Google" below
              to grant access.
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
              Favorite this piece (click ⭐) to share your Google auth across
              all your patterns. Any pattern using{" "}
              <code>wish({"{"} query: "#googleAuth" {"}"})</code>{" "}
              will automatically find and use it.
            </div>,
            null,
          )}

          {/* Show selected scopes if no auth yet */}
          {ifElse(
            showScopePreview,
            <div style={{ fontSize: "14px", color: "#666" }}>
              Will request: {scopesDisplay}
            </div>,
            null,
          )}

          {/* Token expired warning with refresh button */}
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

          <cf-google-oauth
            $auth={auth}
            scopes={scopes}
          />

          {/* Show granted scopes if authenticated */}
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
              {grantedScopesUI}
            </div>,
            null,
          )}

          {/* Manual token refresh section - visible when authenticated and NOT expired */}
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
      refreshToken: refreshTokenHandler({ auth }),
      bgUpdater: bgRefreshHandler({ auth }),
    };
  },
);
