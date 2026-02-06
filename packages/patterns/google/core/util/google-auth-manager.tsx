/// <cts-enable />
/**
 * Google Auth Manager - Unified auth management utility
 *
 * This utility encapsulates all Google Auth best practices:
 * - Uses wish() with framework's built-in picker for multi-account selection
 * - Detects missing scopes and navigates to auth piece
 * - Detects expired tokens and provides recovery UI
 * - Pre-composed UI components for consistent UX
 *
 * Usage:
 * ```typescript
 * const { auth, fullUI, isReady } = createGoogleAuth({
 *   requiredScopes: ["gmail", "drive"],
 * });
 *
 * // Guard API calls with isReady
 * if (!isReady) return;
 * // Use auth.token for API calls
 *
 * // In UI: {fullUI} handles all auth states
 * return { [UI]: <div>{fullUI}</div> };
 * ```
 *
 * IMPORTANT: Token refresh is currently broken in the framework!
 * This utility detects expired tokens but relies on manual re-authentication.
 */

import {
  action,
  computed,
  Default,
  ifElse,
  navigateTo,
  pattern,
  UI,
  wish,
  Writable,
} from "commontools";

// Import GoogleAuth pattern for creating new auth pieces
import GoogleAuth, { type Auth } from "../google-auth.tsx";

// Re-export Auth type for consumers
export type { Auth };

// =============================================================================
// TYPES & CONSTANTS
// =============================================================================

/** Scope mapping for Google APIs - friendly names to URLs */
export const SCOPE_MAP = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  calendarWrite: "https://www.googleapis.com/auth/calendar.events",
  drive: "https://www.googleapis.com/auth/drive",
  docs: "https://www.googleapis.com/auth/documents.readonly",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
} as const;

/** Human-readable scope descriptions */
export const SCOPE_DESCRIPTIONS = {
  gmail: "Gmail (read emails)",
  gmailSend: "Gmail (send emails)",
  gmailModify: "Gmail (add/remove labels)",
  calendar: "Calendar (read events)",
  calendarWrite: "Calendar (create/edit/delete events)",
  drive: "Drive (read/write files & comments)",
  docs: "Docs (read document content)",
  contacts: "Contacts (read contacts)",
} as const;

export type ScopeKey = keyof typeof SCOPE_MAP;

/**
 * Auth state enumeration.
 * Each state maps to specific UI and behavior.
 */
export type AuthState =
  | "loading" // Wish in progress
  | "selecting" // Multiple matches, showing picker
  | "not-found" // No matching auth favorited
  | "needs-login" // Auth piece found but user not signed in
  | "missing-scopes" // Authenticated but missing required scopes
  | "token-expired" // Token has expired
  | "ready"; // All good - auth is usable

/**
 * Token expiry warning level
 */
export type TokenExpiryWarning = "ok" | "warning" | "expired";

/**
 * Complete auth info bundle.
 */
export interface AuthInfo {
  state: AuthState;
  auth: Auth | null;
  /** The writable auth cell for token refresh - internal use */
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
  pieceUI: unknown;
}

/** Account type for multi-account support */
export type AccountType = "default" | "personal" | "work";

/** Input options for GoogleAuthManager pattern */
export interface GoogleAuthManagerInput {
  requiredScopes?: Default<ScopeKey[], []>;
  accountType?: Default<AccountType, "default">;
  debugMode?: Default<boolean, false>;
}

/** Output interface for GoogleAuthManager pattern */
export interface GoogleAuthManagerOutput {
  auth: Auth | null;
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

/** Type for the Google Auth piece returned by wish (internal) */
interface GoogleAuthPiece {
  auth?: Auth;
  scopes?: string[];
  selectedScopes?: Record<ScopeKey, boolean>;
  userChip?: unknown;
}

// Status colors
const STATUS_COLORS: Record<AuthState, string> = {
  loading: "var(--ct-color-yellow-500, #eab308)",
  selecting: "var(--ct-color-blue-500, #3b82f6)",
  "not-found": "var(--ct-color-red-500, #ef4444)",
  "needs-login": "var(--ct-color-red-500, #ef4444)",
  "missing-scopes": "var(--ct-color-orange-500, #f97316)",
  "token-expired": "var(--ct-color-red-500, #ef4444)",
  ready: "var(--ct-color-green-500, #22c55e)",
};

// Status messages
const STATUS_MESSAGES: Record<AuthState, string> = {
  loading: "Loading auth...",
  selecting: "Select an account",
  "not-found": "No Google Auth found - please create one",
  "needs-login": "Please sign in to your Google Auth",
  "missing-scopes": "Additional permissions needed",
  "token-expired": "Session expired - please re-authenticate",
  ready: "Connected",
};

// Token expiry warning threshold (10 minutes)
const TOKEN_WARNING_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Format time remaining in a human-readable way
 */
function formatTimeRemaining(ms: number | null): string {
  if (ms === null) return "";
  if (ms <= 0) return "Expired";

  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMins = minutes % 60;
    return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes} min`;
  }
  return "< 1 min";
}

// Debug logging helper
function debugLog(debug: boolean, ...args: unknown[]) {
  if (debug) console.log("[GoogleAuthManager]", ...args);
}

// =============================================================================
// MAIN PATTERN
// =============================================================================

export const GoogleAuthManager = pattern<
  GoogleAuthManagerInput,
  GoogleAuthManagerOutput
>(
  ({ requiredScopes, accountType, debugMode }) => {
    // ========================================================================
    // WISH SETUP - Writable tag with accountType sync
    // ========================================================================
    const wishTag = Writable.of("#googleAuth");
    // Sync accountType -> wishTag (idempotent side-effect)
    computed(() => {
      const type = accountType;
      const newTag = type === "personal"
        ? "#googleAuthPersonal"
        : type === "work"
        ? "#googleAuthWork"
        : "#googleAuth";
      if (wishTag.get() !== newTag) wishTag.set(newTag);
    });

    const wishResult = wish<GoogleAuthPiece>({
      query: wishTag,
      scope: [".", "~"],
    });

    // ========================================================================
    // REACTIVE AUTH ACCESS - Direct property chain (no .get())
    // ========================================================================
    const auth = wishResult.result.auth;

    // ========================================================================
    // SMALL FOCUSED COMPUTEDS
    // ========================================================================
    const hasAuth = computed(() => !!auth);
    const hasToken = computed(() => !!auth?.token);
    const hasEmail = computed(() => !!auth?.user?.email);

    // Token expiry
    const isTokenExpired = computed(() => {
      const expiresAt = auth?.expiresAt ?? 0;
      return expiresAt > 0 && expiresAt < Date.now();
    });

    const tokenTimeRemaining = computed((): number | null => {
      const expiresAt = auth?.expiresAt ?? 0;
      if (!expiresAt) return null;
      return expiresAt - Date.now();
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
      return (requiredScopes as ScopeKey[]).filter(
        (key) => !granted.includes(SCOPE_MAP[key]),
      );
    });
    const hasRequiredScopes = computed(
      () => (missingScopes as ScopeKey[]).length === 0,
    );

    // Picker UI from wish (null when no picker)
    const pickerUI = computed(() => wishResult[UI] ?? null);

    // State machine
    const currentState = computed((): AuthState => {
      const debug = debugMode as boolean;

      if (wishResult.error) {
        debugLog(debug, "state: not-found (wish error)", wishResult.error);
        return "not-found";
      }

      if (!hasAuth) {
        // If wish provides a picker UI, we're in selecting mode
        if (pickerUI) {
          debugLog(debug, "state: selecting (picker UI shown)");
          return "selecting";
        }
        debugLog(debug, "state: loading (no auth resolved)");
        return "loading";
      }

      if (!hasToken || !hasEmail) {
        debugLog(debug, "state: needs-login");
        return "needs-login";
      }

      if (!hasRequiredScopes) {
        debugLog(debug, "state: missing-scopes");
        return "missing-scopes";
      }

      if (isTokenExpired) {
        debugLog(debug, "state: token-expired");
        return "token-expired";
      }

      debugLog(debug, "state: ready", { email: auth?.user?.email });
      return "ready";
    });

    // Derived values from state
    const isReady = computed(() => currentState === "ready");
    const currentEmail = computed(() => (auth?.user?.email ?? "") as string);

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

    // Assemble authInfo from sub-computeds
    const authInfo = computed((): AuthInfo => ({
      state: currentState as AuthState,
      auth: (auth ?? null) as Auth | null,
      authCell: auth,
      email: (currentEmail ?? "") as string,
      hasRequiredScopes: hasRequiredScopes as boolean,
      grantedScopes: ((auth?.scope ?? []) as string[]).slice(),
      missingScopes: Array.from(missingScopes as ScopeKey[]),
      tokenExpiresAt: (auth?.expiresAt ?? null) as number | null,
      isTokenExpired: isTokenExpired as boolean,
      tokenTimeRemaining: tokenTimeRemaining as number | null,
      tokenExpiryWarning: tokenExpiryWarning as TokenExpiryWarning,
      tokenExpiryDisplay: (tokenExpiryDisplay ?? "") as string,
      statusDotColor: (statusDotColor ?? STATUS_COLORS.loading) as string,
      statusText: (statusText ?? "") as string,
      piece: wishResult.result ?? null,
      userChip: wishResult.result?.userChip ?? null,
      pieceUI: null,
    }));

    // ========================================================================
    // ACTIONS (replaces module-scope handlers)
    // ========================================================================
    const createAuth = action(() => {
      const selected: Record<ScopeKey, boolean> = {
        gmail: false,
        gmailSend: false,
        gmailModify: false,
        calendar: false,
        calendarWrite: false,
        drive: false,
        docs: false,
        contacts: false,
      };
      for (const scope of requiredScopes as ScopeKey[]) {
        if (scope in selected) selected[scope] = true;
      }
      return navigateTo(
        GoogleAuth({
          selectedScopes: selected,
          auth: {
            token: "",
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
    // UI COMPONENTS (no computed() wrappers on JSX)
    // ========================================================================

    // --- Status UI helpers ---
    const statusBgColor = computed(() => {
      if (currentState !== "ready") return "#fef3c7";
      if (tokenExpiryWarning === "warning") return "#fef3c7";
      return "#d1fae5";
    });
    const showAvatar = computed(
      () => currentState === "ready" && !!auth?.user?.picture,
    );
    const avatarUrl = computed(() => (auth?.user?.picture ?? "") as string);
    const showExpiryInStatus = computed(
      () => currentState === "ready" && !!tokenExpiryDisplay,
    );
    const expiryHintColor = computed(
      () => (tokenExpiryWarning === "warning" ? "#b45309" : "#666"),
    );
    const expiryHintWeight = computed(
      () => (tokenExpiryWarning === "warning" ? "500" : "normal"),
    );

    // --- Status UI ---
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
          <img
            src={avatarUrl}
            alt=""
            style={{ width: "20px", height: "20px", borderRadius: "50%" }}
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

    // --- State boolean computeds for fullUI ---
    const isLoading = computed(
      () => currentState === "loading" || currentState === "not-found",
    );
    const isSelecting = computed(() => currentState === "selecting");
    const isNeedsLogin = computed(() => currentState === "needs-login");
    const isMissingScopes = computed(() => currentState === "missing-scopes");
    const isTokenExpiredState = computed(
      () => currentState === "token-expired",
    );
    const isReadyState = computed(() => currentState === "ready");

    // Helper for scope display
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

    // Shared button styles
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
      color: "#3b82f6",
      border: "1px solid #3b82f6",
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

    // --- Loading / Not-found UI ---
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
          Connect Your Google Account
        </h4>
        <p style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#4b5563" }}>
          To use this feature, connect a Google account with these permissions:
          {" "}
          {scopesList}
        </p>
        <button
          type="button"
          onClick={createAuth}
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
          Connect Google Account
        </button>
      </div>
    );

    // --- Selecting UI (multiple matches, picker shown) ---
    const selectingUI = (
      <div
        style={{
          padding: "16px",
          backgroundColor: "#dbeafe",
          borderRadius: "8px",
        }}
      >
        <h4 style={{ margin: "0 0 8px 0", color: "#1e40af" }}>
          Select a Google Account
        </h4>
        {ifElse(
          computed(() => (requiredScopes as ScopeKey[]).length > 0),
          <p
            style={{
              margin: "0 0 12px 0",
              fontSize: "13px",
              color: "#4b5563",
            }}
          >
            This feature needs access to: {scopesList}
          </p>,
          null,
        )}
        {pickerUI}
        <button
          type="button"
          onClick={createAuth}
          style={{
            marginTop: "12px",
            padding: "8px 16px",
            backgroundColor: "transparent",
            color: "#1e40af",
            border: "1px solid #3b82f6",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "13px",
          }}
        >
          + Add new account
        </button>
      </div>
    );

    // --- Needs login UI ---
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
            Please sign in with your Google account to continue.
          </div>
        </div>
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

    // --- Missing scopes UI ---
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

    // --- Token expired UI ---
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
            Your Google session has expired. Please sign in again to continue.
          </div>
        </div>
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

    // --- Ready UI ---
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

    // --- Compose fullUI ---
    const fullUI = (
      <>
        {ifElse(isLoading, loadingUI, null)}
        {ifElse(isSelecting, selectingUI, null)}
        {ifElse(isNeedsLogin, needsLoginUI, null)}
        {ifElse(isMissingScopes, missingScopesUI, null)}
        {ifElse(isTokenExpiredState, tokenExpiredUI, null)}
        {ifElse(isReadyState, readyUI, null)}
      </>
    );

    // ========================================================================
    // RETURN
    // ========================================================================
    return {
      auth: computed(() => (auth ?? null) as Auth | null),
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

// Export as default for ct check
export default GoogleAuthManager;

// Backward-compatible export for existing code that uses createGoogleAuth()
export const createGoogleAuth = GoogleAuthManager;
