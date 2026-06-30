/**
 * Test Pattern: AirtableAuthManager
 *
 * Exercises the Airtable wrapper over the shared auth manager.
 *
 * Run: deno task cf test packages/patterns/airtable/core/util/airtable-auth-manager.test.tsx --root packages/patterns --verbose
 */
import { computed, pattern } from "commonfabric";
import { hasText } from "../../../test/vnode-helpers.ts";
import {
  AirtableAuthManager,
  type AirtableAuthManagerOutput,
} from "./airtable-auth-manager.tsx";

interface TestOutput {
  tests: unknown[];
  manager: AirtableAuthManagerOutput;
}

export default pattern<Record<string, never>, TestOutput>(() => {
  const manager = AirtableAuthManager({
    requiredScopes: ["data.records:read", "schema.bases:read"],
  });

  const assert_loading_state = computed(() =>
    manager.currentState === "loading" &&
    manager.isReady !== true
  );

  const assert_availability_is_loading = computed(() =>
    manager.availability.state === "loading" &&
    manager.availability.auth === null
  );

  const assert_auth_info_matches_availability = computed(() =>
    manager.authInfo.state === manager.currentState &&
    manager.authInfo.availability.state === "loading" &&
    manager.authInfo.email === ""
  );

  const assert_ui_names_required_scopes = computed(() =>
    hasText(manager.fullUI, "Connect Your Airtable Account") &&
    hasText(manager.fullUI, "Read records, Read base schemas")
  );

  return {
    tests: [
      { assertion: assert_loading_state },
      { assertion: assert_availability_is_loading },
      { assertion: assert_auth_info_matches_availability },
      { assertion: assert_ui_names_required_scopes },
    ],
    manager,
  };
});
