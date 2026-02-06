/// <cts-enable />
/**
 * Google Auth Manager - Manages Google OAuth authentication
 *
 * Features:
 * - Account type switching (Any/Personal/Work)
 * - Required scope verification
 * - Token expiry detection
 * - State-based UI with appropriate actions
 */
import {
  action,
  computed,
  Default,
  ifElse,
  navigateTo,
  pattern,
  UI,
  VNode,
  wish,
  Writable,
} from "commontools";
import { Auth, default as GoogleAuth } from "../google-auth.tsx";

export type { Auth };

// =============================================================================
// CONSTANTS
// =============================================================================

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

export const SCOPE_DESCRIPTIONS: Record<ScopeKey, string> = {
  gmail: "Gmail (read)",
  gmailSend: "Gmail (send)",
  gmailModify: "Gmail (modify)",
  calendar: "Calendar (read)",
  calendarWrite: "Calendar (write)",
  drive: "Drive",
  docs: "Docs",
  contacts: "Contacts",
};

export type ScopeKey = keyof typeof SCOPE_MAP;

// =============================================================================
// TYPES
// =============================================================================

interface GoogleAuthPiece {
  [UI]: VNode;
  auth?: Auth;
}

export interface GoogleAuthManagerInput {
  requiredScopes?: Default<ScopeKey[], []>;
}

export interface GoogleAuthManagerOutput {
  auth?: Auth;
  isReady: boolean;
  isExpired: boolean;
  missingScopes: ScopeKey[];
  [UI]: VNode;
}

// =============================================================================
// PATTERN
// =============================================================================

export const GoogleAuthManagerMinimal = pattern<
  GoogleAuthManagerInput,
  GoogleAuthManagerOutput
>(({ requiredScopes }) => {
  // Wish for auth
  const wishTag = Writable.of("#googleAuth");
  const wishResult = wish<GoogleAuthPiece>({
    query: wishTag,
    scope: [".", "~"],
  });

  // Auth state checks
  const auth = wishResult.result.auth;
  const hasAuth = computed(() => !!auth);
  const hasToken = computed(() => !!auth?.token);

  // Token expiry check
  const isExpired = computed(() => {
    const expiresAt = auth?.expiresAt ?? 0;
    return expiresAt > 0 && expiresAt < Date.now();
  });

  // Scope verification
  const missingScopes = computed((): ScopeKey[] => {
    const granted: string[] = auth?.scope ?? [];
    return (requiredScopes as ScopeKey[]).filter(
      (key) => !granted.includes(SCOPE_MAP[key]),
    );
  });
  const hasScopes = computed(() => missingScopes.length === 0);

  // Ready = has token + not expired + has required scopes
  const isReady = computed(() => hasToken && !isExpired && hasScopes);

  // Actions
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
    for (const key of requiredScopes as ScopeKey[]) selected[key] = true;
    return navigateTo(GoogleAuth({
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
    }));
  });

  const reauthenticate = action(() => navigateTo(wishResult.result));

  // UI color based on state
  const bgColor = computed(() => {
    if (!hasAuth) return "#fee2e2"; // red - no auth
    if (!hasToken) return "#fef3c7"; // yellow - needs login
    if (isExpired) return "#fecaca"; // light red - expired
    if (!hasScopes) return "#ffedd5"; // orange - missing scopes
    return "#d1fae5"; // green - ready
  });

  return {
    auth,
    isReady,
    isExpired,
    missingScopes,
    [UI]: (
      <div
        style={{
          padding: "8px",
          backgroundColor: bgColor,
          borderRadius: "6px",
        }}
      >
        <ct-select
          items={[
            { label: "Any", value: "#googleAuth" },
            { label: "Personal", value: "#googleAuthPersonal" },
            { label: "Work", value: "#googleAuthWork" },
          ]}
          $value={wishTag}
        />
        {ifElse(
          hasAuth,
          ifElse(
            hasToken,
            ifElse(
              isExpired,
              // Expired state
              <div>
                Token expired
                <ct-button onClick={reauthenticate}>Refresh</ct-button>
              </div>,
              ifElse(
                hasScopes,
                // Ready state
                <span>Authenticated as {auth?.user.email}</span>,
                // Missing scopes state
                <div>
                  <span>
                    Missing: {computed(() =>
                      (missingScopes as ScopeKey[]).map((s) =>
                        SCOPE_DESCRIPTIONS[s]
                      ).join(", ")
                    )}
                  </span>
                  <ct-button onClick={reauthenticate}>
                    Add permissions
                  </ct-button>
                </div>,
              ),
            ),
            // Needs login state
            <div>
              Needs login
              <ct-button onClick={reauthenticate}>Sign in</ct-button>
            </div>,
          ),
          // No auth state
          <div>
            No Auth
            <ct-button onClick={createAuth}>Create one</ct-button>
          </div>,
        )}
      </div>
    ),
  };
});

export default GoogleAuthManagerMinimal;
