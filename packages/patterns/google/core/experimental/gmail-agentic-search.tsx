/// <cts-enable />
/**
 * Gmail Agentic Search - Base Pattern
 *
 * A reusable base pattern for building Gmail-based agentic searchers.
 * Handles authentication, provides searchGmail tool, and manages agent execution.
 *
 * Usage:
 * ```typescript
 * import GmailAgenticSearch from "./gmail-agentic-search.tsx";
 *
 * export default pattern(({ customState }) => {
 *   const searcher = GmailAgenticSearch({
 *     agentGoal: "Find receipts from Amazon",
 *     suggestedQueries: ["from:amazon.com subject:receipt"],
 *     resultSchema: { type: "object", properties: { ... } },
 *   });
 *
 *   return {
 *     [NAME]: "My Searcher",
 *     [UI]: <div>{searcher}</div>,  // Embeds auth + scan UI
 *   };
 * });
 * ```
 */
import {
  Default,
  derive,
  generateObject,
  getRecipeEnvironment,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  wish,
  Writable,
} from "commontools";
import {
  type AccountType as _AccountType,
  createGoogleAuth as createGoogleAuthUtil,
  type ScopeKey,
} from "../util/google-auth-manager.tsx";
import GoogleAuth from "../google-auth.tsx";
import {
  GmailClient,
  validateAndRefreshTokenCrossPiece,
} from "../util/gmail-client.ts";
import GmailSearchRegistry from "./gmail-search-registry.tsx";
import type {
  GmailSearchRegistryOutput,
  SharedQuery,
} from "./gmail-search-registry.tsx";

// Re-export Auth type for convenience
export type { Auth } from "../gmail-importer.tsx";
import type { Auth } from "../gmail-importer.tsx";

const _env = getRecipeEnvironment();

// Debug flag for development - disable in production
const DEBUG_AGENT = false;

// ============================================================================
// TYPES
// ============================================================================

// Simplified Email type for the agent
export interface SimpleEmail {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body: string; // Plain text or markdown content
}

// Progress tracking
export interface SearchProgress {
  currentQuery: string;
  completedQueries: { query: string; emailCount: number; timestamp: number }[];
  status: "idle" | "searching" | "analyzing" | "limit_reached" | "auth_error";
  searchCount: number;
  authError?: string;
}

// Debug log entry for tracking agent activity
export interface DebugLogEntry {
  timestamp: number;
  type: "info" | "search_start" | "search_result" | "error" | "summary";
  message: string;
  details?: any;
}

// Type for the refresh token stream from google-auth
// NOTE: Stream.send() only takes 1 argument (the event), no onCommit callback
type RefreshStreamType = Stream<Record<string, never>>;

// Tool definition for additional tools
export interface ToolDefinition {
  description: string;
  handler: Stream<any>;
}

// ============================================================================
// LOCAL QUERY TRACKING TYPES
// ============================================================================

// A query saved locally by this agent instance
export interface LocalQuery {
  id: string; // Unique ID
  query: string; // The Gmail search string
  description?: string; // User's note about what it finds
  createdAt: number; // When first used
  lastUsed?: number; // Most recent use
  useCount: number; // Times used
  effectiveness: number; // 0-5 rating (0=unrated)
  shareStatus: "private" | "pending_review" | "submitted";
  foundItems?: number; // Count of target items found by this query (via custom tools)
}

// A community query with its ID for upvoting
interface CommunityQueryRef {
  id: string; // Query ID in the registry
  query: string; // The query string
}

// A query pending user review before community submission
export interface PendingSubmission {
  localQueryId: string; // Reference to LocalQuery
  originalQuery: string; // The original query
  sanitizedQuery: string; // After LLM PII removal / generalization
  piiWarnings: string[]; // What PII was detected/removed
  generalizabilityIssues: string[]; // Issues with generalizability
  recommendation: "share" | "share_with_edits" | "do_not_share" | "pending";
  userApproved: boolean; // Has user approved submission
  submittedAt?: number; // When submitted (if submitted)
}

// ============================================================================
// INPUT/OUTPUT TYPES
// ============================================================================

export interface GmailAgenticSearchInput {
  // Agent configuration - the main prompt/goal (can be reactive Cell)
  agentGoal?: Default<string, "">;

  // Additional system context
  systemPrompt?: Default<string, "">;

  // Suggested queries for the agent to try
  suggestedQueries?: Default<string[], []>;

  // JSON schema for agent's structured output
  resultSchema?: Default<object, Record<string, never>>;

  // Account type for multi-account support
  // "default" = any #googleAuth, "personal" = #googleAuthPersonal, "work" = #googleAuthWork
  accountType?: Default<"default" | "personal" | "work", "default">;

  // Additional tools beyond searchGmail
  additionalTools?: Default<
    Record<string, ToolDefinition>,
    Record<string, never>
  >;

  // UI customization
  title?: Default<string, "Gmail Agentic Search">;
  scanButtonLabel?: Default<string, "Scan">;

  // Limits
  maxSearches?: Default<number, 0>; // 0 = unlimited

  // State persistence
  isScanning?: Default<boolean, false>;
  lastScanAt?: Default<number, 0>;

  // Progress state - can be passed in for parent pattern coordination
  searchProgress?: Default<SearchProgress, {
    currentQuery: "";
    completedQueries: [];
    status: "idle";
    searchCount: 0;
  }>;

  // Debug log - tracks agent activity for debugging
  debugLog?: Default<DebugLogEntry[], []>;

  // WORKAROUND (CT-1085): Accept auth as direct input since favorites don't persist.
  // Users can manually link gmail-auth's auth output to this input.
  // If provided, this takes precedence over wish-based auth.
  auth?: Default<Auth, {
    token: "";
    tokenType: "";
    scope: [];
    expiresIn: 0;
    expiresAt: 0;
    refreshToken: "";
    user: { email: ""; name: ""; picture: "" };
  }>;

  // ========================================================================
  // SHARED SEARCH STRINGS SUPPORT
  // ========================================================================

  // GitHub raw URL to identify this agent type for community query sharing
  // Example: "https://raw.githubusercontent.com/anthropics/community-patterns/main/patterns/jkomoros/hotel-membership-gmail-agent.tsx"
  agentTypeUrl?: Default<string, "">;

  // Local queries saved by this agent instance
  localQueries?: Default<LocalQuery[], []>;

  // Queries pending user review before community submission
  pendingSubmissions?: Default<PendingSubmission[], []>;

  // Whether to fetch and use community queries (requires registry setup)
  enableCommunityQueries?: Default<boolean, true>;

  // When true, only show queries in "My Saved Queries" that have found target items
  // (via itemFoundSignal). Default false shows all queries that found emails.
  onlySaveQueriesWithItems?: Default<boolean, false>;

  // Optional signal cell for consuming patterns to indicate "found an item"
  // When this value increases, marks the most recent query as having found items
  // Create with Writable.of<number>(0) and pass in - both patterns share the same cell
  itemFoundSignal?: Default<number, 0>;
}

/** Reusable Gmail agentic search base pattern. #gmailAgenticSearch */
export interface GmailAgenticSearchOutput {
  // Pattern metadata
  [NAME]: string;
  [UI]: JSX.Element;

  // UI Pieces grouped for composition (like chatbot.tsx pattern)
  ui: {
    auth: JSX.Element; // Auth status and connect/login UI
    controls: JSX.Element; // Scan/Stop buttons
    progress: JSX.Element; // Search progress during scanning
    stats: JSX.Element; // Last scan timestamp
    extras: JSX.Element; // Combined: local queries + pending submissions + debug log
    debugLog: JSX.Element; // Just the debug log
    localQueries: JSX.Element; // Local queries management
    pendingSubmissions: JSX.Element; // Pending submissions for sharing
  };

  // Auth state (exposed for embedding patterns)
  auth: Auth;
  isAuthenticated: boolean;
  hasGmailScope: boolean;
  authSource: "direct" | "wish" | "none"; // Where auth came from

  // Agent state
  agentResult: any;
  agentPending: boolean;
  isScanning: boolean;

  // Progress
  searchProgress: SearchProgress;

  // Debug log
  debugLog: DebugLogEntry[];

  // Timestamps
  lastScanAt: number;

  // Actions (bound handlers for embedding patterns to use)
  startScan: Stream<unknown>;
  stopScan: Stream<unknown>;

  // ========================================================================
  // SHARED SEARCH STRINGS
  // ========================================================================

  // Local queries saved by this agent instance
  localQueries: LocalQuery[];

  // Queries pending user review before community submission
  pendingSubmissions: PendingSubmission[];

  // Actions for local query management (handler factories)
  rateQuery: ReturnType<typeof handler>; // Rate a query's effectiveness
  deleteLocalQuery: ReturnType<typeof handler>; // Delete a saved query

  // Cell that consuming patterns can increment to signal "found an item"
  // When this value increases, the base pattern marks the most recent query as having found items
  // Note: This is an input cell (Default<number, 0>) exposed for external access
  itemFoundSignal: number;
}

// ============================================================================
// NOTE: createReportTool HAS BEEN REMOVED
// ============================================================================
//
// The createReportTool factory function was removed because it passes functions
// as config, which won't work with future framework sandboxing.
//
// INSTEAD: Use inline handlers in your pattern. Example:
//
// ```typescript
// const reportHandler = handler<
//   { field1: string; field2: string; result?: Writable<any> },
//   { items: Writable<MyRecord[]> }
// >((input, state) => {
//   const currentItems = state.items.get() || [];
//
//   // Dedup logic INLINE (not passed as config function)
//   const dedupeKey = `${input.field1}:${input.field2}`.toLowerCase();
//   const existingKeys = new Set(currentItems.map(i => `${i.field1}:${i.field2}`.toLowerCase()));
//
//   if (!existingKeys.has(dedupeKey)) {
//     const id = `record-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
//     const newRecord = {
//       id,
//       field1: input.field1,
//       field2: input.field2,
//       // ... all transformation logic INLINE
//     };
//     state.items.set([...currentItems, newRecord]);
//   }
//
//   // Write to result cell if provided (for LLM tool response)
//   if (input.result) {
//     input.result.set({ success: true });
//   }
//   return { success: true };
// });
//
// // Use in additionalTools:
// additionalTools: {
//   reportItem: {
//     description: "Report a found item",
//     handler: reportHandler({ items: myItemsCell }),
//   },
// }
// ```
//
// See: community-docs/superstitions/2025-12-04-tool-handler-schemas-not-functions.md
// See: hotel-membership-gmail-agent.tsx and favorite-foods-gmail-agent.tsx for examples

// ============================================================================
// GMAIL UTILITIES
// ============================================================================

// GmailClient and validateGmailToken are now imported from ./util/gmail-client.ts
// This enables automatic token refresh on 401 errors.
//
// IMPORTANT: The auth cell must be writable for token refresh to work!
// See: community-docs/superstitions/2025-12-03-derive-creates-readonly-cells-use-property-access.md

// ============================================================================
// MODULE-SCOPE HANDLERS
// Handlers must be defined at module scope, not inside patterns.
// ============================================================================

// Handler to create a new GmailSearchRegistry piece
const createSearchRegistryHandler = handler<unknown, Record<string, never>>(
  () => {
    if (DEBUG_AGENT) {
      console.log("[GmailAgenticSearch] Creating new search registry piece");
    }
    const registryPiece = GmailSearchRegistry({
      queries: [],
    });
    return navigateTo(registryPiece);
  },
);

// Handler to change account type (writes to local writable cell)
const setAccountTypeHandler = handler<
  { target: { value: string } },
  { selectedType: Writable<"default" | "personal" | "work"> }
>((event, state) => {
  const newType = event.target.value as "default" | "personal" | "work";
  if (DEBUG_AGENT) {
    console.log("[GmailAgenticSearch] Account type changed to:", newType);
  }
  state.selectedType.set(newType);
});

// Handler to stop scan
const stopScanHandler = handler<
  unknown,
  {
    lastScanAt: Writable<Default<number, 0>>;
    isScanning: Writable<Default<boolean, false>>;
  }
>((_, state) => {
  state.lastScanAt.set(Temporal.Now.instant().epochMilliseconds);
  state.isScanning.set(false);
  if (DEBUG_AGENT) {
    console.log("[GmailAgenticSearch] Scan stopped");
  }
});

// Handler to complete scan
const completeScanHandler = handler<
  unknown,
  {
    lastScanAt: Writable<Default<number, 0>>;
    isScanning: Writable<Default<boolean, false>>;
  }
>((_, state) => {
  state.lastScanAt.set(Temporal.Now.instant().epochMilliseconds);
  state.isScanning.set(false);
  if (DEBUG_AGENT) {
    console.log("[GmailAgenticSearch] Scan completed");
  }
});

// Handler to toggle debug log expansion
const toggleDebugHandler = handler<unknown, { expanded: Writable<boolean> }>(
  (_, state) => {
    state.expanded.set(!state.expanded.get());
  },
);

// Handler to toggle pending submissions expansion
const togglePendingSubmissionsHandler = handler<
  unknown,
  { expanded: Writable<boolean> }
>((_, state) => {
  state.expanded.set(!state.expanded.get());
});

// Helper to add a debug log entry using push (proper array cell mutation)
// Moved to module scope so handlers can use it
const addDebugLogEntry = (
  logCell: Writable<DebugLogEntry[]>,
  entry: Omit<DebugLogEntry, "timestamp">,
) => {
  try {
    logCell.push({
      ...entry,
      timestamp: Temporal.Now.instant().epochMilliseconds,
    });
  } catch (err) {
    // Log to console but don't let debug logging errors crash the agent
    console.error("[GmailAgenticSearch] Debug log error:", err);
  }
};

// Handler for searching Gmail
const searchGmailHandler = handler<
  { query: string; result?: Writable<any> },
  {
    auth: Writable<Auth>;
    // Stream<T> in signature lets framework unwrap opaque stream from wished pieces
    authRefreshStream: RefreshStreamType | null;
    progress: Writable<SearchProgress>;
    maxSearches: Writable<Default<number, 0>>;
    debugLog: Writable<DebugLogEntry[]>;
    localQueries: Writable<LocalQuery[]>;
    communityQueryRefs: Writable<CommunityQueryRef[]>;
    registryWish: Writable<any>;
    agentTypeUrl: Writable<string>;
    lastExecutedQueryIdCell: Writable<string | null>;
  }
>(async (input, state) => {
  const authData = state.auth.get();
  const token = authData?.token as string;
  const max = state.maxSearches.get();
  const currentProgress = state.progress.get();

  // Log the search attempt
  addDebugLogEntry(state.debugLog, {
    type: "search_start",
    message: `Searching Gmail: "${input.query}"`,
    details: { query: input.query, searchCount: currentProgress.searchCount },
  });

  // Check if we've hit the search limit
  if (max > 0 && currentProgress.searchCount >= max) {
    if (DEBUG_AGENT) {
      console.log(`[SearchGmail Tool] Search limit reached (${max})`);
    }
    addDebugLogEntry(state.debugLog, {
      type: "info",
      message: `Search limit reached (${max})`,
    });
    const limitResult = {
      success: false,
      limitReached: true,
      message: `Search limit of ${max} reached.`,
      emails: [],
    };
    if (input.result) {
      input.result.set(limitResult);
    }
    state.progress.set({
      ...currentProgress,
      status: "limit_reached",
    });
    return limitResult;
  }

  // Don't continue if we're in auth error state
  if (currentProgress.status === "auth_error") {
    const authErrorResult = {
      success: false,
      authError: true,
      message: currentProgress.authError || "Authentication required",
      emails: [],
    };
    if (input.result) {
      input.result.set(authErrorResult);
    }
    return authErrorResult;
  }

  // Update progress: starting new search
  state.progress.set({
    ...currentProgress,
    currentQuery: input.query,
    status: "searching",
  });

  let resultData: any;

  if (!token) {
    addDebugLogEntry(state.debugLog, {
      type: "error",
      message: "Not authenticated - no token available",
    });
    resultData = { error: "Not authenticated", emails: [] };
  } else {
    try {
      if (DEBUG_AGENT) {
        console.log(`[SearchGmail Tool] Searching: ${input.query}`);
      }

      // Cross-piece token refresh via Stream<T> handler signature
      // The framework unwraps the opaque stream, giving us a callable .send()
      // See: community-docs/blessed/cross-piece.md
      const refreshStream = state.authRefreshStream;
      let onRefresh: (() => Promise<void>) | undefined = undefined;

      if (refreshStream?.send) {
        // Stream.send() supports optional onCommit callback (see labs/packages/runner/src/cell.ts)
        // The refresh happens in the auth piece's transaction context
        // Note: TypeScript types don't include onCommit, but runtime supports it
        onRefresh = async () => {
          if (DEBUG_AGENT) {
            console.log(
              "[SearchGmail Tool] Refreshing token via cross-piece stream...",
            );
          }
          await new Promise<void>((resolve, reject) => {
            // Cast to bypass TS types - runtime supports onCommit (verified in cell.ts:105-108)
            (refreshStream.send as (
              event: Record<string, never>,
              onCommit?: (tx: any) => void,
            ) => void)(
              {},
              (tx: any) => {
                // onCommit fires after the handler's transaction commits
                const status = tx?.status?.();
                if (status?.status === "error") {
                  console.error(
                    "[SearchGmail Tool] Token refresh failed:",
                    status.error,
                  );
                  reject(new Error(`Token refresh failed: ${status.error}`));
                } else {
                  if (DEBUG_AGENT) {
                    console.log(
                      "[SearchGmail Tool] Token refresh transaction committed",
                    );
                  }
                  resolve();
                }
              },
            );
          });
          if (DEBUG_AGENT) {
            console.log("[SearchGmail Tool] Token refresh completed");
          }
        };
      }

      // Use GmailClient with the auth cell and onRefresh callback
      const client = new GmailClient(state.auth, {
        debugMode: false,
        onRefresh,
      });
      const emails = await client.searchEmails(input.query, 30);

      if (DEBUG_AGENT) {
        console.log(`[SearchGmail Tool] Found ${emails.length} emails`);
      }

      // Log the search results
      addDebugLogEntry(state.debugLog, {
        type: "search_result",
        message: `Found ${emails.length} emails for "${input.query}"`,
        details: {
          emailCount: emails.length,
          subjects: emails.slice(0, 5).map((e) => e.subject),
        },
      });

      resultData = {
        success: true,
        emailCount: emails.length,
        emails: emails.map((e) => ({
          id: e.id,
          subject: e.subject,
          from: e.from,
          date: e.date,
          snippet: e.snippet,
          body: e.body,
        })),
      };

      // Update progress: search complete
      const updatedProgress = state.progress.get();
      state.progress.set({
        currentQuery: "",
        completedQueries: [
          ...updatedProgress.completedQueries,
          {
            query: input.query,
            emailCount: emails.length,
            timestamp: Temporal.Now.instant().epochMilliseconds,
          },
        ],
        status: "analyzing",
        searchCount: updatedProgress.searchCount + 1,
      });

      // Track query in localQueries for potential sharing
      const currentLocalQueries = state.localQueries.get() || [];
      const existingQueryIndex = currentLocalQueries.findIndex(
        (q) =>
          q && q.query && q.query.toLowerCase() === input.query.toLowerCase(),
      );

      if (existingQueryIndex >= 0) {
        // Update existing query using .key().key().set() for atomic updates
        const existing = currentLocalQueries[existingQueryIndex];
        const itemCell = state.localQueries.key(existingQueryIndex);
        itemCell.key("lastUsed").set(Temporal.Now.instant().epochMilliseconds);
        itemCell.key("useCount").set(existing.useCount + 1);
        // Auto-increase effectiveness if it found results (capped at 5)
        itemCell.key("effectiveness").set(
          emails.length > 0
            ? Math.min(5, existing.effectiveness + 1)
            : existing.effectiveness,
        );
        // Track this as the last executed query (for foundItems)
        state.lastExecutedQueryIdCell.set(existing.id);
      } else if (emails.length > 0) {
        // Only add new query if it found results
        const newQueryId = crypto.randomUUID();
        const newQuery: LocalQuery = {
          id: newQueryId,
          query: input.query,
          createdAt: Temporal.Now.instant().epochMilliseconds,
          lastUsed: Temporal.Now.instant().epochMilliseconds,
          useCount: 1,
          effectiveness: 1, // Start at 1 since it found results
          shareStatus: "private",
          foundItems: 0, // Initialize to 0, incremented when consuming pattern signals itemFoundSignal
        };
        state.localQueries.push(newQuery);
        // Track this as the last executed query (for foundItems)
        state.lastExecutedQueryIdCell.set(newQueryId);
      }

      // Auto-upvote community queries that found results
      if (emails.length > 0) {
        const communityRefs = state.communityQueryRefs.get() || [];
        const matchingCommunityQuery = communityRefs.find(
          (ref) =>
            ref && ref.query &&
            ref.query.toLowerCase() === input.query.toLowerCase(),
        );
        if (matchingCommunityQuery) {
          // Get the registry to call upvoteQuery
          const wishResult = state.registryWish.get();
          const registry = wishResult?.result;
          if (registry?.upvoteQuery) {
            const typeUrl = state.agentTypeUrl.get();
            if (DEBUG_AGENT) {
              console.log(
                `[SearchGmail] Upvoting community query: ${matchingCommunityQuery.query}`,
              );
            }
            addDebugLogEntry(state.debugLog, {
              type: "info",
              message:
                `Upvoting effective community query: "${matchingCommunityQuery.query}"`,
            });
            // Fire and forget the upvote
            try {
              registry.upvoteQuery({
                agentTypeUrl: typeUrl,
                queryId: matchingCommunityQuery.id,
              });
            } catch (upvoteErr) {
              console.error("[SearchGmail] Upvote failed:", upvoteErr);
            }
          }
        }
      }
    } catch (err) {
      console.error("[SearchGmail Tool] Error:", err);
      const errorStr = String(err);
      addDebugLogEntry(state.debugLog, {
        type: "error",
        message: `Search error: ${errorStr}`,
      });
      resultData = { error: errorStr, emails: [] };

      // Note: With GmailClient, 401 errors should automatically trigger
      // token refresh. If we still get here with a 401, the refresh failed
      // (possibly because auth cell is derived/read-only, or no refresh token)
      if (errorStr.includes("401")) {
        const updatedProgress = state.progress.get();
        state.progress.set({
          ...updatedProgress,
          status: "auth_error",
          authError:
            "Gmail token expired and refresh failed. Please re-authenticate.",
        });
      }
    }
  }

  // Write to the result cell if provided
  if (input.result) {
    input.result.set(resultData);
  }

  return resultData;
});

// Handler to start scan
const startScanHandler = handler<
  unknown,
  {
    isScanning: Writable<Default<boolean, false>>;
    isAuthenticated: Writable<boolean>;
    progress: Writable<SearchProgress>;
    auth: Writable<Auth>;
    debugLog: Writable<DebugLogEntry[]>;
    // Stream<T> in signature lets framework unwrap opaque stream from wished pieces
    authRefreshStream: RefreshStreamType | null;
  }
>(async (_, state) => {
  if (!state.isAuthenticated.get()) return;

  const authData = state.auth.get();

  // Clear debug log and add scan start entry
  state.debugLog.set([]);
  addDebugLogEntry(state.debugLog, {
    type: "info",
    message: "Starting new scan...",
    details: { email: authData?.user?.email },
  });

  // Validate token before starting scan
  // Cross-piece refresh works via Stream<T> handler signature pattern
  // See: community-docs/blessed/cross-piece.md
  if (DEBUG_AGENT) {
    console.log("[GmailAgenticSearch] Validating token before scan...");
  }
  addDebugLogEntry(state.debugLog, {
    type: "info",
    message: "Validating Gmail token...",
  });

  // Stream<T> in handler signature gives us callable .send()
  const refreshStream = state.authRefreshStream;

  const validation = await validateAndRefreshTokenCrossPiece(
    state.auth,
    refreshStream,
    true,
  );

  if (!validation.valid) {
    if (DEBUG_AGENT) {
      console.log(
        `[GmailAgenticSearch] Token validation failed: ${validation.error}`,
      );
    }
    addDebugLogEntry(state.debugLog, {
      type: "error",
      message: `Token validation failed: ${validation.error}`,
    });
    state.progress.set({
      currentQuery: "",
      completedQueries: [],
      status: "auth_error",
      searchCount: 0,
      authError: validation.error,
    });
    return;
  }

  if (validation.refreshed) {
    if (DEBUG_AGENT) {
      console.log("[GmailAgenticSearch] Token was refreshed automatically");
    }
    addDebugLogEntry(state.debugLog, {
      type: "info",
      message: "Token was expired - refreshed automatically",
    });
  }

  if (DEBUG_AGENT) {
    console.log("[GmailAgenticSearch] Token valid, starting scan");
  }
  addDebugLogEntry(state.debugLog, {
    type: "info",
    message: "Token valid - starting agent...",
  });
  state.progress.set({
    currentQuery: "",
    completedQueries: [],
    status: "searching",
    searchCount: 0,
  });
  state.isScanning.set(true);
});

// Handler to rate a query's effectiveness
const rateQueryHandler = handler<
  unknown,
  { queryId: string; rating: number; localQueries: Writable<LocalQuery[]> }
>((_, state) => {
  const queries = state.localQueries.get() || [];
  const index = queries.findIndex((q) => q.id === state.queryId);
  if (index >= 0) {
    state.localQueries.key(index).key("effectiveness").set(state.rating);
  }
});

// Handler to delete a local query (also removes from pending submissions)
const deleteLocalQueryHandler = handler<
  unknown,
  {
    queryId: string;
    localQueries: Writable<LocalQuery[]>;
    pendingSubmissions: Writable<PendingSubmission[]>;
  }
>((_, state) => {
  const queries = state.localQueries.get() || [];
  state.localQueries.set(queries.filter((q) => q.id !== state.queryId));
  // Also remove from pending if exists
  const pending = state.pendingSubmissions.get() || [];
  state.pendingSubmissions.set(
    pending.filter((p) => p.localQueryId !== state.queryId),
  );
});

// Handler to flag a query for sharing (adds to pending submissions)
const flagForShareHandler = handler<
  unknown,
  {
    queryId: string;
    localQueries: Writable<LocalQuery[]>;
    pendingSubmissions: Writable<PendingSubmission[]>;
  }
>((_, state) => {
  // Read both cells upfront
  const queries = state.localQueries.get() || [];
  const pending = state.pendingSubmissions.get() || [];

  const qry = queries.find((q) => q.id === state.queryId);
  if (!qry) return;

  // Check if already pending
  if (pending.some((p) => p.localQueryId === state.queryId)) return;

  // Update localQueries FIRST (mark as pending_review)
  const idx = queries.findIndex((q) => q.id === state.queryId);
  if (idx >= 0) {
    state.localQueries.key(idx).key("shareStatus").set("pending_review");
  }

  // Then add to pendingSubmissions
  const newPending: PendingSubmission = {
    localQueryId: state.queryId,
    originalQuery: qry.query,
    sanitizedQuery: qry.query,
    piiWarnings: [],
    generalizabilityIssues: [],
    recommendation: "pending",
    userApproved: false,
  };
  state.pendingSubmissions.push(newPending);
});

// Handler to flag a query for sharing (runs PII screening)
// Prefixed with _ as not currently used in pattern body - preserved for future use
const _flagQueryForSharingHandler = handler<
  { queryId: string },
  {
    localQueries: Writable<LocalQuery[]>;
    pendingSubmissions: Writable<PendingSubmission[]>;
  }
>((input, state) => {
  const queries = state.localQueries.get() || [];
  const query = queries.find((q) => q.id === input.queryId);
  if (!query) return;

  // Check if already pending
  const pending = state.pendingSubmissions.get() || [];
  if (pending.some((p) => p.localQueryId === input.queryId)) return;

  // Create pending submission (PII screening happens via generateObject below)
  const newPending: PendingSubmission = {
    localQueryId: input.queryId,
    originalQuery: query.query,
    sanitizedQuery: query.query, // Will be updated by screening
    piiWarnings: [],
    generalizabilityIssues: [],
    recommendation: "pending",
    userApproved: false,
  };

  state.pendingSubmissions.push(newPending);

  // Update the local query status
  const idx = queries.findIndex((q) => q.id === input.queryId);
  if (idx >= 0) {
    state.localQueries.key(idx).key("shareStatus").set("pending_review");
  }
});

// Handler to approve a pending submission
// Prefixed with _ as not currently used in pattern body - preserved for future use
const _approvePendingSubmissionHandler = handler<
  { localQueryId: string },
  { pendingSubmissions: Writable<PendingSubmission[]> }
>((input, state) => {
  const submissions = state.pendingSubmissions.get() || [];
  const idx = submissions.findIndex((s) =>
    s.localQueryId === input.localQueryId
  );
  if (idx >= 0) {
    state.pendingSubmissions.key(idx).key("userApproved").set(true);
  }
});

// Handler to reject/cancel a pending submission
// Prefixed with _ as not currently used in pattern body - preserved for future use
const _rejectPendingSubmissionHandler = handler<
  { localQueryId: string },
  {
    pendingSubmissions: Writable<PendingSubmission[]>;
    localQueries: Writable<LocalQuery[]>;
  }
>((input, state) => {
  // Remove from pending
  const submissions = state.pendingSubmissions.get() || [];
  state.pendingSubmissions.set(
    submissions.filter((s) => s.localQueryId !== input.localQueryId),
  );

  // Reset local query status to private
  const queries = state.localQueries.get() || [];
  const idx = queries.findIndex((q) => q.id === input.localQueryId);
  if (idx >= 0) {
    state.localQueries.key(idx).key("shareStatus").set("private");
  }
});

// Handler to update the sanitized query manually
// Prefixed with _ as not currently used in pattern body - preserved for future use
const _updateSanitizedQueryHandler = handler<
  { localQueryId: string; sanitizedQuery: string },
  { pendingSubmissions: Writable<PendingSubmission[]> }
>((input, state) => {
  const submissions = state.pendingSubmissions.get() || [];
  const idx = submissions.findIndex((s) =>
    s.localQueryId === input.localQueryId
  );
  if (idx >= 0) {
    state.pendingSubmissions.key(idx).key("sanitizedQuery").set(
      input.sanitizedQuery,
    );
  }
});

// Handler to create a new GoogleAuth piece (module scope)
const createGoogleAuthHandler = handler(() => {
  const authPiece = GoogleAuth({
    selectedScopes: {
      gmail: true,
      gmailSend: false,
      gmailModify: false,
      calendar: false,
      calendarWrite: false,
      drive: false,
      docs: false,
      contacts: false,
    },
    auth: {
      token: "",
      tokenType: "",
      scope: [],
      expiresIn: 0,
      expiresAt: 0,
      refreshToken: "",
      user: { email: "", name: "", picture: "" },
    },
  });
  return navigateTo(authPiece);
});

// ============================================================================
// PATTERN
// ============================================================================

const GmailAgenticSearch = pattern<
  GmailAgenticSearchInput,
  GmailAgenticSearchOutput
>(
  ({
    agentGoal,
    systemPrompt,
    suggestedQueries,
    resultSchema,
    additionalTools,
    title,
    scanButtonLabel,
    maxSearches,
    isScanning,
    lastScanAt,
    searchProgress, // Can be passed in for parent coordination
    debugLog, // Debug log for tracking agent activity
    auth: inputAuth, // CT-1085 workaround: direct auth input
    accountType: _accountType, // Multi-account support: "default" | "personal" | "work" (prefixed with _ as read-only input, using selectedAccountType instead)
    // Shared search strings support
    agentTypeUrl,
    localQueries: localQueriesInput, // Renamed: input may be read-only
    pendingSubmissions: pendingSubmissionsInput, // Renamed: input may be read-only
    enableCommunityQueries,
    onlySaveQueriesWithItems, // When true, only show queries that found target items
    itemFoundSignal: itemFoundSignalInput, // Optional signal cell from consuming pattern
  }) => {
    // ========================================================================
    // AUTH HANDLING
    // ========================================================================

    // Check if we have direct auth input (CT-1085 workaround)
    const hasDirectAuth = derive(inputAuth, (a: Auth) => !!(a?.token));

    // Local writable cell for account type selection
    // Input `accountType` may be read-only (Default cells are read-only when using default value)
    // See: community-docs/superstitions/2025-12-03-derive-creates-readonly-cells-use-property-access.md
    // See: community-docs/folk_wisdom/thinking-reactively-vs-events.md ("Local Cells for Component Output")
    const selectedAccountType = Writable.of<"default" | "personal" | "work">(
      "default",
    );

    // ========================================================================
    // LOCAL QUERY STATE
    // ========================================================================
    // Use input cells directly - Default<> types handle writability and defaults.
    // Cannot call .get() on input cells at build time (causes "space is required" error).
    // Input cells from Default<T[], D> are OpaqueCell types that have writable methods at runtime.
    // Use 'any' to avoid double-casting (as unknown as) which is disallowed by the compiler.
    // See: patterns/jkomoros/util/agentic-tools.ts for similar pattern
    const localQueries: any = localQueriesInput;
    const pendingSubmissions: any = pendingSubmissionsInput;

    // ========================================================================
    // QUERY TRACKING (for foundItems feature)
    // ========================================================================
    // Use the input signal cell directly - Default<number, 0> provides the default
    // This follows the "share cells by making them inputs" pattern
    // See: community-docs/superstitions/2025-12-04-share-cells-between-composed-patterns.md
    const itemFoundSignal = itemFoundSignalInput;
    // Track last signal value in a Cell (closure vars don't persist in derive)
    const lastSignalValueCell = Writable.of<number>(0);
    // Track last executed query ID in a Cell (so derive can access it)
    const lastExecutedQueryIdCell = Writable.of<string | null>(null);
    // Track foundItems counts separately from localQueries
    // Local cells work correctly in derives (no closure issues with input cells)
    // See: community-docs/superstitions/2025-12-08-locally-created-cells-not-unwrapped-in-derive.md
    const foundItemsTracker = Writable.of<Record<string, number>>({});

    // Watch the signal and update foundItemsTracker when it increases
    derive(
      [itemFoundSignal, lastSignalValueCell, lastExecutedQueryIdCell],
      (
        [signalValue, lastSignalValue, queryId]: [
          number,
          number,
          string | null,
        ],
      ) => {
        // Use the unwrapped values from derive directly
        const signalVal = signalValue || 0;
        const lastSignalVal = lastSignalValue || 0;

        if (DEBUG_AGENT) {
          console.log(
            `[GmailAgenticSearch] itemFoundSignal derive triggered: signalValue=${signalVal}, lastSignalValue=${lastSignalVal}, queryId=${queryId}`,
          );
        }

        if (signalVal > lastSignalVal) {
          if (queryId) {
            const tracker = foundItemsTracker.get() || {};
            const currentCount = tracker[queryId] || 0;
            const newCount = currentCount + 1;

            foundItemsTracker.set({
              ...tracker,
              [queryId]: newCount,
            });

            if (DEBUG_AGENT) {
              console.log(
                `[GmailAgenticSearch] Marked query ${queryId} as found item (now ${newCount})`,
              );
            }
          } else {
            if (DEBUG_AGENT) {
              console.warn(
                "[GmailAgenticSearch] itemFoundSignal increased but no recent query to mark",
              );
            }
          }
          lastSignalValueCell.set(signalVal);
        }
      },
    );

    // Merge localQueries with foundItems from the tracker for display
    const localQueriesWithFoundItems = derive(
      [localQueries, foundItemsTracker],
      ([queries, tracker]: [LocalQuery[], Record<string, number>]) => {
        return (queries || []).map((q) => {
          if (!q || !q.id) return q;
          const trackedCount = tracker[q.id] || 0;
          return { ...q, foundItems: trackedCount };
        });
      },
    );

    // Use createGoogleAuth utility for wish-based auth (when not using direct auth)
    // Passes reactive selectedAccountType for dynamic account switching
    const {
      auth: wishedAuth,
      authInfo,
      fullUI: authFullUI,
      isReady: wishedAuthReady,
      currentEmail: _wishedEmail, // Prefixed with _ as not currently used directly
    } = createGoogleAuthUtil({
      requiredScopes: ["gmail"] as ScopeKey[],
      accountType: selectedAccountType,
    });

    // For compatibility with existing code - derive piece from authInfo
    const wishedAuthPiece = derive(
      authInfo,
      (info: any) => info?.piece || null,
    );
    const hasWishedAuth = wishedAuthReady;

    // Access auth via property path to maintain writability
    // When hasDirectAuth is true, we use inputAuth directly (it's already an Auth cell)
    // When hasDirectAuth is false, we use wishedAuth from the utility
    // NOTE: This means inputAuth must be passed as a live cell reference, not derived.
    // See: community-docs/superstitions/2025-12-03-derive-creates-readonly-cells-use-property-access.md
    const auth = ifElse(
      hasDirectAuth,
      inputAuth,
      wishedAuth,
    );

    // ========================================================================
    // CROSS-CHARM TOKEN REFRESH
    // ========================================================================
    // The google-auth piece exports a `refreshToken` Stream that allows
    // other pieces to trigger token refresh in google-auth's transaction context.
    //
    // KEY INSIGHT (from Berni, verified 2024-12-10):
    // - Streams from wished pieces appear as opaque objects with `$stream` marker at derive time
    // - To call .send(), you must pass the stream to a handler with `Stream<T>` in its type signature
    // - The framework "unwraps" the opaque stream into a callable one inside the handler
    //
    // PATTERN:
    // 1. Extract stream via derive (will be opaque)
    // 2. Pass to handler with Stream<T> declared in signature
    // 3. Call .send() inside handler
    //
    // See: community-docs/blessed/cross-piece.md
    // See: patterns/jkomoros/issues/ISSUE-Token-Refresh-Blocked-By-Storage-Transaction.md
    //
    // Extract refresh stream from wished piece (will be opaque at derive time)
    const authRefreshStream = derive(
      wishedAuthPiece,
      (piece: any) => piece?.refreshToken || null,
    );

    // Track where auth came from
    const authSource = derive(
      [hasDirectAuth, hasWishedAuth],
      ([direct, wished]: [boolean, boolean]): "direct" | "wish" | "none" =>
        direct ? "direct" : wished ? "wish" : "none",
    );

    const isAuthenticated = derive(
      auth,
      (a: Auth) => !!(a && a.token && a.user && a.user.email),
    );

    // Check if token may be expired based on expiresAt timestamp
    const tokenMayBeExpired = derive(auth, (a: Auth) => {
      if (!a?.expiresAt) return false;
      // Add 5 minute buffer - if within 5 min of expiry, consider it potentially expired
      const bufferMs = 5 * 60 * 1000;
      return Temporal.Now.instant().epochMilliseconds >
        (a.expiresAt - bufferMs);
    });

    // Gmail scope URL for checking
    const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

    const hasGmailScope = derive(auth, (a: Auth) => {
      const scopes = a?.scope || [];
      return scopes.includes(GMAIL_SCOPE);
    });

    // Note: Scope warnings are handled by authFullUI via createGoogleAuth utility

    // Use module-scope handler for creating GoogleAuth
    const createGoogleAuth = createGoogleAuthHandler;

    // Use module-scope handlers
    const createSearchRegistry = createSearchRegistryHandler;
    // Pre-bind handler with required state - bound handlers work in JSX but not in derive callbacks
    const boundSetAccountType = setAccountTypeHandler({
      selectedType: selectedAccountType,
    });

    // ========================================================================
    // PROGRESS TRACKING
    // ========================================================================
    // searchProgress comes from input - allows parent patterns to coordinate state
    // by passing in their own cell

    // ========================================================================
    // COMMUNITY REGISTRY DISCOVERY
    // ========================================================================

    // Wish for the community registry (tagged #gmailSearchRegistry)
    // NOTE: wish() must be called outside derive() to avoid infinite loops
    // See: community-docs/superstitions/2025-12-06-wish-inside-derive-causes-infinite-loop.md
    const registryWish = wish<GmailSearchRegistryOutput>({
      query: "#gmailSearchRegistry",
    });

    // Extract community queries for this agent type (with IDs for upvoting)
    // Conditional enablement is handled here, not in the wish call
    const communityQueryRefs = derive(
      [registryWish, agentTypeUrl, enableCommunityQueries],
      (
        [wishResult, typeUrl, enabled]: [any, string, boolean],
      ): CommunityQueryRef[] => {
        // Guard: skip if community queries disabled or no agent type URL
        if (!enabled || !typeUrl) return [];
        if (!wishResult?.result) return [];
        // wishResult.result is a Cell reference, use .key() for dynamic access
        const registryCell = wishResult.result;
        const registriesCell = registryCell?.key?.("registries");
        if (!registriesCell) return [];
        const agentRegistry = registriesCell.key(typeUrl)?.get?.();
        if (!agentRegistry) return [];
        // Return top queries sorted by score, keeping IDs for upvoting
        return [...(agentRegistry.queries || [])]
          .sort((a: SharedQuery, b: SharedQuery) =>
            (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes)
          )
          .slice(0, 10)
          .map((q: SharedQuery) => ({ id: q.id, query: q.query }));
      },
    );

    // Just the query strings for combining with other suggestions
    const communityQueries = derive(
      communityQueryRefs,
      (refs: CommunityQueryRef[]) => refs.map((r) => r.query),
    );

    // Combine all suggested queries: local effective + community + pattern-defined
    const allSuggestedQueries = derive(
      [suggestedQueries, localQueries, communityQueries],
      ([suggested, local, community]: [string[], LocalQuery[], string[]]) => {
        const effectiveLocal = (local || [])
          .filter((q) => q && q.effectiveness >= 3)
          .map((q) => q.query);
        // Deduplicate and combine: pattern-defined first, then community, then local
        const all = new Set<string>();
        (suggested || []).forEach((q) => all.add(q));
        (community || []).forEach((q) => all.add(q));
        effectiveLocal.forEach((q) => all.add(q));
        return Array.from(all);
      },
    );

    // ========================================================================
    // AGENT SETUP
    // ========================================================================

    // Build the full prompt with suggested queries
    const fullPrompt = derive(
      [agentGoal, suggestedQueries, maxSearches],
      ([goal, queries, max]: [string, string[], number]) => {
        if (!goal) return ""; // Don't run agent without a goal

        let prompt = goal;

        if (queries && queries.length > 0) {
          prompt += `\n\nSuggested queries to try:\n`;
          prompt += queries.map((q, i) => `${i + 1}. ${q}`).join("\n");
        }

        if (max > 0) {
          prompt +=
            `\n\n⚠️ LIMITED TO ${max} SEARCHES. Focus on high-value queries!`;
        }

        return prompt;
      },
    );

    // Build agent prompt (only active when scanning)
    const agentPrompt = derive(
      [isScanning, fullPrompt],
      ([scanning, prompt]: [boolean, string]) => {
        if (!scanning) return ""; // Don't run unless scanning
        return prompt;
      },
    );

    // Merge searchGmail with additional tools
    const allTools = derive(
      additionalTools,
      (additional: Record<string, ToolDefinition>) => {
        const baseTools = {
          searchGmail: {
            description:
              "Search Gmail with a query and return matching emails. Returns email id, subject, from, date, snippet, and body text.",
            handler: searchGmailHandler({
              auth,
              authRefreshStream,
              progress: searchProgress,
              maxSearches,
              debugLog,
              localQueries,
              communityQueryRefs,
              registryWish,
              agentTypeUrl,
              lastExecutedQueryIdCell,
            }),
          },
        };

        // Merge additional tools if provided
        if (additional && typeof additional === "object") {
          return { ...baseTools, ...additional };
        }
        return baseTools;
      },
    );

    // Default system prompt - includes suggested queries from all sources
    const fullSystemPrompt = derive(
      [systemPrompt, allSuggestedQueries],
      ([custom, suggested]: [string, string[]]) => {
        const base =
          `You are a Gmail search agent. Your job is to search through emails to find relevant information.

You have the searchGmail tool available. Use it to search Gmail with queries like:
- from:domain.com
- subject:"keyword"
- has:attachment
- after:2024/01/01

IMPORTANT - WHEN TO STOP SEARCHING:
- After you've searched each relevant category/source 1-2 times with good queries
- When searches start returning the same emails you've already seen
- When you've found what you're looking for (or confirmed it doesn't exist)
- DO NOT keep trying slight variations of the same query
- DO NOT search indefinitely - make a decision and produce your final result

When you're done searching, STOP calling tools and produce your final structured output.`;

        // Add suggested queries if available
        let prompt = base;
        if (suggested && suggested.length > 0) {
          prompt +=
            `\n\nSuggested queries to try (from pattern config and community):\n${
              suggested.map((q) => `- ${q}`).join("\n")
            }`;
        }

        if (custom) {
          prompt += `\n\n${custom}`;
        }
        return prompt;
      },
    );

    // Create the agent
    const agent = generateObject({
      system: fullSystemPrompt,
      prompt: agentPrompt,
      tools: allTools,
      model: "anthropic:claude-sonnet-4-5",
      schema: derive(resultSchema, (schema: object) => {
        if (schema && Object.keys(schema).length > 0) {
          return schema;
        }
        // Default schema if none provided
        return {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "Summary of what was searched and found",
            },
            searchesPerformed: { type: "number" },
          },
          required: ["summary"],
        };
      }),
    });

    const { result: agentResult, pending: agentPending } = agent;

    // Detect when agent completes
    const scanCompleted = derive(
      [isScanning, agentPending, agentResult],
      ([scanning, pending, result]: [boolean, boolean, any]) =>
        scanning && !pending && !!result,
    );

    // Detect auth errors from agent result or token validation
    const hasAuthError = derive(
      [agentResult, searchProgress],
      ([r, progress]: [any, SearchProgress]) => {
        // Check progress status first (from token validation)
        if (progress?.status === "auth_error") {
          return true;
        }
        // Check agent result
        const summary = r?.summary || "";
        return (
          summary.includes("401") ||
          summary.toLowerCase().includes("authentication error")
        );
      },
    );

    // Get the specific auth error message
    const authErrorMessage = derive(
      [searchProgress, agentResult],
      ([progress, result]: [SearchProgress, any]) => {
        if (progress?.authError) {
          return progress.authError;
        }
        const summary = result?.summary || "";
        if (summary.includes("401")) {
          return "Token expired. Please re-authenticate.";
        }
        if (summary.toLowerCase().includes("authentication error")) {
          return "Authentication error. Please re-authenticate.";
        }
        return "";
      },
    );

    // Pre-bind handlers (important: must be done outside of derive callbacks)
    // Use module-scope handlers (startScanHandler, stopScanHandler, completeScanHandler)
    const boundStartScan = startScanHandler({
      isScanning,
      isAuthenticated,
      progress: searchProgress,
      auth,
      debugLog,
      authRefreshStream,
    });
    const boundStopScan = stopScanHandler({ lastScanAt, isScanning });
    const boundCompleteScan = completeScanHandler({ lastScanAt, isScanning });

    // Track if debug log is expanded (local UI state)
    const debugExpanded = Writable.of(false);

    // ========================================================================
    // UI PIECES (extracted for flexible composition)
    // ========================================================================

    // Account type selector - built OUTSIDE derive so handler works
    // Handlers don't work inside derive() callbacks
    const accountTypeSelector = (
      <div
        style={{
          marginBottom: "12px",
          padding: "8px 12px",
          background: "#f8fafc",
          borderRadius: "6px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "13px",
        }}
      >
        <span style={{ color: "#64748b" }}>Account:</span>
        <select
          onChange={boundSetAccountType}
          style={{
            padding: "4px 8px",
            borderRadius: "4px",
            border: "1px solid #e2e8f0",
            background: "white",
            fontSize: "13px",
            cursor: "pointer",
          }}
        >
          <option
            value="default"
            selected={derive(
              selectedAccountType,
              (t: string) => t === "default",
            )}
          >
            Any Google Account
          </option>
          <option
            value="personal"
            selected={derive(
              selectedAccountType,
              (t: string) => t === "personal",
            )}
          >
            Personal Account
          </option>
          <option
            value="work"
            selected={derive(selectedAccountType, (t: string) => t === "work")}
          >
            Work Account
          </option>
        </select>
        {derive(selectedAccountType, (type: string) =>
          type !== "default"
            ? (
              <span style={{ color: "#94a3b8", fontSize: "11px" }}>
                (using #{type === "personal"
                  ? "googleAuthPersonal"
                  : "googleAuthWork"})
              </span>
            )
            : null)}
      </div>
    );

    // Auth UI - shows auth status, login buttons, or connect Gmail prompt
    const authUI = (
      <div>
        {/* Account Type Selector (only shown if not using direct auth) */}
        {ifElse(hasDirectAuth, null, accountTypeSelector)}

        {/* Auth Status - use nested ifElse to avoid Cell-in-Cell problem */}
        {
          /* Only show custom error UIs for specific warning states;
            authFullUI handles everything else (not-auth, selecting, ready) */
        }
        {ifElse(
          // Show custom error UI only when authenticated AND has API error
          derive(
            [isAuthenticated, hasAuthError],
            ([auth, err]: [boolean, boolean]) => auth && err,
          ),
          // Auth error state - custom warning UI
          <div
            style={{
              padding: "12px",
              background: "#fef3c7",
              border: "1px solid #fde68a",
              borderRadius: "8px",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                color: "#92400e",
                textAlign: "center",
                marginBottom: "8px",
              }}
            >
              ⚠️ {authErrorMessage}
            </div>
            <div style={{ textAlign: "center" }}>
              {derive(wishedAuthPiece, (piece: any) =>
                piece
                  ? (
                    <ct-button
                      onClick={() => navigateTo(piece)}
                      size="sm"
                      variant="secondary"
                    >
                      Re-authenticate Gmail
                    </ct-button>
                  )
                  : (
                    <ct-button
                      onClick={createGoogleAuth}
                      size="sm"
                      variant="secondary"
                    >
                      Connect Gmail
                    </ct-button>
                  ))}
            </div>
          </div>,
          // No auth error - check for token expiry warning
          ifElse(
            // Show expiry warning only when authenticated AND token may be expired
            derive(
              [isAuthenticated, tokenMayBeExpired],
              ([auth, exp]: [boolean, boolean]) => auth && exp,
            ),
            // Token expiry warning - custom warning UI
            <div
              style={{
                padding: "12px",
                background: "#fef3c7",
                border: "1px solid #fde68a",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "14px",
                  color: "#92400e",
                  textAlign: "center",
                  marginBottom: "8px",
                }}
              >
                ⚠️ Gmail token may have expired - will verify on scan
              </div>
              <div style={{ textAlign: "center" }}>
                {derive(wishedAuthPiece, (piece: any) =>
                  piece
                    ? (
                      <ct-button
                        onClick={() => navigateTo(piece)}
                        size="sm"
                        variant="secondary"
                      >
                        Re-authenticate Gmail
                      </ct-button>
                    )
                    : null)}
              </div>
            </div>,
            // All other cases: use authFullUI directly
            // - Not authenticated → shows onboarding/picker UI
            // - Authenticated success → shows user chip with avatar, email, Switch/Add buttons
            authFullUI,
          ),
        )}
      </div>
    );

    // Check if agentGoal is empty (pattern not configured for a specific task)
    const hasAgentGoal = derive(
      agentGoal,
      (goal: string) => !!(goal && goal.trim()),
    );

    // Controls UI - scan and stop buttons
    const controlsUI = (
      <div>
        {/* Warning when no agent goal is set */}
        {derive(
          [isAuthenticated, hasAgentGoal],
          ([authenticated, hasGoal]: [boolean, boolean]) =>
            authenticated && !hasGoal
              ? (
                <div
                  style={{
                    padding: "16px",
                    background: "#fef3c7",
                    border: "1px solid #fde68a",
                    borderRadius: "8px",
                    marginBottom: "12px",
                  }}
                >
                  <div
                    style={{
                      fontWeight: "600",
                      color: "#92400e",
                      marginBottom: "8px",
                      fontSize: "14px",
                    }}
                  >
                    ⚠️ No Search Goal Configured
                  </div>
                  <div style={{ fontSize: "13px", color: "#78350f" }}>
                    This is the base Gmail Agentic Search pattern. To use it,
                    you need to either:
                  </div>
                  <ul
                    style={{
                      margin: "8px 0 0 0",
                      paddingLeft: "20px",
                      fontSize: "12px",
                      color: "#78350f",
                    }}
                  >
                    <li>
                      Use a specialized pattern (like Hotel Membership
                      Extractor) that has a built-in goal
                    </li>
                    <li>
                      Pass an <code>agentGoal</code>{" "}
                      input when embedding this pattern
                    </li>
                  </ul>
                  <div
                    style={{
                      marginTop: "12px",
                      fontSize: "11px",
                      color: "#92400e",
                    }}
                  >
                    The agent won't run without a search goal.
                  </div>
                </div>
              )
              : null,
        )}

        {/* Scan Button */}
        {ifElse(
          isAuthenticated,
          <ct-button
            onClick={boundStartScan}
            size="lg"
            style="width: 100%;"
            disabled={derive(
              [isScanning, hasAgentGoal],
              ([scanning, hasGoal]: [boolean, boolean]) => scanning || !hasGoal,
            )}
          >
            {derive(
              [isScanning, hasAgentGoal],
              ([scanning, hasGoal]: [boolean, boolean]) =>
                scanning
                  ? "⏳ Scanning..."
                  : hasGoal
                  ? scanButtonLabel
                  : "⚠️ No Goal Set",
            )}
          </ct-button>,
          null,
        )}

        {/* Stop Button */}
        {ifElse(
          isScanning,
          <ct-button
            onClick={boundStopScan}
            variant="secondary"
            size="lg"
            style="width: 100%; margin-top: 8px;"
          >
            ⏹ Stop Scan
          </ct-button>,
          null,
        )}
      </div>
    );

    // Progress UI - shows search progress and completion
    // Note: We use searchProgress.status instead of agentPending because agentPending
    // is false during tool execution (only true during initial prompt processing)
    const progressUI = (
      <div>
        {/* Progress during scanning - hide when scan is complete */}
        {ifElse(
          scanCompleted,
          null,
          derive(
            [isScanning, searchProgress],
            ([scanning, progress]: [boolean, SearchProgress]) =>
              scanning && progress.status !== "idle" &&
                progress.status !== "auth_error"
                ? (
                  <div
                    style={{
                      padding: "16px",
                      background: "#f8fafc",
                      border: "1px solid #e2e8f0",
                      borderRadius: "8px",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: "600",
                        marginBottom: "12px",
                        textAlign: "center",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "12px",
                        color: "#475569",
                      }}
                    >
                      <ct-loader show-elapsed></ct-loader>
                      Scanning emails...
                    </div>

                    {/* Current Activity */}
                    {derive(searchProgress, (progress: SearchProgress) =>
                      progress.currentQuery
                        ? (
                          <div
                            style={{
                              padding: "8px",
                              background: "#f1f5f9",
                              borderRadius: "4px",
                              marginBottom: "12px",
                            }}
                          >
                            <div
                              style={{
                                fontSize: "12px",
                                color: "#475569",
                                fontWeight: "600",
                              }}
                            >
                              🔍 Currently searching:
                            </div>
                            <div
                              style={{
                                fontSize: "13px",
                                color: "#334155",
                                fontFamily: "monospace",
                                wordBreak: "break-all",
                              }}
                            >
                              {progress.currentQuery}
                            </div>
                          </div>
                        )
                        : (
                          <div
                            style={{
                              padding: "8px",
                              background: "#f1f5f9",
                              borderRadius: "4px",
                              marginBottom: "12px",
                            }}
                          >
                            <div
                              style={{
                                fontSize: "12px",
                                color: "#475569",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <ct-loader size="sm"></ct-loader>
                              Analyzing emails...
                            </div>
                          </div>
                        ))}

                    {/* Completed Searches */}
                    {derive(searchProgress, (progress: SearchProgress) =>
                      progress.completedQueries.length > 0
                        ? (
                          <div style={{ marginTop: "8px" }}>
                            <div
                              style={{
                                fontSize: "12px",
                                color: "#475569",
                                fontWeight: "600",
                                marginBottom: "4px",
                              }}
                            >
                              ✅ Completed searches ({progress.completedQueries
                                .length}
                              ):
                            </div>
                            <div
                              style={{
                                maxHeight: "120px",
                                overflowY: "auto",
                                fontSize: "11px",
                                color: "#3b82f6",
                              }}
                            >
                              {[...progress.completedQueries]
                                .reverse()
                                .slice(0, 5)
                                .map(
                                  (
                                    q: { query: string; emailCount: number },
                                    i: number,
                                  ) => (
                                    <div
                                      key={i}
                                      style={{
                                        padding: "2px 0",
                                        borderBottom: "1px solid #dbeafe",
                                      }}
                                    >
                                      <span style={{ fontFamily: "monospace" }}>
                                        {q?.query
                                          ? q.query.length > 50
                                            ? q.query.substring(0, 50) + "..."
                                            : q.query
                                          : "unknown"}
                                      </span>
                                      <span
                                        style={{
                                          marginLeft: "8px",
                                          color: "#059669",
                                        }}
                                      >
                                        ({q?.emailCount ?? 0} emails)
                                      </span>
                                    </div>
                                  ),
                                )}
                            </div>
                          </div>
                        )
                        : null)}
                  </div>
                )
                : null,
          ),
        )}

        {/* Scan Complete */}
        {derive(scanCompleted, (completed: boolean) =>
          completed
            ? (
              <div
                style={{
                  padding: "16px",
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: "8px",
                }}
              >
                <div
                  style={{
                    fontSize: "16px",
                    fontWeight: "600",
                    color: "#166534",
                    marginBottom: "12px",
                    textAlign: "center",
                  }}
                >
                  ✓ Scan Complete
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "#059669",
                    textAlign: "center",
                  }}
                >
                  <ct-markdown>
                    {derive(agentResult, (r: any) => r?.summary || "")}
                  </ct-markdown>
                </div>
                <ct-button
                  onClick={boundCompleteScan}
                  size="lg"
                  style="width: 100%; margin-top: 12px;"
                >
                  ✓ Done
                </ct-button>
              </div>
            )
            : null)}
      </div>
    );

    // Stats UI - last scan timestamp
    const statsUI = (
      <div style={{ fontSize: "13px", color: "#666" }}>
        {derive(lastScanAt, (ts: number) =>
          ts > 0
            ? <div>Last Scan: {new Date(ts).toLocaleString()}</div>
            : null)}
      </div>
    );

    // Debug Log UI - collapsible log of agent activity
    const debugLogUI = (
      <div style={{ marginTop: "8px" }}>
        {derive(debugLog, (log: DebugLogEntry[]) =>
          log && log.length > 0
            ? (
              <div
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                {/* Header - clickable to toggle */}
                <div
                  onClick={toggleDebugHandler({ expanded: debugExpanded })}
                  style={{
                    padding: "8px 12px",
                    background: "#f8fafc",
                    borderBottom: "1px solid #e2e8f0",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "#475569",
                  }}
                >
                  <span>
                    {derive(debugExpanded, (e: boolean) => e ? "▼" : "▶")}{" "}
                    Debug Log ({log.length} entries)
                  </span>
                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                    click to {derive(
                      debugExpanded,
                      (e: boolean) => e ? "collapse" : "expand",
                    )}
                  </span>
                </div>

                {/* Content - shown when expanded */}
                {derive(debugExpanded, (expanded: boolean) =>
                  expanded
                    ? (
                      <div
                        style={{
                          maxHeight: "300px",
                          overflowY: "auto",
                          background: "#1e293b",
                          padding: "12px",
                          fontFamily: "monospace",
                          fontSize: "11px",
                        }}
                      >
                        {log.filter((e): e is DebugLogEntry => e != null).map((
                          entry: DebugLogEntry,
                          i: number,
                        ) => (
                          <div
                            key={i}
                            style={{
                              padding: "4px 0",
                              borderBottom: "1px solid #334155",
                              color: entry.type === "error"
                                ? "#f87171"
                                : entry.type === "search_start"
                                ? "#60a5fa"
                                : entry.type === "search_result"
                                ? "#4ade80"
                                : "#e2e8f0",
                            }}
                          >
                            <span style={{ color: "#64748b" }}>
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </span>{" "}
                            <span
                              style={{
                                padding: "1px 4px",
                                borderRadius: "3px",
                                fontSize: "10px",
                                background: entry.type === "error"
                                  ? "#7f1d1d"
                                  : entry.type === "search_start"
                                  ? "#1e3a5f"
                                  : entry.type === "search_result"
                                  ? "#14532d"
                                  : "#334155",
                              }}
                            >
                              {entry.type}
                            </span>{" "}
                            {entry.message}
                            {entry.details && (
                              <div
                                style={{
                                  marginLeft: "16px",
                                  color: "#94a3b8",
                                  fontSize: "10px",
                                }}
                              >
                                {JSON.stringify(entry.details, null, 2)}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                    : null)}
              </div>
            )
            : null)}
      </div>
    );

    // ========================================================================
    // LOCAL QUERIES MANAGEMENT
    // ========================================================================

    // Note: rateQueryHandler, deleteLocalQueryHandler, flagForShareHandler are defined at module scope
    // and called directly with all parameters in onClick handlers (no pre-binding needed)
    // Note: localQueriesExpanded/toggleLocalQueries removed - using native <details>/<summary> instead

    // Pre-bind handler for creating registry
    const boundCreateSearchRegistry = createSearchRegistry({});

    // Local Queries UI - collapsible list of saved queries
    // Uses native <details>/<summary> to avoid nested derive closure issues
    // (see superstition: 2025-12-06-use-native-details-summary-for-expand-collapse.md)
    //
    // Key fix: Instead of nested derive(localQueriesExpanded, ...) inside derive(localQueries, ...),
    // we use native <details open> which handles expand/collapse via browser without reactive state.
    // The derive(localQueries) renders the entire details block including content - no closure issues.
    const localQueriesUI = (
      <div style={{ marginTop: "8px" }}>
        {derive(
          [localQueriesWithFoundItems, onlySaveQueriesWithItems],
          ([queries, onlyWithItems]: [LocalQuery[], boolean]) => {
            // Filter queries: when onlyWithItems is true, only show queries that found target items
            const filteredQueries = (queries || []).filter(
              (q): q is LocalQuery => {
                if (!q) return false;
                if (onlyWithItems) {
                  return (q.foundItems || 0) > 0;
                }
                return true;
              },
            );

            if (filteredQueries.length === 0) return null;

            return (
              <details
                open
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                {/* Summary - clickable header */}
                <summary
                  style={{
                    padding: "8px 12px",
                    background: "#fefce8",
                    borderBottom: "1px solid #fef08a",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "#854d0e",
                    listStyle: "none",
                  }}
                >
                  <span>My Saved Queries ({filteredQueries.length})</span>
                  <span style={{ fontSize: "11px", color: "#a16207" }}>
                    click to toggle
                  </span>
                </summary>

                {/* Content - shown when expanded (handled by browser) */}
                <div
                  style={{
                    maxHeight: "300px",
                    overflowY: "auto",
                    background: "#fffbeb",
                    padding: "8px",
                  }}
                >
                  {[...filteredQueries]
                    .sort((a, b) =>
                      (b.effectiveness || 0) - (a.effectiveness || 0)
                    )
                    .map((query: LocalQuery) => (
                      <div
                        style={{
                          padding: "8px",
                          marginBottom: "8px",
                          background: "white",
                          borderRadius: "6px",
                          border: "1px solid #fef08a",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                          }}
                        >
                          <div style={{ flex: 1 }}>
                            <div
                              style={{
                                fontFamily: "monospace",
                                fontSize: "12px",
                                color: "#1e293b",
                                wordBreak: "break-all",
                                marginBottom: "4px",
                              }}
                            >
                              {query.query}
                            </div>
                            <div style={{ fontSize: "10px", color: "#64748b" }}>
                              Used {query.useCount}x
                              {query.lastUsed &&
                                ` · Last: ${
                                  new Date(query.lastUsed).toLocaleDateString()
                                }`}
                              {query.shareStatus === "pending_review" && (
                                <span
                                  style={{
                                    color: "#3b82f6",
                                    marginLeft: "8px",
                                  }}
                                >
                                  (pending review)
                                </span>
                              )}
                              {query.shareStatus === "submitted" && (
                                <span
                                  style={{
                                    color: "#22c55e",
                                    marginLeft: "8px",
                                  }}
                                >
                                  (shared)
                                </span>
                              )}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: "4px" }}>
                            {query.shareStatus === "private" && (
                              <ct-button
                                onClick={flagForShareHandler({
                                  queryId: query.id,
                                  localQueries,
                                  pendingSubmissions,
                                })}
                                variant="ghost"
                                size="sm"
                                style="color: #3b82f6; font-size: 11px;"
                              >
                                Share
                              </ct-button>
                            )}
                            <ct-button
                              onClick={deleteLocalQueryHandler({
                                queryId: query.id,
                                localQueries,
                                pendingSubmissions,
                              })}
                              variant="ghost"
                              size="sm"
                              style="color: #dc2626; font-size: 12px;"
                            >
                              ×
                            </ct-button>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </details>
            );
          },
        )}
      </div>
    );

    // ========================================================================
    // PII SCREENING & PENDING SUBMISSIONS
    // ========================================================================

    // Schema for privacy/generalizability screening response
    const piiScreeningSchema = {
      type: "object" as const,
      properties: {
        hasPII: {
          type: "boolean" as const,
          description: "Whether PII was detected",
        },
        piiFound: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "List of PII items found (e.g., 'email: john@example.com')",
        },
        isGeneralizable: {
          type: "boolean" as const,
          description: "Whether the query is general enough to help others",
        },
        generalizabilityIssues: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "List of reasons the query might not generalize",
        },
        sanitizedQuery: {
          type: "string" as const,
          description:
            "Query with PII removed and made more general (empty string if not salvageable)",
        },
        confidence: {
          type: "number" as const,
          description: "Confidence in analysis (0-1)",
        },
        recommendation: {
          type: "string" as const,
          enum: ["share", "share_with_edits", "do_not_share"] as const,
          description: "Whether to recommend sharing this query",
        },
      },
      required: [
        "hasPII",
        "piiFound",
        "isGeneralizable",
        "generalizabilityIssues",
        "sanitizedQuery",
        "confidence",
        "recommendation",
      ] as const,
    };

    // Note: flagQueryForSharingHandler is defined at module scope

    // Run PII screening on pending submissions
    // Uses derive to reactively screen new submissions
    const piiScreeningPrompt = derive(
      pendingSubmissions,
      (submissions: PendingSubmission[]) => {
        // Filter out any undefined/null items first, then find unscreened submissions
        const validSubmissions = (submissions || []).filter((
          s,
        ): s is PendingSubmission => s != null);
        const unscreened = validSubmissions.filter(
          (s) =>
            s.sanitizedQuery === s.originalQuery &&
            s.piiWarnings.length === 0 && !s.userApproved,
        );
        if (unscreened.length === 0) return "";

        // Build prompt for the first unscreened submission
        const submission = unscreened[0];
        return `Analyze this Gmail search query for privacy issues and generalizability.

Query: "${submission.originalQuery}"

Check for TWO categories of problems:

1. PRIVACY (PII - Personally Identifiable Information):
   - Email addresses (from:john@acme.com -> from:*@*.com)
   - Personal names (from:john.smith -> from:*)
   - Specific company domains that reveal employer
   - Account numbers, confirmation codes, order IDs
   - Specific dates that could identify events

2. GENERALIZABILITY (queries too specific to one person):
   - Very specific sender domains that only this user uses
   - Queries that reference specific subscription services/vendors unique to this user
   - Highly specific subject line fragments that won't match others' emails
   - Combinations of terms that are overly narrow

GOOD queries to share (generic patterns):
- "from:marriott.com subject:points" (common hotel chain)
- "from:noreply@* subject:confirmation" (generic pattern)
- "subject:receipt from:amazon.com" (common retailer)

BAD queries to share:
- "from:john.smith@acme.com" (specific person)
- "from:mycustomdomain.com" (personal domain)
- "subject:Order #12345" (specific order)
- "from:obscure-local-business@gmail.com" (won't help others)

Return a sanitized version that:
1. Removes/generalizes PII
2. Makes the query more general if it's too specific
3. Returns empty string "" if the query can't be made useful for others`;
      },
    );

    // Only run PII screening when there's a prompt
    const piiScreeningResult = derive(piiScreeningPrompt, (prompt: string) => {
      if (!prompt) return null;
      return generateObject({
        prompt,
        schema: piiScreeningSchema,
        system:
          `You are a privacy analyst and query curator for a community knowledge base.

Your job is to evaluate Gmail search queries for:
1. PRIVACY: Detect and remove/sanitize PII (emails, names, specific identifiers)
2. GENERALIZABILITY: Assess if the query pattern would help OTHER users

A query should only be shared if it represents a GENERAL PATTERN that others could benefit from.
Major hotel chains, airlines, common retailers, and widespread services are good candidates.
Personal domains, local businesses, and hyper-specific searches should not be shared.

Be conservative: when in doubt, recommend "do_not_share".`,
      });
    });

    // Update pending submissions with screening results
    // This is a side effect that runs when screening completes
    derive(piiScreeningResult, (result: any) => {
      if (!result || !result.result) return;

      const screeningData = result.result as {
        hasPII: boolean;
        piiFound: string[];
        isGeneralizable: boolean;
        generalizabilityIssues: string[];
        sanitizedQuery: string;
        confidence: number;
        recommendation: "share" | "share_with_edits" | "do_not_share";
      };

      const pendingWritable = pendingSubmissions as Writable<
        PendingSubmission[]
      >;
      const submissions = (pendingWritable.get() || []).filter((
        s: PendingSubmission | null,
      ): s is PendingSubmission => s != null);

      // Find the submission that was screened (still pending)
      const unscreened = submissions.filter(
        (s: PendingSubmission) =>
          s?.recommendation === "pending" && !s?.userApproved,
      );
      if (unscreened.length === 0) return;

      const submission = unscreened[0];
      const idx = submissions.findIndex((s: PendingSubmission) =>
        s.localQueryId === submission.localQueryId
      );
      if (idx < 0) return;

      // Update the submission with screening results using .key().key().set()
      const itemCell = pendingWritable.key(idx);
      (itemCell.key("sanitizedQuery") as Writable<string>).set(
        screeningData.sanitizedQuery || submission.originalQuery,
      );
      (itemCell.key("piiWarnings") as Writable<string[]>).set(
        screeningData.piiFound || [],
      );
      (itemCell.key("generalizabilityIssues") as Writable<string[]>).set(
        screeningData.generalizabilityIssues || [],
      );
      (itemCell.key("recommendation") as Writable<
        "share" | "share_with_edits" | "do_not_share" | "pending"
      >).set(screeningData.recommendation);
    });

    // Note: approvePendingSubmissionHandler, rejectPendingSubmissionHandler, updateSanitizedQueryHandler
    // are defined at module scope

    // Track if pending submissions UI is expanded
    const pendingSubmissionsExpanded = Writable.of(false);

    // Pending Submissions UI
    const pendingSubmissionsUI = (
      <div style={{ marginTop: "8px" }}>
        {derive(pendingSubmissions, (submissions: PendingSubmission[]) =>
          submissions && submissions.length > 0
            ? (
              <div
                style={{
                  border: "1px solid #dbeafe",
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                {/* Header */}
                <div
                  onClick={togglePendingSubmissionsHandler({
                    expanded: pendingSubmissionsExpanded,
                  })}
                  style={{
                    padding: "8px 12px",
                    background: "#eff6ff",
                    borderBottom: "1px solid #dbeafe",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "#1e40af",
                  }}
                >
                  <span>
                    {derive(pendingSubmissionsExpanded, (e: boolean) =>
                      e ? "▼" : "▶")}{" "}
                    Share Your Discoveries ({submissions.length} pending)
                  </span>
                  <span style={{ fontSize: "11px", color: "#3b82f6" }}>
                    click to{" "}
                    {derive(pendingSubmissionsExpanded, (e: boolean) =>
                      e ? "collapse" : "expand")}
                  </span>
                </div>

                {/* Content */}
                {derive(pendingSubmissionsExpanded, (expanded: boolean) =>
                  expanded
                    ? (
                      <div
                        style={{
                          maxHeight: "400px",
                          overflowY: "auto",
                          background: "#f8fafc",
                          padding: "8px",
                        }}
                      >
                        {submissions.filter((s): s is PendingSubmission =>
                          s != null
                        ).map((submission: PendingSubmission) => (
                          <div
                            style={{
                              padding: "12px",
                              marginBottom: "8px",
                              background: "white",
                              borderRadius: "6px",
                              border: "1px solid #e2e8f0",
                            }}
                          >
                            {/* Original query */}
                            <div style={{ marginBottom: "8px" }}>
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "#64748b",
                                  marginBottom: "2px",
                                }}
                              >
                                Original Query:
                              </div>
                              <div
                                style={{
                                  fontFamily: "monospace",
                                  fontSize: "12px",
                                  color: "#1e293b",
                                  background: "#f1f5f9",
                                  padding: "6px 8px",
                                  borderRadius: "4px",
                                }}
                              >
                                {submission.originalQuery}
                              </div>
                            </div>

                            {/* Recommendation badge */}
                            {submission.recommendation !== "pending" && (
                              <div style={{ marginBottom: "8px" }}>
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "2px 8px",
                                    borderRadius: "4px",
                                    fontSize: "11px",
                                    fontWeight: "500",
                                    background:
                                      submission.recommendation === "share"
                                        ? "#dcfce7"
                                        : submission.recommendation ===
                                            "share_with_edits"
                                        ? "#fef9c3"
                                        : "#fee2e2",
                                    color: submission.recommendation === "share"
                                      ? "#166534"
                                      : submission.recommendation ===
                                          "share_with_edits"
                                      ? "#854d0e"
                                      : "#b91c1c",
                                  }}
                                >
                                  {submission.recommendation === "share"
                                    ? "✓ Good to share"
                                    : submission.recommendation ===
                                        "share_with_edits"
                                    ? "⚠ Needs editing"
                                    : "✗ Not recommended"}
                                </span>
                              </div>
                            )}

                            {/* PII Warnings */}
                            {submission.piiWarnings.length > 0 && (
                              <div style={{ marginBottom: "8px" }}>
                                <div
                                  style={{
                                    fontSize: "11px",
                                    color: "#dc2626",
                                    marginBottom: "2px",
                                  }}
                                >
                                  ⚠️ Privacy Issues:
                                </div>
                                <div
                                  style={{ fontSize: "12px", color: "#b91c1c" }}
                                >
                                  {submission.piiWarnings.join(", ")}
                                </div>
                              </div>
                            )}

                            {/* Generalizability Issues */}
                            {submission.generalizabilityIssues.length > 0 && (
                              <div style={{ marginBottom: "8px" }}>
                                <div
                                  style={{
                                    fontSize: "11px",
                                    color: "#b45309",
                                    marginBottom: "2px",
                                  }}
                                >
                                  ⚠️ Generalizability Issues:
                                </div>
                                <div
                                  style={{ fontSize: "12px", color: "#92400e" }}
                                >
                                  {submission.generalizabilityIssues.join(", ")}
                                </div>
                              </div>
                            )}

                            {/* Sanitized query (editable) */}
                            <div style={{ marginBottom: "8px" }}>
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "#64748b",
                                  marginBottom: "2px",
                                }}
                              >
                                {submission.piiWarnings.length > 0
                                  ? "Sanitized Query (editable):"
                                  : "Query to Share:"}
                              </div>
                              <input
                                type="text"
                                value={submission.sanitizedQuery}
                                onChange={(e: any) => {
                                  const newValue = e.target.value;
                                  const pendingWritable =
                                    pendingSubmissions as Writable<
                                      PendingSubmission[]
                                    >;
                                  const subs = pendingWritable.get() || [];
                                  const idx = subs.findIndex((
                                    s: PendingSubmission,
                                  ) =>
                                    s.localQueryId === submission.localQueryId
                                  );
                                  if (idx >= 0) {
                                    (pendingWritable.key(idx).key(
                                      "sanitizedQuery",
                                    ) as Writable<string>).set(newValue);
                                  }
                                }}
                                style={{
                                  width: "100%",
                                  fontFamily: "monospace",
                                  fontSize: "12px",
                                  padding: "6px 8px",
                                  border: "1px solid #d1d5db",
                                  borderRadius: "4px",
                                }}
                              />
                            </div>

                            {/* Action buttons */}
                            <div
                              style={{
                                display: "flex",
                                gap: "8px",
                                justifyContent: "flex-end",
                              }}
                            >
                              <ct-button
                                onClick={() => {
                                  // Reject
                                  const pendingWritable =
                                    pendingSubmissions as Writable<
                                      PendingSubmission[]
                                    >;
                                  const localWritable =
                                    localQueries as Writable<LocalQuery[]>;
                                  const subs = pendingWritable.get() || [];
                                  pendingWritable.set(
                                    subs.filter((s: PendingSubmission) =>
                                      s.localQueryId !== submission.localQueryId
                                    ),
                                  );
                                  // Reset local query status
                                  const queries = localWritable.get() || [];
                                  const idx = queries.findIndex((
                                    q: LocalQuery,
                                  ) =>
                                    q.id === submission.localQueryId
                                  );
                                  if (idx >= 0) {
                                    (localWritable.key(idx).key(
                                      "shareStatus",
                                    ) as Writable<
                                      "private" | "pending_review" | "submitted"
                                    >).set("private");
                                  }
                                }}
                                variant="ghost"
                                size="sm"
                                style="color: #64748b;"
                              >
                                Keep Private
                              </ct-button>
                              <ct-button
                                onClick={() => {
                                  // Approve
                                  const pendingWritable =
                                    pendingSubmissions as Writable<
                                      PendingSubmission[]
                                    >;
                                  const subs = pendingWritable.get() || [];
                                  const idx = subs.findIndex((
                                    s: PendingSubmission,
                                  ) =>
                                    s.localQueryId === submission.localQueryId
                                  );
                                  if (idx >= 0) {
                                    (pendingWritable.key(idx).key(
                                      "userApproved",
                                    ) as Writable<boolean>).set(true);
                                  }
                                }}
                                variant={submission.userApproved
                                  ? "secondary"
                                  : "default"}
                                size="sm"
                                disabled={submission.userApproved}
                              >
                                {submission.userApproved
                                  ? "✓ Approved"
                                  : "Approve for Sharing"}
                              </ct-button>
                            </div>
                          </div>
                        ))}

                        {/* Submit all approved button */}
                        {derive(
                          [pendingSubmissions, registryWish, agentTypeUrl],
                          (
                            [subs, registry, typeUrl]: [
                              PendingSubmission[],
                              any,
                              string,
                            ],
                          ) => {
                            const approvedCount = (subs || []).filter((s) =>
                              s.userApproved && !s.submittedAt
                            ).length;
                            const hasRegistry = !!registry?.result?.submitQuery;

                            return approvedCount > 0
                              ? (
                                <div
                                  style={{
                                    marginTop: "12px",
                                    textAlign: "center",
                                  }}
                                >
                                  <ct-button
                                    variant="default"
                                    disabled={!hasRegistry}
                                    onClick={() => {
                                      if (!hasRegistry || !typeUrl) {
                                        return;
                                      }
                                      const approved = (subs || []).filter((
                                        s: PendingSubmission,
                                      ) =>
                                        s.userApproved && !s.submittedAt
                                      );
                                      const submitHandler = registry?.result
                                        ?.submitQuery;
                                      const pendingWritable =
                                        pendingSubmissions as Writable<
                                          PendingSubmission[]
                                        >;
                                      const localWritable =
                                        localQueries as Writable<LocalQuery[]>;

                                      // Submit each approved query
                                      approved.forEach(
                                        (submission: PendingSubmission) => {
                                          if (submitHandler) {
                                            submitHandler({
                                              agentTypeUrl: typeUrl,
                                              query: submission.sanitizedQuery,
                                            });
                                          }

                                          // Mark as submitted in pendingSubmissions
                                          const currentSubs =
                                            pendingWritable.get() || [];
                                          const idx = currentSubs.findIndex((
                                            s: PendingSubmission,
                                          ) =>
                                            s.localQueryId ===
                                              submission.localQueryId
                                          );
                                          if (idx >= 0) {
                                            (pendingWritable.key(idx).key(
                                              "submittedAt",
                                            ) as Writable<number | undefined>)
                                              .set(
                                                Temporal.Now.instant()
                                                  .epochMilliseconds,
                                              );
                                          }

                                          // Update local query status to submitted
                                          const queries = localWritable.get() ||
                                            [];
                                          const qIdx = queries.findIndex((
                                            q: LocalQuery,
                                          ) =>
                                            q.id === submission.localQueryId
                                          );
                                          if (qIdx >= 0) {
                                            (localWritable.key(qIdx).key(
                                              "shareStatus",
                                            ) as Writable<
                                              | "private"
                                              | "pending_review"
                                              | "submitted"
                                            >).set("submitted");
                                          }
                                        },
                                      );
                                    }}
                                  >
                                    Submit {approvedCount} Approved{" "}
                                    {approvedCount === 1 ? "Query" : "Queries"}
                                    {" "}
                                    to Community
                                  </ct-button>
                                  {!hasRegistry && (
                                    <div
                                      style={{
                                        marginTop: "12px",
                                        padding: "12px",
                                        background: "#fef3c7",
                                        border: "1px solid #fde68a",
                                        borderRadius: "8px",
                                      }}
                                    >
                                      <div
                                        style={{
                                          fontSize: "12px",
                                          color: "#92400e",
                                          marginBottom: "8px",
                                        }}
                                      >
                                        No community registry found. You can
                                        create one to share queries with other
                                        users.
                                      </div>
                                      <div
                                        style={{
                                          fontSize: "10px",
                                          color: "#a16207",
                                          marginBottom: "8px",
                                        }}
                                      >
                                        Note: Registry will be created in your
                                        current space. After creation, favorite
                                        it with tag #gmailSearchRegistry.
                                      </div>
                                      <ct-button
                                        onClick={boundCreateSearchRegistry}
                                        variant="secondary"
                                        size="sm"
                                      >
                                        Create Registry
                                      </ct-button>
                                    </div>
                                  )}
                                </div>
                              )
                              : null;
                          },
                        )}
                      </div>
                    )
                    : null)}
              </div>
            )
            : null)}
      </div>
    );

    // ========================================================================
    // EXTRAS UI - Combined UI for subclasses to inherit naturally
    // Includes: local queries, pending submissions, and debug log
    // ========================================================================
    const extrasUI = (
      <div>
        {localQueriesUI}
        {pendingSubmissionsUI}
        {debugLogUI}
      </div>
    );

    // ========================================================================
    // RETURN
    // ========================================================================

    return {
      [NAME]: title,

      // UI Pieces grouped for composition (like chatbot.tsx pattern)
      ui: {
        auth: authUI,
        controls: controlsUI,
        progress: progressUI,
        stats: statsUI,
        extras: extrasUI,
        debugLog: debugLogUI,
        localQueries: localQueriesUI,
        pendingSubmissions: pendingSubmissionsUI,
      },

      // Auth state (exposed for embedding patterns)
      auth,
      isAuthenticated,
      hasGmailScope,
      authSource,

      // Agent state
      agentResult,
      agentPending,
      isScanning,

      // Progress
      searchProgress,

      // Debug log
      debugLog,

      // Timestamps
      lastScanAt,

      // Actions
      startScan: boundStartScan,
      stopScan: boundStopScan,

      // Local queries (shared search strings support)
      localQueries,
      pendingSubmissions,
      rateQuery: rateQueryHandler,
      deleteLocalQuery: deleteLocalQueryHandler,
      // Cell for consuming patterns to signal "found an item"
      // Increment with searcher.itemFoundSignal.set(current + 1) when your tool finds items
      itemFoundSignal,

      // Full UI (composed from pieces)
      [UI]: (
        <ct-screen>
          <div slot="header">
            <h2 style={{ margin: "0", fontSize: "18px" }}>{title}</h2>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack style="padding: 16px; gap: 16px;">
              {authUI}
              {controlsUI}
              {progressUI}
              {statsUI}
              {extrasUI}
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);

export default GmailAgenticSearch;
