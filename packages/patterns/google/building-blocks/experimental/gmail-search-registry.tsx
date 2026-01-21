/// <cts-enable />
/**
 * Gmail Search Registry - Community Query Database
 *
 * A centralized registry for sharing effective Gmail search queries across users.
 * This pattern should be deployed to a well-known space (community-patterns-shared)
 * and tagged with #gmailSearchRegistry for discovery via wish().
 *
 * Architecture:
 * - Each agent type (identified by GitHub raw URL) has its own section
 * - Users can submit queries after PII/generalizability screening
 * - Queries can be upvoted/downvoted by other users
 *
 * Setup:
 * 1. Deploy to space: community-patterns-shared
 * 2. Favorite the charm with tag: #gmailSearchRegistry
 * 3. Other gmail-agent patterns discover via: wish({ query: "#gmailSearchRegistry" })
 *
 * TODO: Future framework enhancement will support wish() without requiring favorites
 */
import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

// ============================================================================
// TYPES
// ============================================================================

// A shared query in the registry (flat structure)
// NOTE: CLI may show empty/default values but actual data is stored and works in UI
export interface SharedQuery {
  id: string;
  agentTypeUrl: string;
  query: string;
  description: string;
  submittedBy: string;
  submittedAt: number;
  upvotes: number;
  downvotes: number;
  lastValidated: number;
}

// Grouped view of queries (computed, not stored)
export interface AgentTypeRegistry {
  agentTypeUrl: string;
  agentTypeName?: string;
  queries: SharedQuery[];
}

// ============================================================================
// INPUT/OUTPUT TYPES
// ============================================================================

export interface GmailSearchRegistryInput {
  // Flat array of all queries (workaround for CLI display bug CT-1104)
  queries?: Default<SharedQuery[], []>;
}

/** Community registry for shared Gmail search queries. #gmailSearchRegistry */
export interface GmailSearchRegistryOutput {
  [NAME]: string;
  [UI]: JSX.Element;

  // Data - flat array storage, computed registries view
  queries: SharedQuery[];
  registries: Record<string, AgentTypeRegistry>; // Computed grouped view

  // Actions for external patterns to use - using unknown to match bound handler return type
  submitQuery: unknown;
  upvoteQuery: unknown;
  downvoteQuery: unknown;
}

// ============================================================================
// HANDLERS (defined at module scope)
// ============================================================================

// Handler to submit a new query
const submitQuery = handler<
  {
    agentTypeUrl: string;
    query: string;
    description?: string;
    submittedBy?: string;
  },
  { queries: Writable<SharedQuery[]> }
>((input, state) => {
  const allQueries = state.queries.get() || [];

  // Check for duplicate queries (case-insensitive, same agent type)
  const normalizedQuery = input.query.toLowerCase().trim();
  if (
    allQueries.some((q: SharedQuery) =>
      q.agentTypeUrl === input.agentTypeUrl &&
      q.query.toLowerCase().trim() === normalizedQuery
    )
  ) {
    return { success: false, error: "Query already exists" };
  }

  // Create new query entry and push to array
  const queryId = `query-${Date.now()}-${
    Math.random().toString(36).slice(2, 8)
  }`;
  state.queries.push({
    id: queryId,
    agentTypeUrl: input.agentTypeUrl,
    query: input.query,
    description: input.description || "",
    submittedBy: input.submittedBy || "",
    submittedAt: Date.now(),
    upvotes: 0,
    downvotes: 0,
    lastValidated: 0,
  });
  return { success: true, queryId };
});

// Handler to upvote a query
const upvoteQuery = handler<
  { agentTypeUrl: string; queryId: string },
  { queries: Writable<SharedQuery[]> }
>((input, state) => {
  const allQueries = state.queries.get() || [];
  const queryIdx = allQueries.findIndex((q: SharedQuery) =>
    q.id === input.queryId
  );
  if (queryIdx < 0) return { success: false, error: "Query not found" };

  const updatedQuery = {
    ...allQueries[queryIdx],
    upvotes: allQueries[queryIdx].upvotes + 1,
    lastValidated: Date.now(),
  };

  state.queries.set([
    ...allQueries.slice(0, queryIdx),
    updatedQuery,
    ...allQueries.slice(queryIdx + 1),
  ]);

  return { success: true };
});

// Handler to downvote a query
const downvoteQuery = handler<
  { agentTypeUrl: string; queryId: string },
  { queries: Writable<SharedQuery[]> }
>((input, state) => {
  const allQueries = state.queries.get() || [];
  const queryIdx = allQueries.findIndex((q: SharedQuery) =>
    q.id === input.queryId
  );
  if (queryIdx < 0) return { success: false, error: "Query not found" };

  const updatedQuery = {
    ...allQueries[queryIdx],
    downvotes: allQueries[queryIdx].downvotes + 1,
  };

  state.queries.set([
    ...allQueries.slice(0, queryIdx),
    updatedQuery,
    ...allQueries.slice(queryIdx + 1),
  ]);

  return { success: true };
});

// Helper to extract a readable name from the agent type URL
function extractAgentName(url: string | undefined | null): string {
  if (!url || typeof url !== "string") return "Unknown Agent";
  // Extract filename from URL like:
  // https://raw.githubusercontent.com/.../patterns/jkomoros/hotel-membership-gmail-agent.tsx
  const match = url.match(/\/([^/]+)\.tsx$/);
  if (match) {
    return match[1]
      .replace(/-/g, " ")
      .replace(/gmail agent/i, "")
      .trim()
      .replace(/\b\w/g, (c: string) => c.toUpperCase());
  }
  return url;
}

// ============================================================================
// PATTERN
// ============================================================================

const GmailSearchRegistry = pattern<
  GmailSearchRegistryInput,
  GmailSearchRegistryOutput
>(({ queries }) => {
  // Compute grouped registries view from flat queries array
  const registries = computed(() => {
    const grouped: Record<string, AgentTypeRegistry> = {};
    for (const q of queries || []) {
      if (!q || !q.agentTypeUrl) continue; // Skip null/undefined during hydration
      if (!grouped[q.agentTypeUrl]) {
        grouped[q.agentTypeUrl] = {
          agentTypeUrl: q.agentTypeUrl,
          agentTypeName: extractAgentName(q.agentTypeUrl),
          queries: [],
        };
      }
      grouped[q.agentTypeUrl].queries.push(q);
    }
    return grouped;
  });

  // Pre-bound handlers
  const boundSubmitQuery = submitQuery({ queries });
  const boundUpvoteQuery = upvoteQuery({ queries });
  const boundDownvoteQuery = downvoteQuery({ queries });

  // Stats
  const stats = computed(() => {
    const regs = registries;
    const agentTypes = Object.keys(regs || {});
    const totalQueries = agentTypes.reduce(
      (sum, key) => sum + (regs[key]?.queries?.length || 0),
      0,
    );
    return { agentTypeCount: agentTypes.length, totalQueries };
  });

  // Pre-compute registry entries as cell for .map() usage
  const registryEntries = computed(() =>
    Object.entries(registries || {})
      .filter(([url, reg]) => url && reg) // Guard against undefined during hydration
      .map(([url, reg]) => ({ url, ...reg, queries: reg.queries || [] }))
  );

  return {
    [NAME]: "Gmail Search Registry",

    // Data
    queries,
    registries,

    // Actions
    submitQuery: boundSubmitQuery,
    upvoteQuery: boundUpvoteQuery,
    downvoteQuery: boundDownvoteQuery,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <h2 style={{ margin: "0", fontSize: "18px" }}>
            Gmail Search Registry
          </h2>
        </div>

        <ct-vscroll flex showScrollbar>
          <ct-vstack style="padding: 16px; gap: 16px;">
            {/* Info banner */}
            <div
              style={{
                padding: "12px",
                background: "#eff6ff",
                borderRadius: "8px",
                border: "1px solid #dbeafe",
                fontSize: "13px",
                color: "#1e40af",
              }}
            >
              <div style={{ fontWeight: "500", marginBottom: "4px" }}>
                Community Query Registry
              </div>
              <div style={{ fontSize: "12px", color: "#3b82f6" }}>
                This registry collects effective Gmail search queries shared by
                users. Other gmail-agent patterns can discover this via wish()
                to get community suggestions.
              </div>
            </div>

            {/* Stats */}
            <div
              style={{
                display: "flex",
                gap: "16px",
                padding: "12px",
                background: "#f8fafc",
                borderRadius: "8px",
              }}
            >
              <div style={{ textAlign: "center" }}>
                <div
                  style={{
                    fontSize: "24px",
                    fontWeight: "600",
                    color: "#1e293b",
                  }}
                >
                  {computed(() => stats.agentTypeCount)}
                </div>
                <div style={{ fontSize: "11px", color: "#64748b" }}>
                  Agent Types
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div
                  style={{
                    fontSize: "24px",
                    fontWeight: "600",
                    color: "#1e293b",
                  }}
                >
                  {computed(() => stats.totalQueries)}
                </div>
                <div style={{ fontSize: "11px", color: "#64748b" }}>
                  Total Queries
                </div>
              </div>
            </div>

            {/* Registry list - use .map() on cell instead of derive() for onClick to work */}
            <div>
              {/* Empty state */}
              {computed(() =>
                registryEntries.length === 0
                  ? (
                    <div
                      style={{
                        padding: "24px",
                        textAlign: "center",
                        color: "#64748b",
                        fontSize: "13px",
                      }}
                    >
                      No queries registered yet. Gmail-agent patterns will
                      submit queries here.
                    </div>
                  )
                  : null
              )}

              {/* Registry entries - using native details/summary for expand/collapse */}
              {registryEntries.map((registry) => (
                <details
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    marginBottom: "8px",
                    overflow: "hidden",
                  }}
                >
                  <summary
                    style={{
                      padding: "10px 12px",
                      background: "#f8fafc",
                      cursor: "pointer",
                      listStyle: "none",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: "500",
                        fontSize: "13px",
                        color: "#1e293b",
                      }}
                    >
                      {registry.agentTypeName || extractAgentName(registry.url)}
                    </div>
                    <div
                      style={{
                        fontSize: "10px",
                        color: "#64748b",
                        marginTop: "2px",
                      }}
                    >
                      {registry.queries.length}{" "}
                      {registry.queries.length === 1 ? "query" : "queries"}
                    </div>
                  </summary>

                  {/* Queries list */}
                  <div style={{ padding: "8px" }}>
                    {computed(() => {
                      // Safely extract queries array (may be opaque during compilation)
                      const queriesArray = registry.queries || [];
                      if (!Array.isArray(queriesArray)) return null;
                      return queriesArray
                        .filter((q) => q && q.query) // Filter out null/undefined during hydration
                        .sort((a, b) =>
                          ((b.upvotes || 0) - (b.downvotes || 0)) -
                          ((a.upvotes || 0) - (a.downvotes || 0))
                        )
                        .map((query) => (
                          <div
                            style={{
                              padding: "10px",
                              background: "white",
                              borderRadius: "6px",
                              border: "1px solid #e2e8f0",
                              marginBottom: "6px",
                            }}
                          >
                            <div
                              style={{
                                fontFamily: "monospace",
                                fontSize: "12px",
                                color: "#1e293b",
                                marginBottom: "4px",
                              }}
                            >
                              {query.query}
                            </div>
                            {query.description && (
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "#64748b",
                                  marginBottom: "4px",
                                }}
                              >
                                {query.description}
                              </div>
                            )}
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                fontSize: "10px",
                                color: "#94a3b8",
                              }}
                            >
                              <div>
                                <span style={{ color: "#22c55e" }}>
                                  +{query.upvotes || 0}
                                </span>
                                {" / "}
                                <span style={{ color: "#ef4444" }}>
                                  -{query.downvotes || 0}
                                </span>
                                {query.submittedBy
                                  ? ` · by ${query.submittedBy}`
                                  : ""}
                              </div>
                              <div>
                                {query.submittedAt
                                  ? new Date(query.submittedAt)
                                    .toLocaleDateString()
                                  : ""}
                              </div>
                            </div>
                          </div>
                        ));
                    })}
                  </div>
                </details>
              ))}
            </div>

            {/* Setup instructions */}
            <div
              style={{
                padding: "12px",
                background: "#fefce8",
                borderRadius: "8px",
                border: "1px solid #fef08a",
                fontSize: "12px",
                color: "#854d0e",
              }}
            >
              <div style={{ fontWeight: "500", marginBottom: "4px" }}>
                Setup Notes
              </div>
              <ul style={{ margin: "0", paddingLeft: "16px" }}>
                <li>
                  This charm should be in space:{" "}
                  <code>community-patterns-shared</code>
                </li>
                <li>
                  Favorite with tag: <code>#gmailSearchRegistry</code>
                </li>
                <li>
                  Gmail agents discover this via:{" "}
                  <code>wish(&#123; query: "#gmailSearchRegistry" &#125;)</code>
                </li>
              </ul>
            </div>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
  };
});

export default GmailSearchRegistry;
