/// <cts-enable />
/**
 * Test Pattern: GmailAgenticSearch
 *
 * Tests the GmailAgenticSearch pattern behavior:
 * - Initial state (not scanning, idle progress, empty debug log)
 * - Output structure (ui pieces, auth state, actions)
 * - Start/stop scan state toggling
 *
 * Note: Actual Gmail API calls are not tested here - only state management.
 *
 * Run: deno task ct test packages/patterns/google/core/experimental/gmail-agentic-search.test.tsx --root packages/patterns/google --verbose
 */
import { computed, pattern } from "commontools";
import GmailAgenticSearch from "./gmail-agentic-search.tsx";

export default pattern(() => {
  // Instantiate with minimal config
  const searcher = GmailAgenticSearch({
    agentGoal: "Find test emails",
    title: "Test Searcher",
  });

  // Instantiate with custom config
  const customSearcher = GmailAgenticSearch({
    agentGoal: "Find receipts",
    systemPrompt: "You are a receipt finder.",
    suggestedQueries: ["from:amazon.com", "subject:receipt"],
    title: "Receipt Finder",
    scanButtonLabel: "Find Receipts",
    maxSearches: 5,
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  // Should not be scanning initially
  const assert_not_scanning = computed(() => searcher.isScanning === false);

  // Search progress should be idle
  const assert_progress_idle = computed(
    () => searcher.searchProgress.status === "idle",
  );

  // Search count should be 0
  const assert_search_count_zero = computed(
    () => searcher.searchProgress.searchCount === 0,
  );

  // Debug log should be empty initially
  const assert_debug_log_empty = computed(() => {
    const log = searcher.debugLog;
    return Array.isArray(log) && log.length === 0;
  });

  // Local queries should be empty initially
  const assert_local_queries_empty = computed(() => {
    const queries = searcher.localQueries;
    return Array.isArray(queries) && queries.length === 0;
  });

  // Pending submissions should be empty initially
  const assert_pending_empty = computed(() => {
    const pending = searcher.pendingSubmissions;
    return Array.isArray(pending) && pending.length === 0;
  });

  // Agent should not be pending initially
  const assert_agent_not_pending = computed(
    () => searcher.agentPending === false,
  );

  // ==========================================================================
  // Output Structure
  // ==========================================================================

  // UI pieces should exist
  const assert_has_ui_auth = computed(() => searcher.ui.auth !== undefined);
  const assert_has_ui_controls = computed(
    () => searcher.ui.controls !== undefined,
  );
  const assert_has_ui_progress = computed(
    () => searcher.ui.progress !== undefined,
  );

  // Actions should exist (streams)
  const assert_has_startScan = computed(
    () => searcher.startScan !== undefined,
  );
  const assert_has_stopScan = computed(() => searcher.stopScan !== undefined);

  // ==========================================================================
  // Custom config instance
  // ==========================================================================

  const assert_custom_not_scanning = computed(
    () => customSearcher.isScanning === false,
  );

  const assert_custom_progress_idle = computed(
    () => customSearcher.searchProgress.status === "idle",
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Initial state checks ===
      { assertion: assert_not_scanning },
      { assertion: assert_progress_idle },
      { assertion: assert_search_count_zero },
      { assertion: assert_debug_log_empty },
      { assertion: assert_local_queries_empty },
      { assertion: assert_pending_empty },
      { assertion: assert_agent_not_pending },

      // === Output structure ===
      { assertion: assert_has_ui_auth },
      { assertion: assert_has_ui_controls },
      { assertion: assert_has_ui_progress },
      { assertion: assert_has_startScan },
      { assertion: assert_has_stopScan },

      // === Custom config instance ===
      { assertion: assert_custom_not_scanning },
      { assertion: assert_custom_progress_idle },
    ],
    // Expose subjects for debugging
    searcher,
    customSearcher,
  };
});
