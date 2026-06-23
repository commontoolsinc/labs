/**
 * Work Google Auth Wrapper
 *
 * Wraps the base google-auth pattern and adds the #googleAuthWork tag.
 * Use this when you want to explicitly mark an auth as "work".
 *
 * Can be used two ways:
 * 1. Pre-hoc: Create this directly, log in, and favorite
 * 2. Post-hoc: Created by google-auth-switcher after login
 */
import {
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  TILE_UI,
  UI,
  type Writable,
} from "commonfabric";
import GoogleAuth, {
  Auth,
  createPreviewUI,
  type GoogleAuthCell,
  SelectedScopes,
} from "./google-auth.tsx";

interface Input {
  selectedScopes:
    | SelectedScopes
    | Default<{
      gmail: true;
      gmailSend: true;
      gmailModify: true;
      calendar: true;
      calendarWrite: true;
      drive: true;
      docs: true;
      contacts: true;
    }>;
  auth: GoogleAuthCell;
}

/** Work Google account. #googleAuth #googleAuthWork */
export interface Output {
  auth: Writable<Auth>;
  accountType: "work";
  /** Minimal preview for picker display with WORK badge */
  [TILE_UI]: unknown;
}

export default pattern<Input, Output>(({ auth, selectedScopes }) => {
  // Compose the base GoogleAuth pattern
  const baseAuth = GoogleAuth({ auth, selectedScopes });

  // Enhanced preview with WORK badge using shared helper
  // Build scopes record manually (same pattern as google-auth.tsx to avoid type casting)
  const previewUI = computed(() =>
    createPreviewUI(
      baseAuth.auth.get(),
      {
        gmail: selectedScopes.gmail,
        gmailSend: selectedScopes.gmailSend,
        gmailModify: selectedScopes.gmailModify,
        calendar: selectedScopes.calendar,
        calendarWrite: selectedScopes.calendarWrite,
        drive: selectedScopes.drive,
        docs: selectedScopes.docs,
        contacts: selectedScopes.contacts,
      },
      { text: "WORK", color: "#dc2626" },
    )
  );

  return {
    [NAME]: computed(() => {
      const authValue = baseAuth.auth.get();
      return `Google Auth (Work)${
        authValue?.user?.email ? ` - ${authValue.user.email}` : ""
      }`;
    }),
    [UI]: (
      <div>
        {/* Account type badge */}
        <div
          style={{
            padding: "8px 12px",
            background: "#fee2e2",
            borderRadius: "6px",
            marginBottom: "12px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span
            style={{
              background: "#dc2626",
              color: "white",
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "12px",
              fontWeight: "600",
            }}
          >
            WORK
          </span>
          <span>
            {computed(() =>
              baseAuth.auth.get()?.user?.email || "Not logged in"
            )}
          </span>
        </div>

        {/* Embed the base auth UI */}
        {baseAuth[UI]}

        {/* Prominent favorite CTA - only show when logged in */}
        {ifElse(
          computed(() => !!baseAuth.auth.get()?.user?.email),
          <div
            style={{
              marginTop: "16px",
              padding: "20px",
              background: "linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)",
              borderRadius: "12px",
              border: "2px solid #dc2626",
              textAlign: "center",
            }}
          >
            <h3
              style={{
                margin: "0 0 8px 0",
                fontSize: "18px",
                color: "#991b1b",
              }}
            >
              Favorite This Piece!
            </h3>
            <p
              style={{
                margin: "0 0 12px 0",
                fontSize: "14px",
                color: "#dc2626",
              }}
            >
              Click the star to save your work Google auth
            </p>
            <p style={{ margin: "0", fontSize: "13px", color: "#64748b" }}>
              Patterns can then find it via{" "}
              <code
                style={{
                  background: "#fee2e2",
                  padding: "2px 6px",
                  borderRadius: "4px",
                }}
              >
                #googleAuthWork
              </code>
            </p>
          </div>,
          null,
        )}
      </div>
    ),
    auth: baseAuth.auth,
    accountType: "work" as const,
    [TILE_UI]: previewUI,
  };
});
