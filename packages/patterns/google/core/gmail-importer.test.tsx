/**
 * Test Pattern: GmailImporter
 *
 * Tests the GmailImporter pattern behavior:
 * - Initial state (empty emails, count 0)
 * - Output structure
 *
 * Note: Since this pattern depends on Gmail API calls, we can only test
 * initial state without mocking. The googleUpdater handler is not tested
 * here as it requires real API credentials.
 *
 * Run: deno task cf test packages/patterns/google/core/gmail-importer.test.tsx --root packages/patterns --verbose
 */
import { computed, pattern, UI, Writable } from "commonfabric";
import GmailImporter, { type Auth } from "./gmail-importer.tsx";
import { hasText } from "../../test/vnode-helpers.ts";

const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const futureExpiry = 4102444800000;

export default pattern(() => {
  // Instantiate with default settings
  const importer = GmailImporter({
    settings: {
      gmailFilterQuery: "in:INBOX",
      limit: 10,
      debugMode: false,
      autoFetchOnAuth: false,
      resolveInlineImages: false,
    },
  });

  // Instantiate with custom settings
  const importerWithSettings = GmailImporter({
    settings: {
      gmailFilterQuery: "label:important",
      limit: 50,
      debugMode: true,
      autoFetchOnAuth: false,
      resolveInlineImages: true,
    },
  });

  const directAuth = new Writable<Auth>({
    token: "test-token",
    tokenType: "Bearer",
    scope: [gmailScope],
    expiresIn: 3600,
    expiresAt: futureExpiry,
    refreshToken: "refresh-token",
    user: {
      email: "direct@example.com",
      name: "Direct User",
      picture: "",
    },
  });

  const importerWithOverrideAuth = GmailImporter({
    settings: {
      gmailFilterQuery: "in:INBOX",
      limit: 5,
      debugMode: false,
      autoFetchOnAuth: false,
      resolveInlineImages: false,
    },
    overrideAuth: directAuth,
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  // Emails should start empty
  const assert_emails_empty = computed(() => {
    const emails = importer.emails;
    return Array.isArray(emails) && emails.length === 0;
  });

  // Email count should be 0
  const assert_count_zero = computed(() => importer.emailCount === 0);

  // With custom settings - should also start empty
  const assert_settings_emails_empty = computed(() => {
    const emails = importerWithSettings.emails;
    return Array.isArray(emails) && emails.length === 0;
  });

  const assert_settings_count_zero = computed(
    () => importerWithSettings.emailCount === 0,
  );

  // Output structure checks
  const assert_has_emails_property = computed(
    () => importer.emails !== undefined,
  );

  const assert_has_emailCount_property = computed(
    () => importer.emailCount !== undefined,
  );

  const assert_override_auth_marks_importer_ready = computed(() =>
    importerWithOverrideAuth.isReady === true &&
    hasText(importerWithOverrideAuth[UI], "Fetch Emails")
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Initial state checks ===
      { assertion: assert_emails_empty },
      { assertion: assert_count_zero },

      // === Custom settings instance ===
      { assertion: assert_settings_emails_empty },
      { assertion: assert_settings_count_zero },

      // === Output structure ===
      { assertion: assert_has_emails_property },
      { assertion: assert_has_emailCount_property },
      { assertion: assert_override_auth_marks_importer_ready },
    ],
    // Expose subjects for debugging
    importer,
    importerWithSettings,
    importerWithOverrideAuth,
  };
});
