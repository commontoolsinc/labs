/// <cts-enable />
/**
 * Factory for creating OAuth auth manager patterns.
 *
 * Each auth manager is ~95% identical across providers. This factory
 * extracts the shared logic (wish setup, state machine, refresh handling,
 * UI components) and parameterizes it via an AuthManagerDescriptor.
 *
 * Usage:
 * ```typescript
 * import { createAuthManager } from "../../auth/create-auth-manager.tsx";
 * import MyAuth from "../my-auth.tsx";
 *
 * export default createAuthManager(myDescriptor, MyAuth);
 * ```
 */
import {
  action,
  computed,
  Default,
  handler,
  ifElse,
  lift,
  navigateTo,
  pattern,
  UI,
  wish,
  Writable,
} from "commonfabric";
import type { NodeFactory, Opaque } from "commonfabric";

import type { AuthInfo, AuthState, TokenExpiryWarning } from "./auth-types.ts";
import type { AuthManagerDescriptor } from "./auth-manager-descriptor.ts";
import { STATUS_COLORS, STATUS_MESSAGES } from "./auth-manager-descriptor.ts";
import { formatTimeRemaining } from "./auth-ui-helpers.tsx";
import {
  startReactiveClock,
  TOKEN_EXPIRY_THRESHOLD_MS,
} from "./auth-reactive.ts";

// Re-export for consumers
export type { AuthInfo, AuthState, TokenExpiryWarning };

// =============================================================================
// SHARED TYPES
// =============================================================================

export interface AuthManagerInput {
  requiredScopes?: Default<string[], []>;
  accountType?: Default<string, "default">;
  debugMode?: Default<boolean, false>;
}

export interface AuthManagerOutput {
  // deno-lint-ignore no-explicit-any
  auth: any | null;
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

// deno-lint-ignore no-explicit-any
interface AuthPiece {
  // deno-lint-ignore no-explicit-any
  auth?: any;
  scopes?: string[];
  selectedScopes?: Record<string, boolean>;
  userChip?: unknown;
  refreshToken?: unknown;
}

interface DerivedAuthState {
  // deno-lint-ignore no-explicit-any
  auth: any | null;
  authInfo: AuthInfo;
  currentEmail: string;
  currentState: AuthState;
  hasRequiredScopes: boolean;
  isNeedsLogin: boolean;
  isReady: boolean;
  isReadyState: boolean;
  isTokenExpired: boolean;
  isTokenExpiredState: boolean;
  missingScopes: string[];
  missingScopesList: string;
  piece: AuthPiece | null;
  refreshStream: unknown;
  scopesList: string;
  showAvatar: boolean;
  avatarUrl: string;
  showExpiryInStatus: boolean;
  statusBgColor: string;
  statusDotColor: string;
  statusText: string;
  tokenExpiresAt: number | null;
  tokenExpiryDisplay: string;
  tokenExpiryWarning: TokenExpiryWarning;
  tokenTimeRemaining: number | null;
  expiryHintColor: string;
  expiryHintWeight: string;
  userChip: unknown;
}

// =============================================================================
// MODULE-SCOPE HANDLER (shared across all auth manager instances)
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

  // Note: in theory the Writable could be invalid if the pattern were
  // hot-reloaded, but CTS pattern lifecycle matches page lifecycle so
  // there is no practical risk of accessing a stale Writable here.
  setTimeout(() => {
    if (refreshing.get()) {
      refreshing.set(false);
      refreshFailed.set(true);
    }
  }, REFRESH_FAILURE_TIMEOUT_MS);
});

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create an auth manager pattern for the given provider.
 *
 * @param descriptor - Provider-specific configuration
 * @param AuthPattern - The provider's auth pattern function (for creating new instances)
 */
export function createAuthManager<T, R>(
  descriptor: AuthManagerDescriptor,
  AuthPattern: NodeFactory<T, R>,
) {
  function debugLog(enabled: boolean, ...args: unknown[]) {
    if (enabled) console.log(`[${descriptor.displayName}Auth]`, ...args);
  }

  const deriveAuthState = lift<{
    piece?: AuthPiece | null;
    requiredScopes?: string[];
    now: number;
    debugMode?: boolean;
  }, DerivedAuthState>(({
    piece,
    requiredScopes,
    now,
    debugMode,
  }) => {
    const auth = piece?.auth ?? null;
    const currentEmail = auth?.user?.email ?? "";
    const requestedScopes = Array.isArray(requiredScopes) ? requiredScopes : [];
    const grantedScopes = Array.isArray(auth?.scope) ? auth.scope : [];
    const hasToken = !!auth?.[descriptor.tokenField];
    const hasEmail = currentEmail !== "";
    const tokenExpiresAt = typeof auth?.expiresAt === "number"
      ? auth.expiresAt
      : null;
    const tokenTimeRemaining = tokenExpiresAt === null
      ? null
      : tokenExpiresAt - now;

    let tokenExpiryWarning: TokenExpiryWarning = "ok";
    if (tokenTimeRemaining !== null) {
      if (tokenTimeRemaining < 0) {
        tokenExpiryWarning = "expired";
      } else if (tokenTimeRemaining < TOKEN_EXPIRY_THRESHOLD_MS) {
        tokenExpiryWarning = "warning";
      }
    }

    const missingScopes = requestedScopes.filter((key) =>
      !grantedScopes.includes(descriptor.scopes[key]?.scopeString ?? key)
    );
    const hasRequiredScopes = missingScopes.length === 0;
    const isTokenExpired = tokenExpiresAt !== null && tokenExpiresAt < now;

    let currentState: AuthState;
    if (!auth) {
      currentState = "loading";
    } else if (!hasToken || !hasEmail) {
      currentState = "needs-login";
    } else if (!hasRequiredScopes) {
      currentState = "missing-scopes";
    } else if (isTokenExpired) {
      currentState = "token-expired";
    } else {
      currentState = "ready";
    }

    const isReady = hasToken && hasEmail && !isTokenExpired &&
      hasRequiredScopes;
    const tokenExpiryDisplay = formatTimeRemaining(tokenTimeRemaining);
    const statusDotColor = STATUS_COLORS[currentState] ?? STATUS_COLORS.loading;

    let statusText = STATUS_MESSAGES[currentState];
    if (currentState === "ready") {
      statusText = `Signed in as ${currentEmail}`;
    } else if (currentState === "missing-scopes") {
      const names = missingScopes
        .map((key) => descriptor.scopes[key]?.description ?? key)
        .join(", ");
      statusText = `Missing: ${names}`;
    } else if (currentState === "needs-login") {
      statusText = `Please sign in to your ${descriptor.displayName}`;
    }

    const scopesList = requestedScopes
      .map((key) => descriptor.scopes[key]?.description ?? key)
      .join(", ");
    const missingScopesList = missingScopes
      .map((key) => descriptor.scopes[key]?.description ?? key)
      .join(", ");
    const showAvatar = descriptor.hasAvatarSupport &&
      currentState === "ready" &&
      !!auth?.user?.picture;
    const avatarUrl = (auth?.user?.picture ?? "") as string;
    const showExpiryInStatus = currentState === "ready" &&
      tokenExpiryDisplay !== "";
    const expiryHintColor = tokenExpiryWarning === "warning"
      ? "#b45309"
      : "#666";
    const expiryHintWeight = tokenExpiryWarning === "warning"
      ? "500"
      : "normal";
    const statusBgColor = currentState !== "ready" ||
        tokenExpiryWarning === "warning"
      ? "#fef3c7"
      : "#d1fae5";
    const isNeedsLogin = currentState === "needs-login";
    const isTokenExpiredState = currentState === "token-expired";
    const isReadyState = currentState === "ready";

    debugLog(debugMode === true, "state:", currentState);
    debugLog(debugMode === true, "isReady:", isReady);
    debugLog(debugMode === true, "missingScopes:", missingScopes);
    debugLog(debugMode === true, "isTokenExpired:", isTokenExpired);

    return {
      auth,
      authInfo: {
        state: currentState,
        auth,
        authCell: auth,
        email: currentEmail,
        hasRequiredScopes,
        grantedScopes,
        missingScopes,
        tokenExpiresAt,
        isTokenExpired,
        tokenTimeRemaining,
        tokenExpiryWarning,
        tokenExpiryDisplay,
        statusDotColor,
        statusText,
        piece: piece ?? null,
        userChip: piece?.userChip ?? null,
      },
      currentEmail,
      currentState,
      hasRequiredScopes,
      isNeedsLogin,
      isReady,
      isReadyState,
      isTokenExpired,
      isTokenExpiredState,
      missingScopes,
      missingScopesList,
      piece: piece ?? null,
      refreshStream: piece?.refreshToken ?? null,
      scopesList,
      showAvatar,
      avatarUrl,
      showExpiryInStatus,
      statusBgColor,
      statusDotColor,
      statusText,
      tokenExpiresAt,
      tokenExpiryDisplay,
      tokenExpiryWarning,
      tokenTimeRemaining,
      expiryHintColor,
      expiryHintWeight,
      userChip: piece?.userChip ?? null,
    };
  });

  return pattern<AuthManagerInput, AuthManagerOutput>(
    ({ requiredScopes, accountType, debugMode }) => {
      // ======================================================================
      // WISH SETUP
      // ======================================================================
      const wishTag = computed(() => {
        const type = accountType;
        if (descriptor.variantWishTags && type !== "default") {
          return descriptor.variantWishTags[type as string] ??
            descriptor.wishTag;
        }
        return descriptor.wishTag;
      });

      const wishResult = wish<AuthPiece>({
        query: wishTag,
        scope: [".", "~"],
      });

      const now = Writable.of(Date.now());
      startReactiveClock(now);

      // Normalize the wish-provided UI into a local render-node contract so
      // consumers see a stable UI field even when the underlying wish result
      // has not materialized content yet.
      const pickerUI = <>{wishResult[UI]}</>;
      const authState = deriveAuthState({
        piece: wishResult.result,
        requiredScopes,
        now,
        debugMode,
      });
      const auth = authState.auth;
      const authInfo = authState.authInfo;
      const currentEmail = authState.currentEmail;
      const currentState = authState.currentState;
      const isReady = authState.isReady;
      const tokenExpiryWarning = authState.tokenExpiryWarning;
      const tokenExpiryDisplay = authState.tokenExpiryDisplay;

      // Refresh state
      const refreshing = Writable.of(false);
      const refreshStream = authState.refreshStream;
      const isRefreshing = computed(() => refreshing.get());
      const refreshFailed = Writable.of(false);
      const refreshStartedAt = Writable.of(0);

      // Reactive watcher: detect when a refresh succeeds
      computed(() => {
        if (!refreshing.get()) return;
        const expiresAt = authState.tokenExpiresAt ?? 0;
        if (expiresAt > now.get()) {
          refreshing.set(false);
          refreshFailed.set(false);
        }
      });

      // ====================================================================
      // ACTIONS
      // ====================================================================
      const createAuth = action(() => {
        const selected: Record<string, boolean> = {};
        for (const key of Object.keys(descriptor.scopes)) {
          selected[key] = false;
        }
        for (const scope of requiredScopes as string[]) {
          if (scope in selected) selected[scope] = true;
        }

        // Build empty auth with correct token field
        const emptyAuth: Record<string, unknown> = {
          tokenType: "",
          scope: [],
          expiresIn: 0,
          expiresAt: 0,
          refreshToken: "",
          user: { email: "", name: "", picture: "" },
        };
        emptyAuth[descriptor.tokenField] = "";

        return navigateTo(
          AuthPattern({
            selectedScopes: selected,
            auth: emptyAuth,
          } as Opaque<T>),
        );
      });

      const reauthenticate = action(() => navigateTo(wishResult.result));

      // ====================================================================
      // UI COMPONENTS
      // ====================================================================
      // Status UI
      const statusUI = (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 12px",
            borderRadius: "6px",
            backgroundColor: authState.statusBgColor,
            fontSize: "14px",
          }}
        >
          {ifElse(
            authState.showAvatar,
            <img
              src={authState.avatarUrl}
              alt=""
              style={{ width: "20px", height: "20px", borderRadius: "50%" }}
            />,
            <span
              style={{
                width: "10px",
                height: "10px",
                borderRadius: "50%",
                backgroundColor: ifElse(
                  computed(() => currentState === "ready"),
                  descriptor.brandColor,
                  authState.statusDotColor,
                ),
              }}
            />,
          )}
          <span>{authState.statusText}</span>
          {ifElse(
            authState.showExpiryInStatus,
            <span
              style={{
                marginLeft: "4px",
                fontSize: "12px",
                color: authState.expiryHintColor,
                fontWeight: authState.expiryHintWeight,
              }}
            >
              • {tokenExpiryDisplay}
            </span>,
            null,
          )}
        </div>
      );

      // State boolean computeds for fullUI
      const isMissingScopes = computed(() => currentState === "missing-scopes");

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
        color: descriptor.brandColor,
        border: `1px solid ${descriptor.brandColor}`,
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
            Connect Your {descriptor.displayName} Account
          </h4>
          <p
            style={{
              margin: "0 0 12px 0",
              fontSize: "14px",
              color: "#4b5563",
            }}
          >
            To use this feature, connect a {descriptor.displayName}{" "}
            account with these permissions: {authState.scopesList}
          </p>
          {pickerUI}
          <button
            type="button"
            onClick={createAuth}
            style={{
              padding: "10px 20px",
              backgroundColor: descriptor.brandColor,
              color: "white",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              fontWeight: "500",
              fontSize: "14px",
            }}
          >
            Connect {descriptor.displayName} Account
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
              style={{
                margin: "0 0 4px 0",
                color: "#dc2626",
                fontSize: "14px",
              }}
            >
              Sign In Required
            </h4>
            <div style={{ margin: "0", fontSize: "13px", color: "#4b5563" }}>
              Please sign in with your {descriptor.displayName}{" "}
              account to continue.
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
              style={{
                margin: "0 0 4px 0",
                color: "#c2410c",
                fontSize: "14px",
              }}
            >
              Additional Permissions Needed
            </h4>
            <div style={{ margin: "0", fontSize: "13px", color: "#4b5563" }}>
              Connected as <strong>{currentEmail}</strong>, but missing:{" "}
              {authState.missingScopesList}
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
              style={{
                margin: "0 0 4px 0",
                color: "#dc2626",
                fontSize: "14px",
              }}
            >
              Session Expired
            </h4>
            <div style={{ margin: "0", fontSize: "13px", color: "#4b5563" }}>
              Your {descriptor.displayName} session has expired.
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
                disabled={refreshing}
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
                refreshFailed,
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
            {authState.userChip as any}
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
          <span style={{ fontSize: "16px" }}>⟳</span>
          Refreshing session...
        </div>
      );

      // Compose fullUI via chained ifElse
      const loginOrLoad = ifElse(
        authState.isNeedsLogin,
        needsLoginUI,
        loadingUI,
      );
      const scopesOrPrev = ifElse(
        isMissingScopes,
        missingScopesUI,
        loginOrLoad,
      );
      const expiredOrPrev = ifElse(
        authState.isTokenExpiredState,
        tokenExpiredUI,
        scopesOrPrev,
      );
      const refreshOrPrev = ifElse(isRefreshing, refreshingUI, expiredOrPrev);
      const fullUI = ifElse(authState.isReadyState, readyUI, refreshOrPrev);

      // ====================================================================
      // RETURN
      // ====================================================================
      return {
        auth,
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
}
