/// <cts-enable />
/**
 * Personal Google Auth Wrapper
 *
 * Wraps the base google-auth pattern and adds the #googleAuthPersonal tag.
 * Use this when you want to explicitly mark an auth as "personal".
 *
 * Can be used two ways:
 * 1. Pre-hoc: Create this directly, log in, and favorite
 * 2. Post-hoc: Created by google-auth-switcher after login
 */
import { computed, Default, ifElse, NAME, pattern, UI } from "commontools";
import GoogleAuth, {
  Auth,
  createPreviewUI,
  SelectedScopes,
} from "./google-auth.tsx";

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
  auth: Default<
    Auth,
    {
      token: "";
      tokenType: "";
      scope: [];
      expiresIn: 0;
      expiresAt: 0;
      refreshToken: "";
      user: { email: ""; name: ""; picture: "" };
    }
  >;
}

/** Personal Google account. #googleAuth #googleAuthPersonal */
interface Output {
  auth: Auth;
  accountType: "personal";
  /** Minimal preview for picker display with PERSONAL badge */
  previewUI: unknown;
}

export default pattern<Input, Output>(({ auth, selectedScopes }) => {
  // Compose the base GoogleAuth pattern
  const baseAuth = GoogleAuth({ auth, selectedScopes });

  // Enhanced preview with PERSONAL badge using shared helper
  // Build scopes record manually (same pattern as google-auth.tsx to avoid type casting)
  const previewUI = computed(() =>
    createPreviewUI(
      baseAuth.auth,
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
      { text: "PERSONAL", color: "#3b82f6" },
    )
  );

  return {
    [NAME]: computed(() =>
      `Google Auth (Personal)${
        baseAuth.auth?.user?.email ? ` - ${baseAuth.auth.user.email}` : ""
      }`
    ),
    [UI]: (
      <div>
        {/* Account type badge */}
        <div
          style={{
            padding: "8px 12px",
            background: "#dbeafe",
            borderRadius: "6px",
            marginBottom: "12px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span
            style={{
              background: "#3b82f6",
              color: "white",
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "12px",
              fontWeight: "600",
            }}
          >
            PERSONAL
          </span>
          <span>
            {computed(() => baseAuth.auth?.user?.email || "Not logged in")}
          </span>
        </div>

        {/* Embed the base auth UI */}
        {baseAuth as any}

        {/* Prominent favorite CTA - only show when logged in */}
        {ifElse(
          computed(() => !!baseAuth.auth?.user?.email),
          <div
            style={{
              marginTop: "16px",
              padding: "20px",
              background: "linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)",
              borderRadius: "12px",
              border: "2px solid #3b82f6",
              textAlign: "center",
            }}
          >
            <h3
              style={{
                margin: "0 0 8px 0",
                fontSize: "18px",
                color: "#1e40af",
              }}
            >
              Favorite This Piece!
            </h3>
            <p
              style={{
                margin: "0 0 12px 0",
                fontSize: "14px",
                color: "#3b82f6",
              }}
            >
              Click the star to save your personal Google auth
            </p>
            <p style={{ margin: "0", fontSize: "13px", color: "#64748b" }}>
              Patterns can then find it via{" "}
              <code
                style={{
                  background: "#e0e7ff",
                  padding: "2px 6px",
                  borderRadius: "4px",
                }}
              >
                #googleAuthPersonal
              </code>
            </p>
          </div>,
          null,
        )}
      </div>
    ),
    auth: baseAuth.auth,
    accountType: "personal" as const,
    previewUI,
  };
});
