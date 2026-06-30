/**
 * Test Pattern: AuthManagerBase
 *
 * Exercises the shared auth manager state that provider-specific auth managers
 * inherit.
 *
 * Run: deno task cf test packages/patterns/auth/create-auth-manager.test.tsx --verbose
 */
import { action, computed, pattern } from "commonfabric";
import type { AuthManagerDescriptor } from "./auth-manager-descriptor.ts";
import { AuthManagerBase } from "./create-auth-manager.tsx";
import { hasText } from "../test/vnode-helpers.ts";

const descriptor: AuthManagerDescriptor = {
  name: "test",
  displayName: "Test",
  brandColor: "#123456",
  wishTag: "#testAuth",
  variantWishTags: {
    work: "#testAuthWork",
  },
  tokenField: "token",
  scopes: {
    read: {
      description: "Read things",
      scopeString: "read:things",
    },
    write: {
      description: "Write things",
      scopeString: "write:things",
    },
  },
  hasAvatarSupport: false,
};

export default pattern(() => {
  const createAuth = action(() => null);

  const manager = AuthManagerBase({
    descriptor,
    createAuth,
    requiredScopes: ["read"],
  });

  const workManager = AuthManagerBase({
    descriptor,
    createAuth,
    requiredScopes: ["read", "write"],
    accountType: "work",
  });

  const assert_loading_state = computed(() =>
    manager.currentState === "loading" &&
    manager.isReady !== true
  );

  const assert_availability_is_loading = computed(() =>
    manager.availability.state === "loading" &&
    manager.availability.auth === null
  );

  const assert_auth_info_matches_state = computed(() =>
    manager.authInfo.state === "loading" &&
    manager.authInfo.availability.state === "loading" &&
    manager.authInfo.email === "" &&
    manager.authInfo.hasRequiredScopes === false
  );

  const assert_full_ui_explains_connection = computed(() =>
    hasText(manager.fullUI, "Connect Your Test Account") &&
    hasText(manager.fullUI, "Read things") &&
    hasText(manager.fullUI, "Connect Test Account")
  );

  const assert_status_ui_shows_loading = computed(() =>
    hasText(manager.statusUI, "Loading auth...")
  );

  const assert_work_variant_uses_same_loading_contract = computed(() =>
    workManager.fullUI !== undefined &&
    workManager.statusUI !== undefined &&
    workManager.pickerUI !== undefined
  );

  return {
    tests: [
      { assertion: assert_loading_state },
      { assertion: assert_availability_is_loading },
      { assertion: assert_auth_info_matches_state },
      { assertion: assert_full_ui_explains_connection },
      { assertion: assert_status_ui_shows_loading },
      { assertion: assert_work_variant_uses_same_loading_contract },
    ],
    manager,
    workManager,
  };
});
