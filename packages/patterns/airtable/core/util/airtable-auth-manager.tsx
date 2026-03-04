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

import {
  action,
  computed,
  Default,
  handler,
  ifElse,
  navigateTo,
  pattern,
  UI,
  wish,
  Writable,
} from "commontools";

import AirtableAuth, {
  type AirtableAuth as AirtableAuthType,
} from "../airtable-auth.tsx";

export type { AirtableAuthType };

// =============================================================================
// TYPES & CONSTANTS
// =============================================================================

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

/** Auth state enumeration */
export type AuthState =
  | "loading"
  | "needs-login"
  | "missing-scopes"
  | "token-expired"
  | "ready";

export type TokenExpiryWarning = "ok" | "warning" | "expired";

export interface AuthInfo {
  state: AuthState;
  auth: AirtableAuthType | null;
  authCell: unknown;
  email: string;
  hasRequiredScopes: boolean;
  grantedScopes: string[];
  missingScopes: ScopeKey[];
  tokenExpiresAt: number | null;
  isTokenExpired: boolean;
  tokenTimeRemaining: number | null;
  tokenExpiryWarning: TokenExpiryWarning;
  tokenExpiryDisplay: string;
  statusDotColor: string;
  statusText: string;
  piece: unknown;
  userChip: unknown;
}

export interface AirtableAuthManagerInput {
  requiredScopes?: Default<ScopeKey[], []>;
  debugMode?: Default<boolean, false>;
}

export interface AirtableAuthManagerOutput {
  auth: AirtableAuthType | null;
  authInfo: AuthInfo;
  isReady: boolean;
  currentEmail: string;
  currentState: AuthState;
  // deno-lint-ignore no-explicit-any
  pickerUI: any;
  // deno-lint-ignore no-explicit-any
  statusUI: any;
  // deno-lint-ignore no-explicit-any
  fullUI: any;
}

interface AirtableAuthPiece {
  auth?: AirtableAuthType;
  scopes?: string[];
  selectedScopes?: Record<ScopeKey, boolean>;
  userChip?: unknown;
  refreshToken?: unknown;
}

// Status colors
const STATUS_COLORS: Record<AuthState, string> = {
  loading: "var(--ct-color-yellow-500, #eab308)",
  "needs-login": "var(--ct-color-red-500, #ef4444)",
  "missing-scopes": "var(--ct-color-orange-500, #f97316)",
  "token-expired": "var(--ct-color-red-500, #ef4444)",
  ready: "var(--ct-color-green-500, #22c55e)",
};

const STATUS_MESSAGES: Record<AuthState, string> = {
  loading: "Loading auth...",
  "needs-login": "Please sign in to your Airtable",
  "missing-scopes": "Additional permissions needed",
  "token-expired": "Session expired - click Refresh Session",
  ready: "Connected",
};

const TOKEN_WARNING_THRESHOLD_MS = 10 * 60 * 1000;

function formatTimeRemaining(ms: number | null): string {
  if (ms === null) return "";
  if (ms <= 0) return "Expired";

  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMins = minutes % 60;
    return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
  }
  if (minutes > 0) return `${minutes} min`;
  return "< 1 min";
}

function debugLog(enabled: boolean, ...args: unknown[]) {
  if (enabled) console.log("[AirtableAuth]", ...args);
}

function startReactiveClock(cell: Writable<number>): void {
  setInterval(() => cell.set(Date.now()), 30_000);
}

// =============================================================================
// MODULE-SCOPE HANDLERS
// =============================================================================

const REFRESH_FAILURE_TIMEOUT_MS = 15_000;

const attemptRefresh = handler<
  unknown,
  {
    // deno-lint-ignore no-explicit-any
    refreshStream: any;
    refreshing: Writable<boolean>;
    refreshFailed: Writable<boolean>;
    refreshStartedAt: Writable<number>;
  }
>((_event, { refreshStream, refreshing, refreshFailed, refreshStartedAt }) => {
  if (!refreshStream?.send) {
    refreshFailed.set(true);
    return;
  }
  refreshing.set(true);
  refreshFailed.set(false);
  refreshStartedAt.set(Date.now());

  refreshStream.send({});

  setTimeout(() => {
    if (refreshing.get()) {
      refreshing.set(false);
      refreshFailed.set(true);
    }
  }, REFRESH_FAILURE_TIMEOUT_MS);
});

// =============================================================================
// MAIN PATTERN
// =============================================================================

export const AirtableAuthManager = pattern<
  AirtableAuthManagerInput,
  AirtableAuthManagerOutput
>(
  ({ requiredScopes, debugMode }) => {
    const wishResult = wish<AirtableAuthPiece>({
      query: "#airtableAuth",
      scope: [".", "~"],
    });

    const auth = wishResult.result.auth;

    // Small focused computeds
    const hasAuth = computed(() => !!auth);
    const hasToken = computed(() => !!auth?.accessToken);
    const hasEmail = computed(() => !!auth?.user?.email);

    const now = Writable.of(Date.now());
    startReactiveClock(now);

    const isTokenExpired = computed(() => {
      const expiresAt = auth?.expiresAt ?? 0;
      const value = expiresAt > 0 && expiresAt < now.get();
      debugLog(debugMode as boolean, "isTokenExpired:", value);
      return value;
    });

    const tokenTimeRemaining = computed((): number | null => {
      const expiresAt = auth?.expiresAt ?? 0;
      if (!expiresAt) return null;
      return expiresAt - now.get();
    });

    const tokenExpiryWarning = computed((): TokenExpiryWarning => {
      const tr = tokenTimeRemaining as number | null;
      if (tr === null) return "ok";
      if (tr < 0) return "expired";
      if (tr < TOKEN_WARNING_THRESHOLD_MS) return "warning";
      return "ok";
    });

    const tokenExpiryDisplay = computed(() =>
      formatTimeRemaining(tokenTimeRemaining as number | null)
    );

    // Scope verification
    const missingScopes = computed((): ScopeKey[] => {
      const granted: string[] = (auth?.scope ?? []) as string[];
      const value = (requiredScopes as ScopeKey[]).filter(
        (key) => !granted.includes(key),
      );
      debugLog(debugMode as boolean, "missingScopes:", value);
      return value;
    });
    const hasRequiredScopes = computed(
      () => (missingScopes as ScopeKey[]).length === 0,
    );

    // Picker UI - NOT inside computed
    const pickerUI = wishResult[UI];

    // State machine
    const currentState = computed((): AuthState => {
      let value: AuthState;
      if (!hasAuth) value = "loading";
      else if (!hasToken || !hasEmail) value = "needs-login";
      else if (!hasRequiredScopes) value = "missing-scopes";
      else if (isTokenExpired) value = "token-expired";
      else value = "ready";
      debugLog(debugMode as boolean, "state:", value);
      return value;
    });

    const isReady = computed(() => {
      const value = hasToken && hasEmail && !isTokenExpired &&
        hasRequiredScopes;
      debugLog(debugMode as boolean, "isReady:", value);
      return value;
    });
    const currentEmail = computed(() => auth?.user?.email ?? "");

    // Refresh state
    const refreshStream = wishResult.result.refreshToken;
    const refreshing = Writable.of(false);
    const refreshFailed = Writable.of(false);
    const refreshStartedAt = Writable.of(0);

    // Reactive watcher for refresh completion
    computed(() => {
      if (!refreshing.get()) return;
      const expiresAt = auth?.expiresAt ?? 0;
      if (expiresAt > now.get()) {
        refreshing.set(false);
        refreshFailed.set(false);
      }
    });

    const isRefreshing = computed(() => refreshing.get() === true);
    const hasRefreshFailed = computed(() => refreshFailed.get() === true);

    const statusDotColor = computed(
      () => STATUS_COLORS[currentState as AuthState] ?? STATUS_COLORS.loading,
    );

    const statusText = computed(() => {
      const state = currentState as AuthState;
      if (state === "ready") return `Signed in as ${currentEmail}`;
      if (state === "missing-scopes") {
        const names = (missingScopes as ScopeKey[])
          .map((k) => SCOPE_DESCRIPTIONS[k])
          .join(", ");
        return `Missing: ${names}`;
      }
      return STATUS_MESSAGES[state];
    });

    const authInfo = computed((): AuthInfo => ({
      state: currentState as AuthState,
      auth: auth ?? null,
      authCell: auth,
      email: currentEmail ?? "",
      hasRequiredScopes: hasRequiredScopes as boolean,
      grantedScopes: ((auth?.scope ?? []) as string[]).slice(),
      missingScopes: Array.from(missingScopes as ScopeKey[]),
      tokenExpiresAt: auth?.expiresAt ?? null,
      isTokenExpired: isTokenExpired as boolean,
      tokenTimeRemaining: tokenTimeRemaining as number | null,
      tokenExpiryWarning: tokenExpiryWarning as TokenExpiryWarning,
      tokenExpiryDisplay: tokenExpiryDisplay ?? "",
      statusDotColor: statusDotColor ?? STATUS_COLORS.loading,
      statusText: statusText ?? "",
      piece: wishResult.result ?? null,
      userChip: wishResult.result?.userChip ?? null,
    }));

    // Actions
    const createAuth = action(() => {
      const selected: Record<ScopeKey, boolean> = {
        "data.records:read": false,
        "data.records:write": false,
        "data.recordComments:read": false,
        "data.recordComments:write": false,
        "schema.bases:read": false,
        "schema.bases:write": false,
        "webhook:manage": false,
      };
      for (const scope of requiredScopes as ScopeKey[]) {
        if (scope in selected) selected[scope] = true;
      }
      return navigateTo(
        AirtableAuth({
          selectedScopes: selected,
          auth: {
            accessToken: "",
            tokenType: "",
            scope: [],
            expiresIn: 0,
            expiresAt: 0,
            refreshToken: "",
            user: { email: "", name: "", picture: "" },
          },
        }),
      );
    });

    const reauthenticate = action(() => navigateTo(wishResult.result));

    // ========================================================================
    // UI COMPONENTS
    // ========================================================================

    const statusBgColor = computed(() => {
      if (currentState !== "ready") return "#fef3c7";
      if (tokenExpiryWarning === "warning") return "#fef3c7";
      return "#d1fae5";
    });
    const showAvatar = computed(() => currentState === "ready");
    const showExpiryInStatus = computed(
      () => currentState === "ready" && !!tokenExpiryDisplay,
    );
    const expiryHintColor = computed(
      () => (tokenExpiryWarning === "warning" ? "#b45309" : "#666"),
    );
    const expiryHintWeight = computed(
      () => (tokenExpiryWarning === "warning" ? "500" : "normal"),
    );

    const statusUI = (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          borderRadius: "6px",
          backgroundColor: statusBgColor,
          fontSize: "14px",
        }}
      >
        {ifElse(
          showAvatar,
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              backgroundColor: "#18BFFF",
            }}
          />,
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              backgroundColor: statusDotColor,
            }}
          />,
        )}
        <span>{statusText}</span>
        {ifElse(
          showExpiryInStatus,
          <span
            style={{
              marginLeft: "4px",
              fontSize: "12px",
              color: expiryHintColor,
              fontWeight: expiryHintWeight,
            }}
          >
            • {tokenExpiryDisplay}
          </span>,
          null,
        )}
      </div>
    );

    // State boolean computeds for fullUI
    const isNeedsLogin = computed(() => currentState === "needs-login");
    const isMissingScopes = computed(() => currentState === "missing-scopes");
    const isTokenExpiredState = computed(
      () => currentState === "token-expired",
    );
    const isReadyState = computed(() => currentState === "ready");

    const scopesList = computed(() =>
      (requiredScopes as ScopeKey[]).map((k) => SCOPE_DESCRIPTIONS[k]).join(
        ", ",
      )
    );
    const missingScopesList = computed(() =>
      (missingScopes as ScopeKey[]).map((k) => SCOPE_DESCRIPTIONS[k]).join(
        ", ",
      )
    );

    const manageButtonStyle = {
      padding: "6px 12px",
      backgroundColor: "transparent",
      color: "#4b5563",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "13px",
    };
    const altButtonStyle = {
      padding: "6px 12px",
      backgroundColor: "transparent",
      color: "#18BFFF",
      border: "1px solid #18BFFF",
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "13px",
    };
    const actionRowStyle = {
      padding: "12px 16px",
      backgroundColor: "#f9fafb",
      display: "flex",
      gap: "12px",
      alignItems: "center",
    };

    // Loading UI
    const loadingUI = (
      <div
        style={{
          padding: "16px",
          backgroundColor: "#f3f4f6",
          borderRadius: "8px",
          border: "1px solid #d1d5db",
        }}
      >
        <h4 style={{ margin: "0 0 8px 0", color: "#374151" }}>
          Connect Your Airtable Account
        </h4>
        <p style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#4b5563" }}>
          To use this feature, connect an Airtable account with these
          permissions: {scopesList}
        </p>
        {pickerUI}
        <button
          type="button"
          onClick={createAuth}
          style={{
            padding: "10px 20px",
            backgroundColor: "#18BFFF",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontWeight: "500",
            fontSize: "14px",
          }}
        >
          Connect Airtable Account
        </button>
      </div>
    );

    // Needs login UI
    const needsLoginUI = (
      <div
        style={{
          borderRadius: "8px",
          border: "1px solid #ef4444",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            backgroundColor: "#fee2e2",
            borderBottom: "1px solid #ef4444",
          }}
        >
          <h4
            style={{ margin: "0 0 4px 0", color: "#dc2626", fontSize: "14px" }}
          >
            Sign In Required
          </h4>
          <div style={{ margin: "0", fontSize: "13px", color: "#4b5563" }}>
            Please sign in with your Airtable account to continue.
          </div>
        </div>
        {pickerUI}
        <div style={actionRowStyle}>
          <button
            type="button"
            onClick={reauthenticate}
            style={manageButtonStyle}
          >
            Manage this account
          </button>
          <button type="button" onClick={createAuth} style={altButtonStyle}>
            + Use different account
          </button>
        </div>
      </div>
    );

    // Missing scopes UI
    const missingScopesUI = (
      <div
        style={{
          borderRadius: "8px",
          border: "1px solid #f97316",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            backgroundColor: "#ffedd5",
            borderBottom: "1px solid #f97316",
          }}
        >
          <h4
            style={{ margin: "0 0 4px 0", color: "#c2410c", fontSize: "14px" }}
          >
            Additional Permissions Needed
          </h4>
          <div style={{ margin: "0", fontSize: "13px", color: "#4b5563" }}>
            Connected as <strong>{currentEmail}</strong>, but missing:{" "}
            {missingScopesList}
          </div>
        </div>
        {pickerUI}
        <div style={actionRowStyle}>
          <button
            type="button"
            onClick={reauthenticate}
            style={manageButtonStyle}
          >
            Manage this account
          </button>
          <button type="button" onClick={createAuth} style={altButtonStyle}>
            + Use different account
          </button>
        </div>
      </div>
    );

    // Token expired UI
    const tokenExpiredUI = (
      <div
        style={{
          borderRadius: "8px",
          border: "1px solid #ef4444",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            backgroundColor: "#fee2e2",
            borderBottom: "1px solid #ef4444",
          }}
        >
          <h4
            style={{ margin: "0 0 4px 0", color: "#dc2626", fontSize: "14px" }}
          >
            Session Expired
          </h4>
          <div style={{ margin: "0", fontSize: "13px", color: "#4b5563" }}>
            Your Airtable session has expired.
          </div>
          <div
            style={{
              marginTop: "12px",
              display: "flex",
              gap: "8px",
              alignItems: "center",
            }}
          >
            <button
              type="button"
              onClick={attemptRefresh({
                refreshStream,
                refreshing,
                refreshFailed,
                refreshStartedAt,
              })}
              disabled={isRefreshing}
              style={{
                padding: "8px 16px",
                backgroundColor: "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
                fontWeight: "500",
                fontSize: "14px",
              }}
            >
              {ifElse(isRefreshing, "Refreshing...", "Refresh Session")}
            </button>
            {ifElse(
              hasRefreshFailed,
              <span style={{ fontSize: "13px", color: "#dc2626" }}>
                Refresh failed — try signing in again below.
              </span>,
              null,
            )}
          </div>
        </div>
        {pickerUI}
        <div style={actionRowStyle}>
          <button
            type="button"
            onClick={reauthenticate}
            style={manageButtonStyle}
          >
            Manage this account
          </button>
          <button type="button" onClick={createAuth} style={altButtonStyle}>
            + Use different account
          </button>
        </div>
      </div>
    );

    // Ready UI
    const showTokenWarning = computed(() => tokenExpiryWarning === "warning");
    const readyBorderRadius = computed(() =>
      tokenExpiryWarning === "warning" ? "8px 8px 0 0" : "8px"
    );
    const readyBorderBottom = computed(() =>
      tokenExpiryWarning === "warning" ? "none" : "1px solid #10b981"
    );
    const showExpiryInReady = computed(() => !!tokenExpiryDisplay);

    const readyUI = (
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "12px 16px",
            backgroundColor: "#d1fae5",
            borderRadius: readyBorderRadius,
            border: "1px solid #10b981",
            borderBottom: readyBorderBottom,
          }}
        >
          {wishResult.result?.userChip as any}
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: "12px",
            }}
          >
            {ifElse(
              showExpiryInReady,
              <span style={{ fontSize: "12px", color: "#059669" }}>
                {tokenExpiryDisplay}
              </span>,
              null,
            )}
            <button
              type="button"
              onClick={reauthenticate}
              style={{
                background: "none",
                border: "none",
                color: "#047857",
                cursor: "pointer",
                fontSize: "12px",
                padding: "2px 6px",
                borderRadius: "4px",
              }}
            >
              Switch
            </button>
            <button
              type="button"
              onClick={createAuth}
              style={{
                background: "none",
                border: "none",
                color: "#047857",
                cursor: "pointer",
                fontSize: "12px",
                padding: "2px 6px",
                borderRadius: "4px",
              }}
            >
              + Add
            </button>
          </div>
        </div>
        {ifElse(
          showTokenWarning,
          <div
            style={{
              padding: "8px 16px",
              backgroundColor: "#fef3c7",
              borderRadius: "0 0 8px 8px",
              border: "1px solid #f59e0b",
              borderTop: "none",
              fontSize: "13px",
              color: "#b45309",
            }}
          >
            Token expires soon. You may need to re-authenticate shortly.
          </div>,
          null,
        )}
      </div>
    );

    // Refreshing UI
    const refreshingUI = (
      <div
        style={{
          padding: "12px 16px",
          backgroundColor: "#fef3c7",
          borderRadius: "8px",
          border: "1px solid #f59e0b",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "14px",
          color: "#b45309",
        }}
      >
        <style>
          {"@keyframes ct-auth-spin { to { transform: rotate(360deg); } }"}
        </style>
        <span
          style={{
            display: "inline-block",
            width: "14px",
            height: "14px",
            border: "2px solid #f59e0b",
            borderTop: "2px solid transparent",
            borderRadius: "50%",
            animation: "ct-auth-spin 1s linear infinite",
          }}
        />
        Refreshing session...
      </div>
    );

    // Compose fullUI via chained ifElse
    const loginOrLoad = ifElse(isNeedsLogin, needsLoginUI, loadingUI);
    const scopesOrPrev = ifElse(isMissingScopes, missingScopesUI, loginOrLoad);
    const expiredOrPrev = ifElse(
      isTokenExpiredState,
      tokenExpiredUI,
      scopesOrPrev,
    );
    const refreshOrPrev = ifElse(isRefreshing, refreshingUI, expiredOrPrev);
    const fullUI = ifElse(isReadyState, readyUI, refreshOrPrev);

    return {
      auth: computed(() => auth ?? null),
      authInfo,
      isReady,
      currentEmail,
      currentState,
      pickerUI,
      statusUI,
      fullUI,
      [UI]: fullUI,
    };
  },
);

export default AirtableAuthManager;
