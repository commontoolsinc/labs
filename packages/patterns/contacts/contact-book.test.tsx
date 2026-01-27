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
import { action, computed, pattern } from "commontools";
import { default as ContactBook, matchesSearch } from "./contact-book.tsx";
import { type Contact } from "./contact-detail.tsx";

// Helper to get array length with proper reactivity tracking
const len = <T,>(arr: T[]): number => arr.filter(() => true).length;

const testContact: Contact = {
  name: "Conrad Common",
  email: "conrad@testmail.io",
  company: "Widgets Inc",
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
    matchesSearch(testContact, "testmail")
  );

  const assert_company_query_matches = computed(() =>
    matchesSearch(testContact, "widgets")
  );

  const contactBook = ContactBook({ contacts: [], relationships: [] });

  const action_add_contact = action(() => {
    contactBook.onAddContact.send();
  });

  const assert_one_contact = computed(
    () => len(contactBook.contacts) == 1,
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

      { action: action_add_contact },
      { assertion: assert_one_contact },
    ],
  };
});
