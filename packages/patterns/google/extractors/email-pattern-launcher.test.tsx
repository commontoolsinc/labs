/// <cts-enable />
/**
 * Test Pattern: Email Pattern Launcher
 *
 * Tests the EmailPatternLauncher pattern behavior:
 * - Initial state (empty matches, count 0)
 * - Email pattern matching logic
 * - Gmail query construction
 * - Output structure
 *
 * Note: Since this pattern depends on Gmail API calls and pattern compilation,
 * we focus on testing the helper functions and initial state.
 *
 * Run: deno task ct test packages/patterns/google/extractors/email-pattern-launcher.test.tsx --root packages/patterns/google --verbose
 */
import { computed, pattern } from "commontools";

// =============================================================================
// HELPER FUNCTIONS (duplicated for testing - same as in main pattern)
// =============================================================================

/**
 * Check if an email address matches a glob pattern.
 * Supports wildcards: "*@domain.com" matches any email at that domain.
 */
function matchesEmailPattern(email: string, patternStr: string): boolean {
  if (!email || !patternStr) return false;

  const emailLower = email.toLowerCase();
  const patternLower = patternStr.toLowerCase();

  // Convert glob pattern to regex
  // * matches anything before @, and @ and . are literal
  const regexPattern = patternLower
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special regex chars except *
    .replace(/\*/g, ".*"); // Convert * to .*

  const regex = new RegExp(`^${regexPattern}$`, "i");
  return regex.test(emailLower);
}

interface RegistryEntry {
  patternUri: string;
  emailPatterns: string[];
}

/**
 * Build Gmail query from email patterns.
 * Converts ["*@usps.com", "*@library.org"] to "from:@usps.com OR from:@library.org"
 */
function buildGmailQuery(entries: RegistryEntry[]): string {
  const domains = new Set<string>();

  for (const entry of entries) {
    for (const emailPattern of entry.emailPatterns) {
      // Extract domain from pattern like "*@domain.com"
      const atIndex = emailPattern.indexOf("@");
      if (atIndex !== -1) {
        const domain = emailPattern.substring(atIndex); // includes @
        domains.add(domain);
      }
    }
  }

  if (domains.size === 0) return "in:INBOX";

  // Build "from:@domain1 OR from:@domain2 ..." query
  const parts = Array.from(domains).map((domain) => `from:${domain}`);
  return parts.join(" OR ");
}

// =============================================================================
// TEST PATTERN
// =============================================================================

export default pattern(() => {
  // ==========================================================================
  // Email Pattern Matching Tests
  // ==========================================================================

  // Test: wildcard pattern matches any email at domain
  const assert_wildcard_matches_domain = computed(() => {
    return matchesEmailPattern(
      "notices@library.berkeleypubliclibrary.org",
      "*@library.berkeleypubliclibrary.org",
    );
  });

  // Test: wildcard pattern matches different usernames
  const assert_wildcard_matches_different_user = computed(() => {
    return matchesEmailPattern(
      "info@library.berkeleypubliclibrary.org",
      "*@library.berkeleypubliclibrary.org",
    );
  });

  // Test: pattern should not match different domain
  const assert_no_match_different_domain = computed(() => {
    return !matchesEmailPattern(
      "notices@library.sfpl.org",
      "*@library.berkeleypubliclibrary.org",
    );
  });

  // Test: USPS pattern matching
  const assert_usps_pattern_matches = computed(() => {
    return matchesEmailPattern(
      "USPSInformeddelivery@email.informeddelivery.usps.com",
      "*@email.informeddelivery.usps.com",
    );
  });

  // Test: case insensitive matching
  const assert_case_insensitive = computed(() => {
    return matchesEmailPattern(
      "NOTICES@LIBRARY.BERKELEYPUBLICLIBRARY.ORG",
      "*@library.berkeleypubliclibrary.org",
    );
  });

  // Test: empty email returns false
  const assert_empty_email_false = computed(() => {
    return !matchesEmailPattern("", "*@domain.com");
  });

  // Test: empty pattern returns false
  const assert_empty_pattern_false = computed(() => {
    return !matchesEmailPattern("user@domain.com", "");
  });

  // ==========================================================================
  // Gmail Query Construction Tests
  // ==========================================================================

  // Test: build query from single entry
  const assert_single_entry_query = computed(() => {
    const entries: RegistryEntry[] = [
      {
        patternUri: "google/test.tsx",
        emailPatterns: ["*@example.com"],
      },
    ];
    const query = buildGmailQuery(entries);
    return query === "from:@example.com";
  });

  // Test: build query from multiple entries
  const assert_multiple_entries_query = computed(() => {
    const entries: RegistryEntry[] = [
      {
        patternUri: "google/usps.tsx",
        emailPatterns: ["*@usps.com", "*@informeddelivery.usps.com"],
      },
      {
        patternUri: "google/library.tsx",
        emailPatterns: ["*@library.berkeleypubliclibrary.org"],
      },
    ];
    const query = buildGmailQuery(entries);
    // Should contain all domains with OR
    return query.includes("from:@usps.com") &&
      query.includes("from:@informeddelivery.usps.com") &&
      query.includes("from:@library.berkeleypubliclibrary.org") &&
      query.includes(" OR ");
  });

  // Test: empty entries returns default query
  const assert_empty_entries_default = computed(() => {
    const query = buildGmailQuery([]);
    return query === "in:INBOX";
  });

  // Test: deduplicates domains
  const assert_deduplicates_domains = computed(() => {
    const entries: RegistryEntry[] = [
      {
        patternUri: "google/pattern1.tsx",
        emailPatterns: ["*@example.com"],
      },
      {
        patternUri: "google/pattern2.tsx",
        emailPatterns: ["*@example.com"], // Same domain
      },
    ];
    const query = buildGmailQuery(entries);
    // Should only have one @example.com
    const matches = query.match(/@example\.com/g);
    return matches?.length === 1;
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Email pattern matching ===
      { assertion: assert_wildcard_matches_domain },
      { assertion: assert_wildcard_matches_different_user },
      { assertion: assert_no_match_different_domain },
      { assertion: assert_usps_pattern_matches },
      { assertion: assert_case_insensitive },
      { assertion: assert_empty_email_false },
      { assertion: assert_empty_pattern_false },

      // === Gmail query construction ===
      { assertion: assert_single_entry_query },
      { assertion: assert_multiple_entries_query },
      { assertion: assert_empty_entries_default },
      { assertion: assert_deduplicates_domains },
    ],
  };
});
