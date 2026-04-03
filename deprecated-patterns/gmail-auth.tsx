/// <cts-enable />
import { Default, NAME, pattern, UI } from "commontools";

type CFC<T, C extends string> = T;
type Secret<T> = CFC<T, "secret">;

// Auth data structure for Google OAuth tokens
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

interface Input {
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

interface Output {
  auth: Auth;
}

export default pattern<Input, Output>(
  ({ auth }) => {
    return {
      [NAME]: "Gmail Auth",
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
            Google OAuth Authentication
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
              Status:{" "}
              {auth?.user?.email ? "✅ Authenticated" : "⚠️  Not Authenticated"}
            </h3>

            {auth?.user?.email
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
                  Click the button below to authenticate with Google
                </p>
              )}
          </div>

          <ct-google-oauth
            $auth={auth}
            scopes={[
              "email",
              "profile",
              "https://www.googleapis.com/auth/gmail.readonly",
            ]}
          />

          <div
            style={{
              padding: "15px",
              backgroundColor: "#e3f2fd",
              borderRadius: "8px",
              fontSize: "14px",
            }}
          >
            <strong>💡 Usage:</strong>{" "}
            This charm provides Google OAuth authentication. Link its{" "}
            <code>auth</code> output to any gmail importer charm's{" "}
            <code>auth</code> input.
          </div>
        </div>
      ),
      auth,
    };
  },
);
