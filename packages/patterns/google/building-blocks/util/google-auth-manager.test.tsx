/// <cts-enable />
/**
 * Test Pattern: GoogleAuthManager
 *
 * Tests the GoogleAuthManager pattern behavior:
 * - Initial state (loading/not-found when no auth exists)
 * - Helper computed values (isReady, currentEmail, currentState)
 * - AuthInfo structure
 *
 * Note: Since this pattern depends on wish() finding auth charms,
 * we can only test the "no auth found" scenarios without external setup.
 *
 * Run: deno task ct test packages/patterns/google/building-blocks/util/google-auth-manager.test.tsx --verbose
 */
import { computed, pattern } from "commontools";
import { GoogleAuthManager } from "./google-auth-manager.tsx";

export default pattern(() => {
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

  // When no auth charms exist, state should be loading or not-found
  const assert_default_not_ready = computed(() =>
    authDefault.isReady === false
  );

  const assert_default_state_initial = computed(() => {
    const state = authDefault.currentState;
    // Initial state is either "loading" (wish in progress) or "not-found" (no matches)
    return state === "loading" || state === "not-found";
  });

  const assert_default_auth_null = computed(() => authDefault.auth === null);

  // AuthInfo should exist and have expected structure
  const assert_authInfo_exists = computed(() => authDefault.authInfo !== null);

  const assert_authInfo_state_matches = computed(
    () => authDefault.authInfo.state === authDefault.currentState,
  );

  const assert_authInfo_email_empty = computed(
    () => authDefault.authInfo.email === "",
  );

  // With scopes - should still be not ready (no auth found)
  const assert_withScopes_not_ready = computed(
    () => authWithScopes.isReady === false,
  );

  // Debug mode instance should behave the same
  const assert_debug_not_ready = computed(() => authDebug.isReady === false);

  // Work account type instance should behave the same
  const assert_work_not_ready = computed(() => authWork.isReady === false);

  // UI components should exist (even if empty/null when no auth)
  const assert_fullUI_exists = computed(() => authDefault.fullUI !== undefined);
  const assert_statusUI_exists = computed(
    () => authDefault.statusUI !== undefined,
  );
  const assert_pickerUI_exists = computed(
    () => authDefault.pickerUI !== undefined,
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Initial state checks ===
      { assertion: assert_default_not_ready },
      { assertion: assert_default_state_initial },
      { assertion: assert_default_auth_null },

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
    ],
    // Expose subjects for debugging
    authDefault,
    authWithScopes,
    authDebug,
    authWork,
  };
});
