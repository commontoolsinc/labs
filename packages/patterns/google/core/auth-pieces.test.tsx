/**
 * Test Pattern: Google and Airtable auth pieces
 *
 * Exercises the concrete auth pieces and Google account wrappers with local
 * auth cells. No OAuth network calls are made.
 *
 * Run: deno task cf test packages/patterns/google/core/auth-pieces.test.tsx --root packages/patterns --verbose
 */
import { assert, pattern, UI, Writable } from "commonfabric";
import AirtableAuth, {
  type AirtableAuth as AirtableAuthData,
} from "../../airtable/core/airtable-auth.tsx";
import { hasText } from "../../test/vnode-helpers.ts";
import GoogleAuth, { type Auth as GoogleAuthData } from "./google-auth.tsx";
import GoogleAuthPersonal from "./google-auth-personal.tsx";
import GoogleAuthWork from "./google-auth-work.tsx";
import GoogleAuthSwitcher from "./experimental/google-auth-switcher.tsx";

const futureExpiry = 4102444800000;

const googleAuthCell = (email = "") =>
  new Writable<GoogleAuthData>({
    token: email ? "test-token" : "",
    tokenType: email ? "Bearer" : "",
    scope: email ? ["https://www.googleapis.com/auth/gmail.readonly"] : [],
    expiresIn: email ? 3600 : 0,
    expiresAt: email ? futureExpiry : 0,
    refreshToken: email ? "refresh-token" : "",
    user: {
      email,
      name: email ? "Test User" : "",
      picture: "",
    },
  });

const airtableAuthCell = () =>
  new Writable<AirtableAuthData>({
    accessToken: "",
    tokenType: "",
    scope: [],
    expiresIn: 0,
    expiresAt: 0,
    refreshToken: "",
    user: {
      email: "",
      name: "",
      picture: "",
    },
  });

const selectedGoogleScopes = {
  gmail: true,
  gmailSend: false,
  gmailModify: false,
  calendar: true,
  calendarWrite: false,
  drive: false,
  docs: false,
  contacts: false,
};

export default pattern(() => {
  const google = GoogleAuth({
    auth: googleAuthCell(),
    selectedScopes: selectedGoogleScopes,
  });

  const loggedInAuth = googleAuthCell("person@example.com");
  const personal = GoogleAuthPersonal({
    auth: loggedInAuth,
    selectedScopes: selectedGoogleScopes,
  });
  const work = GoogleAuthWork({
    auth: googleAuthCell("work@example.com"),
    selectedScopes: selectedGoogleScopes,
  });
  const switcher = GoogleAuthSwitcher({
    auth: loggedInAuth,
    selectedScopes: selectedGoogleScopes,
  });

  const airtable = AirtableAuth({
    auth: airtableAuthCell(),
    selectedScopes: {
      "data.records:read": true,
      "data.records:write": false,
      "data.recordComments:read": false,
      "data.recordComments:write": false,
      "schema.bases:read": true,
      "schema.bases:write": false,
      "webhook:manage": false,
    },
  });

  const assert_google_scopes_include_selected_permissions = assert(() =>
    google.scopes.includes("email") &&
    google.scopes.includes("profile") &&
    google.scopes.includes("https://www.googleapis.com/auth/gmail.readonly") &&
    google.scopes.includes("https://www.googleapis.com/auth/calendar.readonly")
  );

  const assert_personal_and_work_wrappers_show_account_type = assert(() =>
    personal.accountType === "personal" &&
    work.accountType === "work" &&
    hasText(personal[UI], "PERSONAL") &&
    hasText(personal[UI], "person@example.com") &&
    hasText(work[UI], "WORK") &&
    hasText(work[UI], "work@example.com")
  );

  const assert_switcher_prompts_for_classification = assert(() =>
    hasText(switcher[UI], "What type of account is this?") &&
    hasText(switcher[UI], "Personal Account") &&
    hasText(switcher[UI], "Work Account")
  );

  const assert_airtable_scopes_include_selected_permissions = assert(() =>
    airtable.scopes.includes("user.email:read") &&
    airtable.scopes.includes("data.records:read") &&
    airtable.scopes.includes("schema.bases:read")
  );

  return {
    tests: [
      { assertion: assert_google_scopes_include_selected_permissions },
      { assertion: assert_personal_and_work_wrappers_show_account_type },
      { assertion: assert_switcher_prompts_for_classification },
      { assertion: assert_airtable_scopes_include_selected_permissions },
    ],
    google,
    personal,
    work,
    switcher,
    airtable,
  };
});
