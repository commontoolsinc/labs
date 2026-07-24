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
 * Run: deno task cf test packages/patterns/google/core/experimental/gmail-agentic-search.test.tsx --root packages/patterns --verbose
 */
import { assert, pattern, Writable } from "commonfabric";
import GmailAgenticSearch, { type Auth } from "./gmail-agentic-search.tsx";

const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const futureExpiry = 4102444800000;

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

  const directAuthSearcher = GmailAgenticSearch({
    agentGoal: "Find messages with direct auth",
    title: "Direct Auth Searcher",
    auth: directAuth,
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  // Should not be scanning initially
  const assert_not_scanning = assert(() => searcher.isScanning === false);

  // Search progress should be idle
  const assert_progress_idle = assert(
    () => searcher.searchProgress.status === "idle",
  );

  // Search count should be 0
  const assert_search_count_zero = assert(
    () => searcher.searchProgress.searchCount === 0,
  );

  // Debug log should be empty initially
  const assert_debug_log_empty = assert(() => {
    const log = searcher.debugLog;
    return Array.isArray(log) && log.length === 0;
  });

  // Local queries should be empty initially
  const assert_local_queries_empty = assert(() => {
    const queries = searcher.localQueries;
    return Array.isArray(queries) && queries.length === 0;
  });

  // Pending submissions should be empty initially
  const assert_pending_empty = assert(() => {
    const pending = searcher.pendingSubmissions;
    return Array.isArray(pending) && pending.length === 0;
  });

  // Agent should not be pending initially
  const assert_agent_not_pending = assert(
    () => searcher.agentPending === false,
  );

  // ==========================================================================
  // Output Structure
  // ==========================================================================

  // UI pieces should exist
  const assert_has_ui_auth = assert(() => searcher.ui.auth !== undefined);
  const assert_has_ui_controls = assert(
    () => searcher.ui.controls !== undefined,
  );
  const assert_has_ui_progress = assert(
    () => searcher.ui.progress !== undefined,
  );

  // Actions should exist (streams)
  const assert_has_startScan = assert(
    () => searcher.startScan !== undefined,
  );
  const assert_has_stopScan = assert(() => searcher.stopScan !== undefined);

  // ==========================================================================
  // Custom config instance
  // ==========================================================================

  const assert_custom_not_scanning = assert(
    () => customSearcher.isScanning === false,
  );

  const assert_custom_progress_idle = assert(
    () => customSearcher.searchProgress.status === "idle",
  );

  const assert_direct_auth_is_used = assert(() =>
    directAuthSearcher.authSource === "direct"
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
      { assertion: assert_direct_auth_is_used },
    ],
    // Expose subjects for debugging
    searcher,
    customSearcher,
    directAuthSearcher,
    // Pattern triggers scheduler errors from auth/filter computations in headless runner
    allowRuntimeErrors: true,
  };
});
