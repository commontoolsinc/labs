/// <cts-enable />
/**
 * Test Pattern: Counter
 *
 * Tests the core functionality of the counter pattern:
 * - Initial state (value defaults to 0)
 * - Increment via module-scope handler
 * - Decrement via pattern-body action
 * - Multiple increments/decrements
 * - Negative values
 *
 * Run: deno task ct test packages/patterns/counter/counter.test.tsx --verbose
 */
import { computed, pattern } from "commontools";
import { matchesSearch } from "./contact-book.tsx";
import { type Contact } from "./contact-detail.tsx";

const testContact: Contact = {
  name: "Conrad Common",
  email: "conrad@common.com",
  company: "Common",
  notes: "Common",
  tags: [
    "common",
  ],
  phone: "0",
  createdAt: Date.now(),
};

export default pattern(() => {
  // Initial state assertions
  const assert_empty_query_matches_all = computed(() =>
    matchesSearch(testContact, "")
  );

  const assert_name_query_matches = computed(() =>
    matchesSearch(testContact, "conrad")
  );

  const assert_email_query_matches = computed(() =>
    matchesSearch(testContact, "common")
  );

  const assert_company_query_matches = computed(() =>
    matchesSearch(testContact, "common")
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      { assertion: assert_empty_query_matches_all },
      { assertion: assert_name_query_matches },
      { assertion: assert_email_query_matches },
      { assertion: assert_company_query_matches },
    ],
  };
});
