/// <cts-enable />
/**
 * Google Auth Switcher - Post-hoc Classification
 *
 * This pattern allows users to:
 * 1. Log in with any Google account
 * 2. AFTER seeing their email, classify it as "Personal" or "Work"
 * 3. Creates a wrapper pattern with the right tags and navigates to it
 *
 * Better UX than pre-hoc: user sees actual email before classifying.
 */
import {
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commontools";
import GoogleAuth, { Auth } from "../google-auth.tsx";
import GoogleAuthPersonal from "../google-auth-personal.tsx";
import GoogleAuthWork from "../google-auth-work.tsx";

// Same selected scopes type as base GoogleAuth
type SelectedScopes = {
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
  selectedScopes: Default<
    SelectedScopes,
    {
      gmail: true;
      gmailSend: false;
      gmailModify: false;
      calendar: true;
      calendarWrite: false;
      drive: false;
      docs: false;
      contacts: false;
    }
  >;
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

/** Google account switcher for choosing personal/work accounts. #googleAuthSwitcher */
interface Output {
  auth: Auth;
}

// Handler to create personal wrapper and navigate to it
const createPersonalWrapper = handler<
  unknown,
  { auth: Writable<Auth>; selectedScopes: Writable<SelectedScopes> }
>((_, { auth, selectedScopes }) => {
  const wrapper = GoogleAuthPersonal({ auth, selectedScopes });
  return navigateTo(wrapper);
});

// Handler to create work wrapper and navigate to it
const createWorkWrapper = handler<
  unknown,
  { auth: Writable<Auth>; selectedScopes: Writable<SelectedScopes> }
>((_, { auth, selectedScopes }) => {
  const wrapper = GoogleAuthWork({ auth, selectedScopes });
  return navigateTo(wrapper);
});

export default pattern<Input, Output>(({ auth, selectedScopes }) => {
  // Compose the base GoogleAuth pattern
  const baseAuth = GoogleAuth({ auth, selectedScopes });

  // Check if logged in
  const isLoggedIn = computed(() => !!baseAuth.auth?.user?.email);
  const userEmail = computed(() => baseAuth.auth?.user?.email || "");

  return {
    [NAME]: computed(() =>
      baseAuth.auth?.user?.email
        ? `Google Auth Setup - ${baseAuth.auth.user.email}`
        : "Google Auth Setup"
    ),
    [UI]: (
      <div>
        {/* CLASSIFICATION CTA - Show at TOP after login */}
        {computed(() =>
          isLoggedIn
            ? (
              <div
                style={{
                  marginBottom: "20px",
                  padding: "24px",
                  background:
                    "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                  borderRadius: "12px",
                  color: "white",
                  boxShadow: "0 4px 15px rgba(102, 126, 234, 0.4)",
                }}
              >
                <h3
                  style={{
                    margin: "0 0 8px 0",
                    fontSize: "20px",
                    fontWeight: "bold",
                  }}
                >
                  What type of account is this?
                </h3>
                <p style={{ margin: "0 0 16px 0", opacity: 0.9 }}>
                  Logged in as: <strong>{userEmail}</strong>
                </p>

                <div
                  style={{ display: "flex", gap: "12px", marginBottom: "16px" }}
                >
                  <button
                    type="button"
                    onClick={createPersonalWrapper({
                      auth: baseAuth.auth,
                      selectedScopes,
                    })}
                    style={{
                      padding: "14px 28px",
                      background: "#3b82f6",
                      color: "white",
                      border: "2px solid white",
                      borderRadius: "8px",
                      cursor: "pointer",
                      fontSize: "16px",
                      fontWeight: "700",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                    }}
                  >
                    Personal Account
                  </button>
                  <button
                    type="button"
                    onClick={createWorkWrapper({
                      auth: baseAuth.auth,
                      selectedScopes,
                    })}
                    style={{
                      padding: "14px 28px",
                      background: "#dc2626",
                      color: "white",
                      border: "2px solid white",
                      borderRadius: "8px",
                      cursor: "pointer",
                      fontSize: "16px",
                      fontWeight: "700",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                    }}
                  >
                    Work Account
                  </button>
                </div>

                <p
                  style={{
                    margin: "0",
                    fontSize: "13px",
                    opacity: 0.8,
                    fontStyle: "italic",
                  }}
                >
                  This will create a tagged wrapper and navigate you there to
                  favorite.
                </p>
              </div>
            )
            : null
        )}

        {/* Embed base auth UI */}
        {baseAuth as any}
      </div>
    ),
    auth: baseAuth.auth,
  };
});
