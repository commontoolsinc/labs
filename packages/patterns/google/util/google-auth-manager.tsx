/// <cts-enable />
/**
 * Google Auth Manager - Unified auth management utility
 *
 * This utility encapsulates all Google Auth best practices:
 * - Uses wish() with framework's built-in picker for multi-account selection
 * - Detects missing scopes and navigates to auth charm
 * - Detects expired tokens and provides recovery UI
 * - Pre-composed UI components for consistent UX
 *
 * Usage:
 * ```typescript
 * const { auth, fullUI, isReady, protectedContent } = createGoogleAuth({
 *   requiredScopes: ["gmail", "drive"],
 * });
 *
 * // Guard API calls with isReady
 * const doSomething = handler(() => {
 *   if (!isReady.get()) return;
 *   // Use auth.get().token for API calls
 * });
 *
 * // In UI: {fullUI} handles all auth states
 * // Use protectedContent() to show action buttons only when authenticated
 * return { [UI]: <div>
 *   {fullUI}
 *   {protectedContent(<button onClick={doSomething}>Do Something</button>)}
 * </div> };
 * ```
 *
 * IMPORTANT: Token refresh is currently broken in the framework!
 * This utility detects expired tokens but relies on manual re-authentication.
 *
 * IMPORTANT: Accessing authInfo properties in computed()
 *
 * The `authInfo` return value is an OpaqueRef. If you need to derive
 * values from its properties, use derive() not computed():
 *
 * ```typescript
 * // WRONG - will fail with "opaque value" error:
 * const x = computed(() => authInfo.hasRequiredScopes ? "Yes" : "No");
 *
 * // CORRECT:
 * const x = derive(authInfo, (info) => info.hasRequiredScopes ? "Yes" : "No");
 *
 * // For arrays, use Array.from() to break proxy chain:
 * derive(authInfo, (info) => Array.from(info.missingScopes).map(...));
 * ```
 *
 * For simple checks, use the pre-unwrapped helpers instead:
 * - isReady - boolean for `state === "ready"`
 * - currentEmail - string of signed-in email
 * - currentState - current AuthState value
 */

import {
  computed,
  derive,
  handler,
  ifElse,
  navigateTo,
  UI,
  wish,
  Writable,
} from "commontools";

// Import GoogleAuth pattern for creating new auth charms
// Note: Path is relative from util/ directory (go up to jkomoros/, then find google-auth.tsx)
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
  | "selecting" // Multiple matches, showing picker (wishResult has [UI])
  | "not-found" // No matching auth favorited
  | "needs-login" // Auth charm found but user not signed in
  | "missing-scopes" // Authenticated but missing required scopes
  | "token-expired" // Token has expired (expiresAt < now)
  | "ready"; // All good - auth is usable

/**
 * Token expiry warning level
 */
export type TokenExpiryWarning = "ok" | "warning" | "expired";

/**
 * Complete auth info bundle.
 * Uses single computed for all derived state to prevent reactive thrashing.
 */
export interface AuthInfo {
  state: AuthState;
  auth: Auth | null;
  /** The writable auth cell for token refresh - use this, not auth data */
  authCell: Writable<Auth> | null;
  email: string;
  hasRequiredScopes: boolean;
  grantedScopes: string[];
  missingScopes: ScopeKey[];
  tokenExpiresAt: number | null;
  isTokenExpired: boolean;
  // Token expiry display fields
  tokenTimeRemaining: number | null;
  tokenExpiryWarning: TokenExpiryWarning;
  tokenExpiryDisplay: string;
  // Status display
  statusDotColor: string;
  statusText: string;
  // For navigation/actions
  charm: GoogleAuthCharm | null;
  // UI components from wished charm (to avoid accessing wishResult in fullUI)
  userChip: unknown;
  charmUI: unknown;
}

/** Account type for multi-account support */
export type AccountType = "default" | "personal" | "work";

/** Options for createGoogleAuth */
export interface CreateGoogleAuthOptions {
  /** Required scopes by friendly name (e.g., ["gmail", "drive"]) */
  requiredScopes?: ScopeKey[];
  /**
   * Account type preference for wish tag.
   * Can be a static string or a reactive Writable for dynamic account switching.
   */
  accountType?: AccountType | Writable<AccountType>;
}

/**
 * Return type for createGoogleAuth - explicitly typed to avoid TS inference issues
 * with internal Cell types (CELL_BRAND, CELL_INNER_TYPE) that cannot be named in exports.
 *
 * Note: Most fields use 'any' to avoid exposing internal cell wrapper types.
 * Consumers should use the specific property types documented in JSDoc comments.
 */
export interface GoogleAuthResult {
  /** Core auth cell - WRITABLE for token refresh. Type: Writable<Auth> | null */
  auth: any;
  /** Single computed with all state - use authInfo.state for state checks */
  authInfo: any;
  /** Boolean for state === "ready" */
  isReady: any;
  /** String of signed-in email */
  currentEmail: any;
  /** Current AuthState value */
  currentState: any;
  /** Handler to create a new Google Auth charm */
  createAuth: any;
  /** Handler to navigate to existing auth charm */
  goToAuth: any;
  /** Picker UI when multiple auth matches */
  pickerUI: any;
  /** Minimal status indicator */
  statusUI: any;
  /** Full state-aware management UI */
  fullUI: any;
  /** Protected content wrapper - use ifElse(isReady, children, null) if serialization issues */
  protectedContent: (children: JSX.Element) => any;
  /** Raw wish result for advanced use cases */
  wishResult: any;
}

/** Type for the Google Auth charm returned by wish */
export interface GoogleAuthCharm {
  auth: Writable<Auth>;
  scopes?: string[];
  selectedScopes?: Record<ScopeKey, boolean>;
  /** Compact user display with avatar, name, and email */
  userChip?: unknown;
  refreshToken?: {
    send: (
      event: Record<string, never>,
      onCommit?: (tx: unknown) => void,
    ) => void;
  };
}

// Status colors
const STATUS_COLORS = {
  loading: "var(--ct-color-yellow-500, #eab308)",
  selecting: "var(--ct-color-blue-500, #3b82f6)",
  "not-found": "var(--ct-color-red-500, #ef4444)",
  "needs-login": "var(--ct-color-red-500, #ef4444)",
  "missing-scopes": "var(--ct-color-orange-500, #f97316)",
  "token-expired": "var(--ct-color-red-500, #ef4444)",
  ready: "var(--ct-color-green-500, #22c55e)",
} as const;

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

// =============================================================================
// MODULE-SCOPE HANDLERS
// Handlers MUST be at module scope to work in JSX. Handlers defined inside
// functions fail with "X is not a function" errors at runtime.
// =============================================================================

/**
 * Handler to create new Google Auth charm with pre-selected scopes.
 */
const createAuthHandler = handler<unknown, { scopes: ScopeKey[] }>(
  (_event, { scopes }) => {
    const selectedScopes: Record<ScopeKey, boolean> = {
      gmail: false,
      gmailSend: false,
      gmailModify: false,
      calendar: false,
      calendarWrite: false,
      drive: false,
      docs: false,
      contacts: false,
    };

    for (const scope of scopes) {
      if (scope in selectedScopes) {
        selectedScopes[scope] = true;
      }
    }

    const authCharm = GoogleAuth({
      selectedScopes,
      auth: {
        token: "",
        tokenType: "",
        scope: [],
        expiresIn: 0,
        expiresAt: 0,
        refreshToken: "",
        user: { email: "", name: "", picture: "" },
      },
    });

    return navigateTo(authCharm);
  },
);

/**
 * Handler to navigate to existing auth charm.
 */
const goToAuthHandler = handler<
  unknown,
  { charm: Writable<GoogleAuthCharm | null> }
>(
  (_event, { charm }) => {
    const c = charm.get();
    if (c) return navigateTo(c);
  },
);

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

// =============================================================================
// MAIN UTILITY FUNCTION
// =============================================================================

/**
 * Google Auth management utility.
 *
 * Encapsulates all auth discovery, validation, and UI in one place.
 *
 * CRITICAL IMPLEMENTATION NOTES:
 * 1. wish() is called at pattern body level, NOT inside derive()
 * 2. Property access (wishResult?.result?.auth) NOT derive() for auth cell
 *    - derive() creates read-only projection, breaks token refresh
 * 3. Single computed() for all derived state to prevent thrashing
 * 4. Token refresh is currently broken - we detect but don't auto-refresh
 */
export function createGoogleAuth(
  options: CreateGoogleAuthOptions = {},
): GoogleAuthResult {
  const requiredScopes = options.requiredScopes || [];
  const accountType = options.accountType || "default";

  // Compute the wish tag
  // IMPORTANT: wish() requires a string value, NOT a Cell. Passing a Cell
  // causes wish() to never resolve, leaving the pattern stuck in "loading" state.
  // For static accountType (the common case), compute the string directly.
  // TODO(@jkomoros): For reactive account switching (Writable<AccountType>), we need a different
  // approach since wish() doesn't support Cell query values.
  const tag = accountType === "personal"
    ? "#googleAuthPersonal"
    : accountType === "work"
    ? "#googleAuthWork"
    : "#googleAuth";

  // CRITICAL: wish() at pattern body level, NOT inside derive
  const wishResult = wish<GoogleAuthCharm>({ query: tag });

  // Convert required scope keys to URLs for comparison
  // Note: This is for potential future use in scope URL matching
  const _requiredScopeUrls = requiredScopes
    .map((key) => SCOPE_MAP[key])
    .filter(Boolean);

  // Use derive() instead of computed() - derive() properly unwraps OpaqueRef
  // Inside derive callback, we can do normal JS operations (truthiness, comparisons)
  // Note: We derive from wishResult, and access auth via wr.result?.auth
  // Type annotation needed because derive() infers UIRenderable without it
  const authInfo = derive(wishResult, (wr: any): AuthInfo => {
    // Inside derive(), wr is unwrapped - can do normal JS operations
    const authCell = wr?.result?.auth;
    const authData = authCell?.get?.() ?? null;

    // Determine state from wish result
    let state: AuthState = "loading";

    // Detect picker mode: when wish() finds multiple matches, it returns a picker UI
    // (ct-card with ct-picker) instead of cellLinkUI (which has $cell prop).
    // This check MUST come before wr.result check, because wish() sets result
    // even when multiple matches exist (to the first candidate).
    const hasPickerUI = (wr as any)?.[UI] && !(wr as any)?.[UI]?.props?.$cell;

    if (!wr) {
      state = "loading";
    } else if (wr.error) {
      // Wish returned error - no matches found
      state = "not-found";
    } else if (hasPickerUI) {
      // Multiple matches - show picker for user to choose
      state = "selecting";
    } else if (wr.result) {
      // Single match - evaluate auth state
      const email = authData?.user?.email;
      if (email && email !== "") {
        state = "ready"; // Will be refined below
      } else {
        state = "needs-login";
      }
    }

    // Check granted scopes
    const grantedScopes: string[] = authData?.scope ?? [];
    const missingScopes = requiredScopes.filter((key) => {
      const scopeUrl = SCOPE_MAP[key];
      return scopeUrl && !grantedScopes.includes(scopeUrl);
    });
    const hasRequiredScopes = missingScopes.length === 0;

    // Refine state based on scopes
    if (state === "ready" && !hasRequiredScopes) {
      state = "missing-scopes";
    }

    // Check token expiry
    const tokenExpiresAt = authData?.expiresAt || null;
    const now = Date.now();
    const tokenTimeRemaining = tokenExpiresAt ? tokenExpiresAt - now : null;
    const isTokenExpired = tokenTimeRemaining !== null &&
      tokenTimeRemaining < 0;

    // Calculate token expiry warning level
    const tokenExpiryWarning: TokenExpiryWarning = tokenTimeRemaining === null
      ? "ok"
      : tokenTimeRemaining < 0
      ? "expired"
      : tokenTimeRemaining < TOKEN_WARNING_THRESHOLD_MS
      ? "warning"
      : "ok";

    // Format time remaining for display
    const tokenExpiryDisplay = formatTimeRemaining(tokenTimeRemaining);

    // Refine state based on token expiry
    if (state === "ready" && isTokenExpired) {
      state = "token-expired";
    }

    // Generate status display
    const email = authData?.user?.email ?? "";
    const statusDotColor = STATUS_COLORS[state];
    let statusText = STATUS_MESSAGES[state];

    if (state === "ready") {
      statusText = `Signed in as ${email}`;
    } else if (state === "missing-scopes") {
      const missingNames = missingScopes.map((k) => SCOPE_DESCRIPTIONS[k]).join(
        ", ",
      );
      statusText = `Missing: ${missingNames}`;
    }

    return {
      state,
      auth: authData,
      authCell: authCell, // Writable cell for token refresh
      email,
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
      charm: (wr?.result ?? null) as GoogleAuthCharm | null,
      // Include UI components from wished charm so fullUI doesn't need to access wishResult directly
      userChip: wr?.result?.userChip ?? null,
      charmUI: (wr?.result as any)?.[UI] ?? null,
    };
  });

  // ==========================================================================
  // PRE-BOUND HANDLERS
  // Handlers are defined at module scope. Here we bind them with the required
  // state so they can be used in JSX. These bound handlers work in direct JSX
  // but NOT inside derive() callbacks.
  // ==========================================================================

  // Pre-create charm cell for goToAuth binding
  const charmCell = derive(authInfo, (info) => info.charm);

  // Bind handlers with their required state
  const boundCreateAuth = createAuthHandler({ scopes: requiredScopes });
  const boundGoToAuth = goToAuthHandler({ charm: charmCell });

  // ==========================================================================
  // UI COMPONENTS
  // ==========================================================================

  // Minimal status indicator (avatar + dot + text + token expiry)
  const statusUI = derive(authInfo, (info) => {
    // Determine background color based on state and token warning
    const bgColor = info.state !== "ready"
      ? "#fef3c7"
      : info.tokenExpiryWarning === "warning"
      ? "#fef3c7"
      : "#d1fae5";

    const avatarUrl = info.auth?.user?.picture;

    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          borderRadius: "6px",
          backgroundColor: bgColor,
          fontSize: "14px",
        }}
      >
        {/* Avatar when ready and available */}
        {info.state === "ready" && avatarUrl && (
          <img
            src={avatarUrl}
            alt=""
            style={{
              width: "20px",
              height: "20px",
              borderRadius: "50%",
            }}
          />
        )}
        {/* Status dot when no avatar or not ready */}
        {(!avatarUrl || info.state !== "ready") && (
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              backgroundColor: info.statusDotColor,
            }}
          />
        )}
        <span>{info.statusText}</span>
        {/* Show token expiry countdown when ready and has expiry time */}
        {info.state === "ready" && info.tokenExpiryDisplay && (
          <span
            style={{
              marginLeft: "4px",
              fontSize: "12px",
              color: info.tokenExpiryWarning === "warning" ? "#b45309" : "#666",
              fontWeight: info.tokenExpiryWarning === "warning"
                ? "500"
                : "normal",
            }}
          >
            • {info.tokenExpiryDisplay}
          </span>
        )}
      </div>
    );
  });

  // Picker UI - renders wishResult[UI] when multiple matches
  const pickerUI = derive(wishResult as any, (wr: any) => {
    if (!wr) return null;
    if (wr[UI]) return wr[UI];
    return null;
  });

  // Helper to format scope list for display
  const formatScopesList = (scopes: ScopeKey[]) =>
    scopes.map((k) => SCOPE_DESCRIPTIONS[k]).join(", ");

  // ==========================================================================
  // UI PIECES (with handlers)
  // These use pre-bound handlers and are defined OUTSIDE derive() callbacks.
  // Handlers don't work inside derive() - they fail with "X is not a function".
  // ==========================================================================

  // Scope list for display (static content, safe in derive)
  const scopeListItems = requiredScopes.map((scope, i) => (
    <li key={i} style={{ marginBottom: "4px" }}>
      {SCOPE_DESCRIPTIONS[scope]}
    </li>
  ));

  // "Connect" button - uses pre-bound handler, defined outside derive
  const connectButton = (
    <button
      type="button"
      onClick={boundCreateAuth}
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
  );

  // "Add new account" button (outline style)
  const addAccountButton = (
    <button
      type="button"
      onClick={boundCreateAuth}
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
  );

  // "Manage this account" button
  const manageAccountButton = (
    <button
      type="button"
      onClick={boundGoToAuth}
      style={{
        padding: "6px 12px",
        backgroundColor: "transparent",
        color: "#4b5563",
        border: "1px solid #d1d5db",
        borderRadius: "4px",
        cursor: "pointer",
        fontSize: "13px",
      }}
    >
      Manage this account
    </button>
  );

  // "Use different account" button
  const useDifferentAccountButton = (
    <button
      type="button"
      onClick={boundCreateAuth}
      style={{
        padding: "6px 12px",
        backgroundColor: "transparent",
        color: "#3b82f6",
        border: "1px solid #3b82f6",
        borderRadius: "4px",
        cursor: "pointer",
        fontSize: "13px",
      }}
    >
      + Use different account
    </button>
  );

  // "Switch" button for ready state
  const switchButton = (
    <button
      type="button"
      onClick={boundGoToAuth}
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
  );

  // "+ Add" button for ready state
  const addButton = (
    <button
      type="button"
      onClick={boundCreateAuth}
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
  );

  // Action buttons row for error states
  const actionButtonsRow = (
    <div
      style={{
        padding: "12px 16px",
        backgroundColor: "#f9fafb",
        display: "flex",
        gap: "12px",
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: "13px", color: "#6b7280" }}>Or:</span>
      {manageAccountButton}
      {useDifferentAccountButton}
    </div>
  );

  // ==========================================================================
  // FULL UI (using ifElse for state-based rendering)
  // The buttons with handlers are defined above, outside any derive context.
  // ==========================================================================

  // State checks for conditional rendering
  const isLoadingOrNotFound = derive(
    authInfo,
    (info) => info.state === "loading" || info.state === "not-found",
  );
  const isSelecting = derive(authInfo, (info) => info.state === "selecting");
  const needsAction = derive(
    authInfo,
    (info) =>
      info.state === "needs-login" || info.state === "missing-scopes" ||
      info.state === "token-expired",
  );
  const isAuthReady = derive(authInfo, (info) => info.state === "ready");

  // Loading/Not-found UI
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
      </p>
      {requiredScopes.length > 0 && (
        <ul
          style={{
            margin: "0 0 16px 0",
            paddingLeft: "20px",
            fontSize: "13px",
            color: "#6b7280",
          }}
        >
          {scopeListItems}
        </ul>
      )}
      {connectButton}
    </div>
  );

  // Selecting UI (multiple matches)
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
      {requiredScopes.length > 0 && (
        <p style={{ margin: "0 0 12px 0", fontSize: "13px", color: "#4b5563" }}>
          This feature needs access to: {formatScopesList(requiredScopes)}
        </p>
      )}
      {pickerUI}
      {addAccountButton}
    </div>
  );

  // Needs-action UI (needs-login, missing-scopes, token-expired)
  // This one needs dynamic content from authInfo, so we use derive for the content
  // but the buttons are still the pre-bound ones from above
  const needsActionUI = derive(authInfo, (info) => {
    if (
      info.state !== "needs-login" && info.state !== "missing-scopes" &&
      info.state !== "token-expired"
    ) {
      return null;
    }

    // Build missing scopes message
    const missingScopesMessage = info.state === "missing-scopes"
      ? (
        <div>
          <p
            style={{ margin: "0 0 8px 0", fontSize: "13px", color: "#4b5563" }}
          >
            Connected as{" "}
            <strong>{info.email}</strong>, but this feature needs additional
            permissions:
          </p>
          <ul style={{ margin: "0", paddingLeft: "20px", fontSize: "13px" }}>
            {Array.from(info.missingScopes).map((scope, i) => (
              <li key={i} style={{ color: "#c2410c", marginBottom: "2px" }}>
                {SCOPE_DESCRIPTIONS[scope as ScopeKey]}
              </li>
            ))}
          </ul>
        </div>
      )
      : null;

    const stateConfig = {
      "needs-login": {
        title: "Sign In Required",
        message: (
          <span>Please sign in with your Google account to continue.</span>
        ),
        bgColor: "#fee2e2",
        borderColor: "#ef4444",
        titleColor: "#dc2626",
      },
      "missing-scopes": {
        title: "Additional Permissions Needed",
        message: missingScopesMessage,
        bgColor: "#ffedd5",
        borderColor: "#f97316",
        titleColor: "#c2410c",
      },
      "token-expired": {
        title: "Session Expired",
        message: (
          <span>
            Your Google session has expired. Please sign in again to continue.
          </span>
        ),
        bgColor: "#fee2e2",
        borderColor: "#ef4444",
        titleColor: "#dc2626",
      },
    };

    const config = stateConfig[
      info.state as "needs-login" | "missing-scopes" | "token-expired"
    ];

    return (
      <div
        style={{
          borderRadius: "8px",
          border: `1px solid ${config.borderColor}`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            backgroundColor: config.bgColor,
            borderBottom: `1px solid ${config.borderColor}`,
          }}
        >
          <h4
            style={{
              margin: "0 0 4px 0",
              color: config.titleColor,
              fontSize: "14px",
            }}
          >
            {config.title}
          </h4>
          <div style={{ margin: "0", fontSize: "13px", color: "#4b5563" }}>
            {config.message || ""}
          </div>
        </div>
        <div style={{ backgroundColor: "white" }}>
          {info.charmUI as any}
        </div>
        {actionButtonsRow}
      </div>
    );
  });

  // Ready state UI
  // Uses derive for dynamic content but buttons are pre-bound
  const readyUI = derive(authInfo, (info) => {
    if (info.state !== "ready") return null;

    return (
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "12px 16px",
            backgroundColor: "#d1fae5",
            borderRadius: info.tokenExpiryWarning === "warning"
              ? "8px 8px 0 0"
              : "8px",
            border: "1px solid #10b981",
            borderBottom: info.tokenExpiryWarning === "warning"
              ? "none"
              : "1px solid #10b981",
          }}
        >
          {info.userChip as any}
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: "12px",
            }}
          >
            {info.tokenExpiryDisplay && (
              <span style={{ fontSize: "12px", color: "#059669" }}>
                {info.tokenExpiryDisplay}
              </span>
            )}
            {switchButton}
            {addButton}
          </div>
        </div>
        {info.tokenExpiryWarning === "warning" && (
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
            ⚠️ Token expires soon. You may need to re-authenticate shortly.
          </div>
        )}
      </div>
    );
  });

  // Compose fullUI using ifElse chains
  const fullUI = ifElse(
    isLoadingOrNotFound,
    loadingUI,
    ifElse(
      isSelecting,
      selectingUI,
      ifElse(
        needsAction,
        needsActionUI,
        ifElse(isAuthReady, readyUI, null),
      ),
    ),
  );

  // ==========================================================================
  // RETURN
  // ==========================================================================

  // Helper getters - pre-unwrapped for convenience (avoids OpaqueRef footgun)
  const isReady = derive(authInfo, (info) => info.state === "ready");
  const currentEmail = derive(authInfo, (info) => info.email);
  const currentState = derive(authInfo, (info) => info.state);

  // Extract the writable auth cell directly from wishResult (not through derive)
  // IMPORTANT: Using computed() preserves the original cell reference for token refresh writes
  // derive() would create a read-only projection, breaking auth.update() calls in clients
  const auth = computed(() => (wishResult as any)?.result?.auth ?? null);

  return {
    // Core auth cell - WRITABLE for token refresh
    // Note: This is extracted from authInfo.authCell which preserves the original cell reference
    auth,

    // Single computed with all state - use authInfo.state for state checks
    authInfo,

    // Helper getters (pre-unwrapped to avoid OpaqueRef issues)
    isReady,
    currentEmail,
    currentState,

    // Actions (pre-bound handlers)
    createAuth: boundCreateAuth,
    goToAuth: boundGoToAuth,

    // UI Components
    pickerUI,
    statusUI,
    fullUI,

    // Protected content wrapper - renders children only when auth is ready
    // Usage: {protectedContent(<button>Action</button>)}
    //
    // ⚠️ WARNING: This helper function does NOT survive serialization through the
    // action system. If you get "TypeError: protectedContent is not a function",
    // use ifElse(isReady, children, null) directly instead.
    // See: community-docs/superstitions/2025-11-29-cells-must-be-json-serializable.md
    protectedContent: (children: JSX.Element) =>
      ifElse(isReady, children, null),

    // Raw wish result for advanced use cases
    wishResult,
  };
}
