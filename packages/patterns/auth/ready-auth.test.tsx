/**
 * Test Pattern: ready auth gate
 *
 * Exercises the shared readiness helper against an availability value that
 * changes after the helper has been created.
 *
 * Run: deno task cf test packages/patterns/auth/ready-auth.test.tsx --verbose
 */
import { action, computed, pattern, Writable } from "commonfabric";
import {
  type AuthAvailability,
  authIsReady,
  type OAuthAuthData,
} from "./auth-types.ts";

interface TestAuth extends OAuthAuthData {
  token: string;
  scope: string[];
  refreshToken: string;
  user: {
    email: string;
    name: string;
    picture: string;
  };
}

export default pattern(() => {
  const authState = new Writable<AuthAvailability<TestAuth>["state"]>(
    "loading",
  );
  const authCell = new Writable<TestAuth>({
    token: "initial",
    scope: [],
    refreshToken: "refresh",
    user: {
      email: "user@example.com",
      name: "User Example",
      picture: "",
    },
  });

  const availability = computed((): AuthAvailability<TestAuth> => {
    const state = authState.get();
    if (state === "loading") {
      return { state: "loading", auth: null };
    }
    if (state === "missing-scopes") {
      return {
        state: "missing-scopes",
        auth: authCell,
        missingScopes: ["gmail"],
      };
    }
    return { state, auth: authCell };
  });
  const authReady = authIsReady(availability);
  const mark_needs_login = action(() => {
    authState.set("needs-login");
  });
  const mark_missing_scopes = action(() => {
    authState.set("missing-scopes");
  });
  const mark_token_expired = action(() => {
    authState.set("token-expired");
  });
  const mark_ready = action(() => {
    authState.set("ready");
  });

  const refresh_through_ready_auth = action(() => {
    if (availability.state !== "ready") return;
    const currentAuth = availability.auth?.get?.();
    if (!currentAuth) return;
    availability.auth?.set?.({
      ...currentAuth,
      token: "refreshed",
    });
  });

  const mark_loading = action(() => {
    authState.set("loading");
  });

  const assert_auth_unavailable = authReady ? false : true;
  const assert_auth_available = authReady ? true : false;
  const assert_ready_reads_current_token = computed(() =>
    availability.state === "ready" &&
    availability.auth?.get?.()?.token === "initial"
  );
  const assert_refresh_writes_original_cell = computed(() =>
    authCell.get().token === "refreshed" &&
    availability.state === "ready" &&
    availability.auth?.get?.()?.token === "refreshed"
  );

  return {
    tests: [
      { assertion: assert_auth_unavailable },
      { action: mark_needs_login },
      { assertion: assert_auth_unavailable },
      { action: mark_missing_scopes },
      { assertion: assert_auth_unavailable },
      { action: mark_token_expired },
      { assertion: assert_auth_unavailable },
      { action: mark_ready },
      { assertion: assert_auth_available },
      { assertion: assert_ready_reads_current_token },
      { action: refresh_through_ready_auth },
      { assertion: assert_refresh_writes_original_cell },
      { action: mark_loading },
      { assertion: assert_auth_unavailable },
    ],
  };
});
