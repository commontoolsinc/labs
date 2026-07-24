/**
 * Test Pattern: GoogleAuthManager
 *
 * Tests the GoogleAuthManager pattern behavior:
 * - Initial state (loading when no auth exists)
 * - Helper computed values (isReady, currentEmail, currentState)
 * - Auth availability and AuthInfo structure
 *
 * Note: Since this pattern depends on wish() finding auth pieces,
 * we can only test the "no auth found" scenarios without external setup.
 *
 * Run: deno task cf test packages/patterns/google/core/util/google-auth-manager.test.tsx --verbose
 */
import { assert, pattern } from "commonfabric";
import {
  GoogleAuthManager,
  type GoogleAuthManagerOutput,
} from "./google-auth-manager.tsx";
import { hasText } from "../../../test/vnode-helpers.ts";

export interface TestOutput {
  tests: unknown[];
  authDefault: GoogleAuthManagerOutput;
  authWithScopes: GoogleAuthManagerOutput;
  authDebug: GoogleAuthManagerOutput;
  authWork: GoogleAuthManagerOutput;
}

export default pattern<Record<string, never>, TestOutput>(() => {
  // Instantiate with default options (no required scopes)
  const authDefault = GoogleAuthManager({});

  // Instantiate with required scopes
  const authWithScopes = GoogleAuthManager({
    requiredScopes: ["gmail", "calendar"],
  });

  // Instantiate with debug mode
  const authDebug = GoogleAuthManager({
    requiredScopes: ["gmail"],
    debugMode: true,
  });

  // Instantiate with account type
  const authWork = GoogleAuthManager({
    requiredScopes: ["gmail"],
    accountType: "work",
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  // When no auth pieces exist, state should be loading
  const assert_default_not_ready = assert(() => authDefault.isReady === false);

  const assert_default_state_initial = assert(() => {
    const state = authDefault.currentState;
    // Initial state is "loading" (wish in progress or no matches)
    return state === "loading";
  });

  const assert_default_availability_loading = assert(() =>
    authDefault.availability.state === "loading" &&
    authDefault.availability.auth === null
  );

  const assert_authInfo_exists = assert(
    () => authDefault.authInfo != null,
  );

  const assert_authInfo_state_matches = assert(
    () => authDefault.authInfo.state === authDefault.currentState,
  );

  const assert_authInfo_email_empty = assert(
    () => authDefault.authInfo.email === "",
  );

  // With scopes - should still be not ready (no auth found)
  const assert_withScopes_not_ready = assert(
    () => authWithScopes.isReady === false,
  );

  // Debug mode instance should behave the same
  const assert_debug_not_ready = assert(() => authDebug.isReady === false);

  // Work account type instance should behave the same
  const assert_work_not_ready = assert(() => authWork.isReady === false);

  // UI components should exist (even if empty/null when no auth)
  const assert_fullUI_exists = assert(() => authDefault.fullUI !== undefined);
  const assert_statusUI_exists = assert(
    () => authDefault.statusUI !== undefined,
  );
  const assert_pickerUI_exists = assert(
    () => authDefault.pickerUI !== undefined,
  );

  const assert_fullUI_names_google_permissions = assert(() =>
    hasText(authWithScopes.fullUI, "Connect Your Google Account") &&
    hasText(
      authWithScopes.fullUI,
      "Gmail (read emails), Calendar (read events)",
    )
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Initial state checks ===
      { assertion: assert_default_not_ready },
      { assertion: assert_default_state_initial },
      { assertion: assert_default_availability_loading },

      // === AuthInfo structure checks ===
      { assertion: assert_authInfo_exists },
      { assertion: assert_authInfo_state_matches },
      { assertion: assert_authInfo_email_empty },

      // === Variant instances ===
      { assertion: assert_withScopes_not_ready },
      { assertion: assert_debug_not_ready },
      { assertion: assert_work_not_ready },

      // === UI component existence ===
      { assertion: assert_fullUI_exists },
      { assertion: assert_statusUI_exists },
      { assertion: assert_pickerUI_exists },
      { assertion: assert_fullUI_names_google_permissions },
    ],
    // Expose subjects for debugging
    authDefault,
    authWithScopes,
    authDebug,
    authWork,
  };
});
