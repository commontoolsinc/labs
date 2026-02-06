/// <cts-enable />
import {
  action,
  computed,
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

interface GoogleAuthPiece {
  [UI]: VNode;
  auth?: Auth;
}

export interface GoogleAuthManagerOutput {
  auth?: Auth;
  [UI]: VNode;
}

export const GoogleAuthManagerMinimal = pattern<
  Record<string, never>,
  GoogleAuthManagerOutput
>(() => {
  const wishTag = Writable.of("#googleAuth");
  const wishResult = wish<GoogleAuthPiece>({
    query: wishTag,
    scope: [".", "~"],
  });

  const hasAuthInstance = computed(() => !!wishResult.result.auth);
  const hasAuthToken = computed(() => !!wishResult.result.auth?.token);
  const createAuth = action(() => {
    return navigateTo(GoogleAuth({
      selectedScopes: {
        gmail: true,
        gmailSend: true,
        gmailModify: true,
        calendar: true,
        calendarWrite: true,
        drive: true,
        docs: true,
        contacts: true,
      },
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

  const reauthenticate = action(() => {
    return navigateTo(wishResult.result);
  });

  // Q: Does a static UI render?
  return {
    auth: wishResult.result.auth,
    [UI]: (
      <div
        style={{
          padding: "8px",
          backgroundColor: hasAuthInstance
            ? hasAuthToken ? "green" : "yellow"
            : "pink",
        }}
      >
        <ct-select
          items={[{ label: "Any", value: "#googleAuth" }, {
            label: "Personal",
            value: "#googleAuthPersonal",
          }, {
            label: "Work",
            value: "#googleAuthWork",
          }]}
          $value={wishTag}
        />
        {ifElse(
          hasAuthInstance,
          ifElse(
            hasAuthToken,
            "Authenticated as " + wishResult.result.auth?.user.email,
            <div>
              Needs re-auth,
              <ct-button onClick={reauthenticate}>Re-authenticate</ct-button>
            </div>,
          ),
          <div>
            No Auth,
            <ct-button
              onClick={createAuth}
            >
              create one
            </ct-button>
          </div>,
        )}
      </div>
    ),
  };
});

export default GoogleAuthManagerMinimal;
