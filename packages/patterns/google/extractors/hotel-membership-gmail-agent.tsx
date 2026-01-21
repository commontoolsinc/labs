/// <cts-enable />
/**
 * Hotel Membership Extractor (v2)
 *
 * Refactored to use the gmail-agentic-search base pattern.
 * Finds hotel loyalty program membership numbers in Gmail.
 *
 * Usage: wish("#hotelMemberships") to get discovered memberships.
 */
import {
  Default,
  derive,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
  // wish,  // TEMPORARILY DISABLED - may cause self-referential loop
} from "commontools";
import GmailAgenticSearch, {
  type SearchProgress,
} from "../building-blocks/experimental/gmail-agentic-search.tsx";
import {
  defineItemSchema,
  InferItem,
  listTool,
} from "../building-blocks/util/agentic-tools.ts";

// Scan mode: "full" = comprehensive all-time search, "recent" = last 7 days only
type ScanMode = "full" | "recent";

// Debug flag for development - disable in production
const DEBUG_HOTEL = false;

// ============================================================================
// EFFECTIVE QUERY HINTS
// ============================================================================
const EFFECTIVE_QUERIES = [
  'from:hilton.com subject:"welcome" OR subject:"hilton honors"',
  'from:marriott.com subject:"welcome" OR subject:"bonvoy"',
  'from:hyatt.com subject:"welcome to world of hyatt"',
  'from:ihg.com subject:"welcome" OR subject:"ihg rewards"',
  'from:accor.com subject:"welcome" OR subject:"accor"',
  'from:hilton.com subject:"statement"',
  'from:marriott.com subject:"statement"',
  "from:hilton.com OR from:hiltonhonors.com",
  "from:marriott.com OR from:email.marriott.com",
  "from:hyatt.com OR from:worldofhyatt.com",
  "from:ihg.com OR from:ihgrewardsclub.com",
  "from:accor.com OR from:accorhotels.com",
];

// ============================================================================
// SCHEMA - DEFINED ONCE! (replaces interface + input type + JSON schema)
// ============================================================================
// The new elegant API: define schema once, get type-checked dedupe fields
const MembershipSchema = defineItemSchema({
  hotelBrand: {
    type: "string",
    description: "Hotel chain name (e.g., 'Marriott', 'Hilton')",
  },
  programName: {
    type: "string",
    description:
      "Loyalty program name (e.g., 'Marriott Bonvoy', 'Hilton Honors')",
  },
  membershipNumber: {
    type: "string",
    description: "The membership number (digits only)",
  },
  tier: {
    type: "string",
    description:
      "Status tier if known (Member, Silver, Gold, Platinum, Diamond)",
  },
  sourceEmailId: {
    type: "string",
    description: "The email ID from searchGmail results",
  },
  sourceEmailSubject: { type: "string", description: "The email subject" },
  sourceEmailDate: { type: "string", description: "The email date" },
  confidence: { type: "number", description: "0-100 confidence score" },
}, [
  "hotelBrand",
  "programName",
  "membershipNumber",
  "sourceEmailId",
  "sourceEmailSubject",
  "sourceEmailDate",
  "confidence",
]);

// Derive TypeScript type from schema (for UI code)
type MembershipRecord = InferItem<typeof MembershipSchema> & {
  extractedAt: number;
};

interface HotelMembershipInput {
  memberships?: Default<MembershipRecord[], []>;
  lastScanAt?: Default<number, 0>;
  isScanning?: Default<boolean, false>;
  maxSearches?: Default<number, 0>; // 0 = unlimited, >0 = limit searches
  // Current scan mode - persisted to know if last scan was full or recent
  currentScanMode?: Default<ScanMode, "full">;
  // Multi-account support: which Google account to use
  accountType?: Default<"default" | "personal" | "work", "default">;
  // Shared with base pattern for coordinating progress UI
  searchProgress?: Default<SearchProgress, {
    currentQuery: "";
    completedQueries: [];
    status: "idle";
    searchCount: 0;
  }>;
}

/** Hotel loyalty membership extractor from Gmail. #hotelMemberships */
interface HotelMembershipOutput {
  memberships: MembershipRecord[];
  lastScanAt: number;
  count: number;
}

// NOTE: Schema defined above using defineItemSchema - no separate INPUT_SCHEMA needed!

// ============================================================================
// HOTEL RESULT SCHEMA
// ============================================================================
const HOTEL_RESULT_SCHEMA = {
  type: "object",
  properties: {
    searchesPerformed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          query: { type: "string" },
          emailsFound: { type: "number" },
        },
      },
    },
    membershipsFound: {
      type: "number",
      description: "Total count of memberships found via reportMembership",
    },
    summary: {
      type: "string",
      description: "Brief summary of what was searched and found",
    },
  },
  required: ["membershipsFound", "summary"],
};

// ============================================================================
// PATTERN
// ============================================================================

// Helper to generate date filter for recent mode (last 7 days)
const getRecentDateFilter = (): string => {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  // Gmail date format: YYYY/MM/DD
  const year = weekAgo.getFullYear();
  const month = String(weekAgo.getMonth() + 1).padStart(2, "0");
  const day = String(weekAgo.getDate()).padStart(2, "0");
  return `after:${year}/${month}/${day}`;
};

// All hotel brands we search for
const ALL_BRANDS = ["Marriott", "Hilton", "Hyatt", "IHG", "Accor"];

// Module-scope handler for starting a scan with mode configuration
const startScan = handler<
  unknown,
  {
    mode: ScanMode;
    searchLimit: number; // 0 = unlimited, >0 = limit
    currentScanMode: Writable<Default<ScanMode, "full">>;
    maxSearches: Writable<Default<number, 0>>;
    isScanning: Writable<Default<boolean, false>>;
    searchProgress: Writable<SearchProgress>;
  }
>((_, state) => {
  const mode = state.mode;
  if (DEBUG_HOTEL) {
    console.log(
      `[HotelMembership] Starting scan in ${mode} mode with limit ${state.searchLimit}`,
    );
  }
  state.currentScanMode.set(mode);
  state.maxSearches.set(state.searchLimit);
  // Initialize progress to trigger progressUI display
  state.searchProgress.set({
    currentQuery: "",
    completedQueries: [],
    status: "searching",
    searchCount: 0,
  });
  state.isScanning.set(true);
});

const HotelMembershipExtractorV2 = pattern<
  HotelMembershipInput,
  HotelMembershipOutput
>(
  (
    {
      memberships,
      lastScanAt,
      isScanning,
      maxSearches,
      currentScanMode,
      accountType,
      searchProgress,
    },
  ) => {
    // ========================================================================
    // CUSTOM TOOL: Report Membership
    // NEW ELEGANT API: Single call with type-checked dedupe fields!
    // ========================================================================
    const reportMembership = listTool(MembershipSchema, {
      items: memberships,
      dedupe: ["hotelBrand", "membershipNumber"], // TypeScript checks these!
      idPrefix: "membership",
      timestamp: "extractedAt",
    });

    // ========================================================================
    // WISH IMPORT: TEMPORARILY DISABLED - may cause self-referential loop
    // when pattern wishes for #hotelMemberships but also exports it
    // ========================================================================

    // Use local memberships only (no wish import for now)
    const allMemberships = memberships;

    // Track counts (simplified without wish)
    const localMembershipCount = derive(
      memberships,
      (list) => list?.length || 0,
    );

    // ========================================================================
    // MULTI-ACCOUNT DETECTION
    // ========================================================================

    // Find brands with multiple different membership numbers
    const brandsWithMultipleAccounts = derive(
      allMemberships,
      (list: MembershipRecord[]) => {
        const brandNumbers: Record<string, Set<string>> = {};

        for (const m of (list || [])) {
          if (!m) continue; // Skip null/undefined entries during hydration
          if (!brandNumbers[m.hotelBrand]) {
            brandNumbers[m.hotelBrand] = new Set();
          }
          brandNumbers[m.hotelBrand].add(m.membershipNumber);
        }

        const multiAccountBrands: Record<
          string,
          { numbers: string[]; memberships: MembershipRecord[] }
        > = {};

        for (const [brand, numbers] of Object.entries(brandNumbers)) {
          if (numbers.size > 1) {
            multiAccountBrands[brand] = {
              numbers: Array.from(numbers),
              memberships: (list || []).filter((m) =>
                m && m.hotelBrand === brand
              ),
            };
          }
        }

        return multiAccountBrands;
      },
    );

    const hasMultipleAccounts = derive(
      brandsWithMultipleAccounts,
      (brands) => Object.keys(brands).length > 0,
    );

    // ========================================================================
    // AGENT GOAL
    // ========================================================================
    // IMPORTANT: Do NOT derive from memberships! Changing the goal during a scan
    // triggers an infinite loop (goal changes → agent restarts → finds membership
    // → goal changes → agent restarts...). Only derive from scan settings.
    const agentGoal = derive(
      [maxSearches, currentScanMode],
      ([max, scanMode]: [number, ScanMode]) => {
        const isQuickMode = max > 0;
        const isRecentMode = scanMode === "recent";
        const dateFilter = isRecentMode ? getRecentDateFilter() : "";

        return `Find hotel loyalty program membership numbers in my Gmail.

${
          isRecentMode
            ? `📅 RECENT SCAN MODE: Only searching emails from the last 7 days.
Date filter to use: ${dateFilter}
`
            : ""
        }
${
          isQuickMode
            ? `\n⚠️ QUICK TEST MODE: Limited to ${max} searches. Focus on high-value queries!\n`
            : ""
        }

Your task:
1. Use searchGmail to search for hotel loyalty emails${
          isRecentMode ? ` (ADD "${dateFilter}" to ALL queries!)` : ""
        }
2. Analyze the returned emails for membership numbers
3. When you find a membership: IMMEDIATELY call reportMembership to save it
4. Move on to the next brand after 1-2 queries per brand

${
          isQuickMode
            ? "PRIORITY QUERIES (use these first in quick mode):"
            : "EFFECTIVE QUERIES (proven to find memberships):"
        }
${
          EFFECTIVE_QUERIES.slice(0, isQuickMode ? 5 : EFFECTIVE_QUERIES.length)
            .map((q, i) => {
              const query = isRecentMode ? `(${q}) ${dateFilter}` : q;
              return `${i + 1}. ${query}`;
            }).join("\n")
        }

Hotel brands to search for:
${
          ALL_BRANDS.map((b) => {
            switch (b) {
              case "Marriott":
                return "- Marriott (Marriott Bonvoy)";
              case "Hilton":
                return "- Hilton (Hilton Honors)";
              case "Hyatt":
                return "- Hyatt (World of Hyatt)";
              case "IHG":
                return "- IHG (IHG One Rewards)";
              case "Accor":
                return "- Accor (ALL - Accor Live Limitless)";
              default:
                return "- " + b;
            }
          }).join("\n")
        }

In email bodies, look for patterns like:
- "Member #" or "Membership Number:" followed by digits
- "Bonvoy Number:", "Hilton Honors #:", "World of Hyatt #:"
- Account numbers are typically 9-16 digits

When you find a membership, call reportMembership with:
- hotelBrand: Hotel chain name (e.g., "Marriott", "Hilton")
- programName: Loyalty program name (e.g., "Marriott Bonvoy", "Hilton Honors")
- membershipNumber: The actual number (digits only, no spaces)
- tier: Status tier if mentioned (Member, Silver, Gold, Platinum, Diamond)
- sourceEmailId: The email ID from searchGmail results
- sourceEmailSubject: The email subject
- sourceEmailDate: The email date
- confidence: 0-100 how confident you are

IMPORTANT: Call reportMembership for EACH membership as you find it. Don't wait!
${
          isRecentMode
            ? "\nIMPORTANT: ALWAYS include the date filter in your search queries!"
            : ""
        }
${
          isQuickMode
            ? "\nNote: If you hit the search limit, stop and return what you found."
            : ""
        }

⚠️ STOPPING RULES - FOLLOW THESE STRICTLY:
- Search each brand with AT MOST 2 queries, then move to the next brand
- After checking all ${ALL_BRANDS.length} brands (${
          ALL_BRANDS.join(", ")
        }), STOP and return your summary
- Do NOT keep searching the same brand with variations
- Do NOT search more than ~${
          ALL_BRANDS.length * 2
        } total queries (2 per brand max)
- If a brand has no results after 1-2 tries, move on - don't keep trying
- When you've covered all brands, IMMEDIATELY produce your final summary

YOUR FINAL OUTPUT should summarize: which brands you searched, how many memberships found, and any issues.`;
      },
    );

    // ========================================================================
    // SHARED SIGNAL CELL (for foundItems feature)
    // ========================================================================
    // Create signal cell HERE and pass to base pattern - both share same cell
    // This follows the "share cells by making them inputs" pattern
    // See: community-docs/superstitions/2025-12-04-share-cells-between-composed-patterns.md
    const itemFoundSignal = Writable.of<number>(0);
    // Track last membership count in a Writable (closure vars don't persist in derive)
    const lastMembershipCountCell = Writable.of<number>(0);

    // ========================================================================
    // CREATE BASE SEARCHER
    // ========================================================================
    const searcher = GmailAgenticSearch({
      agentGoal,
      systemPrompt: `You are a hotel loyalty membership extractor.
Your job: Search Gmail to find hotel loyalty program membership numbers.

You have TWO tools:
1. searchGmail({ query: string }) - Search Gmail and return matching emails
2. reportMembership({ hotelBrand, programName, membershipNumber, tier?, sourceEmailId, sourceEmailSubject, sourceEmailDate, confidence }) - SAVE a found membership

WORKFLOW - Follow this order:
1. Search for emails from ONE hotel brand (1-2 queries max per brand)
2. Read the email bodies for membership numbers
3. When you find a membership: IMMEDIATELY call reportMembership
4. Move to the NEXT brand (don't keep searching the same brand)
5. After all brands checked: STOP and produce your final summary

CRITICAL STOPPING RULES:
- Maximum 2 searches per brand, then move on
- After checking all brands once, you are DONE
- Do NOT try variations of the same search
- Do NOT search indefinitely
- When finished, produce your final structured output IMMEDIATELY

Report memberships as you find them. Don't wait until the end.`,
      suggestedQueries: EFFECTIVE_QUERIES,
      resultSchema: HOTEL_RESULT_SCHEMA,
      additionalTools: {
        reportMembership: {
          description:
            "Report a found membership number. Call this IMMEDIATELY when you find a valid membership number. It will be saved automatically.",
          handler: reportMembership, // Already bound - no second call needed!
        },
      },
      title: "🏨 Hotel Membership Extractor",
      scanButtonLabel: "🔍 Scan for Memberships",
      maxSearches,
      isScanning,
      lastScanAt,
      searchProgress, // Shared cell for coordinating progress UI
      accountType, // Multi-account support: passes through to reactive wish
      // Community query sharing
      // Note: Using hardcoded URL since import.meta.url not supported in CT compiler
      agentTypeUrl:
        "https://raw.githubusercontent.com/anthropics/community-patterns/main/patterns/jkomoros/hotel-membership-gmail-agent.tsx",
      enableCommunityQueries: true, // Enable fetching/upvoting community queries
      // Only show queries in "My Saved Queries" that actually found memberships
      onlySaveQueriesWithItems: true,
      // Pass shared signal cell - base pattern watches this
      itemFoundSignal,
    });

    // ========================================================================
    // WATCH MEMBERSHIPS TO MARK QUERIES AS EFFECTIVE
    // ========================================================================
    // When reportMembership successfully adds a membership, signal the base pattern.
    // This is the idiomatic pattern: tool writes to state cell, parent watches and increments signal.
    // See: community-docs research on tool-to-parent communication patterns
    // NOTE: Using Cells to track state because closure vars don't persist across derive executions
    derive(
      [memberships, lastMembershipCountCell],
      ([list, _lastCountRef]: [MembershipRecord[], number]) => {
        // NOTE: derive doesn't unwrap locally-created cells, only pattern input cells
        // So we use .get() to read the actual value
        // See: community-docs/superstitions/2025-12-08-locally-created-cells-not-unwrapped-in-derive.md
        const currentCount = list?.length || 0;
        const lastCount = lastMembershipCountCell.get() || 0;
        if (currentCount > lastCount) {
          // New membership was added - signal the base pattern to mark the query
          if (DEBUG_HOTEL) {
            console.log(
              `[HotelMembership] New membership detected (${lastCount} -> ${currentCount}), signaling itemFoundSignal`,
            );
          }
          // Increment the signal - base pattern watches this and marks the query
          const currentSignal = itemFoundSignal.get() || 0;
          itemFoundSignal.set(currentSignal + 1);
          // Update last count cell - prevents this derive from running again with same condition
          lastMembershipCountCell.set(currentCount);
        }
      },
    );

    // ========================================================================
    // CUSTOM SCAN HANDLERS (with mode support)
    // ========================================================================

    // Bind handlers for each mode (startScan is defined at module scope)
    // Full Scan: all time, unlimited searches
    const startFullScan = startScan({
      mode: "full",
      searchLimit: 0, // Unlimited
      currentScanMode,
      maxSearches,
      isScanning,
      searchProgress,
    });

    // Recent Scan: last 7 days, limited searches (quick check)
    const startRecentScan = startScan({
      mode: "recent",
      searchLimit: 5, // Quick check
      currentScanMode,
      maxSearches,
      isScanning,
      searchProgress,
    });

    // ========================================================================
    // DERIVED VALUES
    // ========================================================================
    // Use allMemberships (local + imported) for display
    const totalMemberships = derive(
      allMemberships,
      (list) => list?.length || 0,
    );

    // Pre-compute button label (outside ifElse to avoid reactive loops)
    const fullScanLabel = derive(
      maxSearches,
      (max) => max > 0 ? "⚡ Quick Scan" : "🔍 Full Scan",
    );

    // Pre-compute scan mode message
    const scanModeMessage = derive(
      currentScanMode,
      (mode: ScanMode) =>
        mode === "recent"
          ? "📅 Recent mode: searching last 7 days only"
          : "🔍 Full mode: searching all emails",
    );

    // Pre-compute scan mode short label for debug
    const scanModeLabel = derive(
      currentScanMode,
      (mode: ScanMode) => mode === "recent" ? "📅 Recent" : "🔍 Full",
    );

    // Pre-compute button disabled state (just scanning for now - simpler)
    // Auth check is handled by showing auth UI first
    const buttonsDisabled = derive(isScanning, (scanning: boolean) => scanning);

    const groupedMemberships = derive(
      allMemberships,
      (list: MembershipRecord[]) => {
        const groups: Record<string, MembershipRecord[]> = {};
        if (!list) return groups;
        for (const m of list) {
          if (!m) continue; // Skip null/undefined entries during hydration
          if (!groups[m.hotelBrand]) groups[m.hotelBrand] = [];
          groups[m.hotelBrand].push(m);
        }
        return groups;
      },
    );

    // ========================================================================
    // UI - Compose base searcher with custom membership display
    // ========================================================================

    return {
      [NAME]: "🏨 Hotel Membership Extractor",

      // Output: Export memberships for wish("#hotelMemberships")
      memberships,
      lastScanAt,
      count: totalMemberships,

      [UI]: (
        <ct-screen>
          {/* WORKAROUND (CT-1090): Wish import disabled - see superstition about self-referential wish loops */}

          <div slot="header">
            <h2 style={{ margin: "0", fontSize: "18px" }}>Hotel Memberships</h2>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack style="padding: 16px; gap: 16px;">
              {/* Auth UI from base pattern */}
              {searcher.ui.auth}

              {/* Scan Mode Selection - Only show when authenticated */}
              {ifElse(
                searcher.isAuthenticated,
                <div
                  style={{
                    padding: "16px",
                    background: "#f8fafc",
                    borderRadius: "8px",
                    border: "1px solid #e2e8f0",
                  }}
                >
                  <div
                    style={{
                      fontSize: "14px",
                      fontWeight: "600",
                      marginBottom: "12px",
                      color: "#475569",
                    }}
                  >
                    Scan Mode
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <ct-button
                      onClick={startFullScan}
                      size="lg"
                      style="flex: 1;"
                      disabled={buttonsDisabled}
                    >
                      {fullScanLabel}
                    </ct-button>
                    <ct-button
                      onClick={startRecentScan}
                      variant="secondary"
                      size="lg"
                      style="flex: 1;"
                      disabled={buttonsDisabled}
                    >
                      📅 Check Recent
                    </ct-button>
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      marginTop: "8px",
                      textAlign: "center",
                    }}
                  >
                    Full = all emails • Recent = last 7 days only
                  </div>
                </div>,
                null,
              )}

              {/* Stop button when scanning */}
              {ifElse(
                isScanning,
                <ct-button
                  onClick={searcher.stopScan}
                  variant="secondary"
                  size="lg"
                  style="width: 100%;"
                >
                  ⏹ Stop Scan
                </ct-button>,
                null,
              )}

              {/* Scan mode indicator during scan */}
              {ifElse(
                isScanning,
                <div
                  style={{
                    padding: "8px 12px",
                    background: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                    borderRadius: "6px",
                    fontSize: "13px",
                    color: "#166534",
                    textAlign: "center",
                  }}
                >
                  {scanModeMessage}
                </div>,
                null,
              )}

              {/* Progress UI from base pattern */}
              {searcher.ui.progress}

              {/* Stats */}
              <div style={{ fontSize: "13px", color: "#666" }}>
                <div>Total Memberships: {totalMemberships}</div>
              </div>

              {/* Multi-Account Warning */}
              {derive(
                [hasMultipleAccounts, brandsWithMultipleAccounts],
                ([hasMulti, multiBrands]) =>
                  hasMulti
                    ? (
                      <div
                        style={{
                          padding: "16px",
                          background: "#fffbeb",
                          border: "1px solid #fde68a",
                          borderRadius: "8px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "14px",
                            fontWeight: "600",
                            color: "#92400e",
                            marginBottom: "8px",
                          }}
                        >
                          Multiple Accounts Detected
                        </div>
                        <div style={{ fontSize: "13px", color: "#78350f" }}>
                          {Object.entries(multiBrands).map((
                            [brand, data],
                            brandIdx,
                          ) => (
                            <div
                              key={brandIdx}
                              style={{
                                marginBottom: "8px",
                                padding: "8px",
                                background: "white",
                                borderRadius: "4px",
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: "600",
                                  marginBottom: "4px",
                                }}
                              >
                                {brand}
                              </div>
                              <div style={{ fontSize: "12px", color: "#666" }}>
                                Found {data.numbers.length}{" "}
                                different membership numbers:
                                <ul
                                  style={{
                                    margin: "4px 0 0 16px",
                                    padding: "0",
                                  }}
                                >
                                  {data.numbers.map(
                                    (num: string, i: number) => {
                                      const membership = data.memberships.find((
                                        m: MembershipRecord,
                                      ) => m.membershipNumber === num);
                                      return (
                                        <li
                                          key={i}
                                          style={{ marginBottom: "2px" }}
                                        >
                                          <code
                                            style={{
                                              background: "#f3f4f6",
                                              padding: "2px 6px",
                                              borderRadius: "2px",
                                            }}
                                          >
                                            {num}
                                          </code>
                                          {membership?.tier && (
                                            <span style={{ marginLeft: "4px" }}>
                                              ({membership.tier})
                                            </span>
                                          )}
                                        </li>
                                      );
                                    },
                                  )}
                                </ul>
                              </div>
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "#92400e",
                                  marginTop: "4px",
                                  fontStyle: "italic",
                                }}
                              >
                                This could be: old vs new account, family
                                member, or work vs personal
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                    : null,
              )}

              {/* Memberships List - Hotel-specific UI */}
              <div>
                <h3 style={{ margin: "0 0 12px 0", fontSize: "15px" }}>
                  Your Memberships
                </h3>
                {derive(groupedMemberships, (groups) => {
                  const brands = Object.keys(groups).sort();
                  if (brands.length === 0) {
                    return (
                      <div
                        style={{
                          padding: "24px",
                          textAlign: "center",
                          color: "#999",
                        }}
                      >
                        No memberships found yet. Click "Scan" to search your
                        emails.
                      </div>
                    );
                  }

                  return brands.map((brand) => (
                    <details
                      open
                      style={{
                        border: "1px solid #e0e0e0",
                        borderRadius: "8px",
                        marginBottom: "12px",
                        padding: "12px",
                      }}
                    >
                      <summary
                        style={{
                          cursor: "pointer",
                          fontWeight: "600",
                          fontSize: "14px",
                          marginBottom: "8px",
                        }}
                      >
                        {brand || "Unknown Brand"} ({groups[brand].length})
                      </summary>
                      <ct-vstack gap={2} style="paddingLeft: 16px;">
                        {groups[brand].map((m: MembershipRecord) => (
                          <div
                            style={{
                              padding: "8px",
                              background: (m as any)._fromWish
                                ? "#e0f2fe"
                                : "#f8f9fa",
                              borderRadius: "4px",
                              border: (m as any)._fromWish
                                ? "1px dashed #0ea5e9"
                                : "none",
                            }}
                          >
                            <div
                              style={{
                                fontWeight: "600",
                                fontSize: "13px",
                                marginBottom: "4px",
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                              }}
                            >
                              {m.programName}
                              {(m as any)._fromWish && (
                                <span
                                  style={{
                                    fontSize: "10px",
                                    background: "#0ea5e9",
                                    color: "white",
                                    padding: "2px 6px",
                                    borderRadius: "10px",
                                  }}
                                >
                                  imported
                                </span>
                              )}
                            </div>
                            <div style={{ marginBottom: "4px" }}>
                              <code
                                style={{
                                  fontSize: "14px",
                                  background: "white",
                                  padding: "6px 12px",
                                  borderRadius: "4px",
                                  display: "inline-block",
                                }}
                              >
                                {m.membershipNumber}
                              </code>
                            </div>
                            {m.tier && (
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "#666",
                                  marginBottom: "2px",
                                }}
                              >
                                ⭐ {m.tier}
                              </div>
                            )}
                            <div style={{ fontSize: "11px", color: "#999" }}>
                              📧 {m.sourceEmailSubject || "Unknown email"} •
                              {" "}
                              {m.sourceEmailDate
                                ? new Date(m.sourceEmailDate)
                                  .toLocaleDateString()
                                : "Unknown date"}
                            </div>
                          </div>
                        ))}
                      </ct-vstack>
                    </details>
                  ));
                })}
              </div>

              {/* Agent Activity Log - from base searcher */}
              {searcher.ui.extras}

              {/* Debug Info */}
              <details style={{ marginTop: "16px" }}>
                <summary
                  style={{
                    cursor: "pointer",
                    padding: "8px",
                    background: "#f8f9fa",
                    border: "1px solid #e0e0e0",
                    borderRadius: "4px",
                    fontSize: "12px",
                  }}
                >
                  🔧 Debug Info
                </summary>
                <ct-vstack gap={2} style="padding: 12px; fontSize: 12px;">
                  <div style={{ fontFamily: "monospace" }}>
                    Is Authenticated: {derive(
                      searcher.isAuthenticated,
                      (a) => a ? "Yes ✓" : "No",
                    )}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    Auth Source: {searcher.authSource}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    Is Scanning:{" "}
                    {derive(searcher.isScanning, (s) => (s ? "Yes ⏳" : "No"))}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    Scan Mode: {scanModeLabel}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    Agent Pending: {derive(
                      searcher.agentPending,
                      (p) => p ? "Yes ⏳" : "No ✓",
                    )}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    Agent Result:{" "}
                    {derive(searcher.agentResult, (r) => r ? "Yes ✓" : "No")}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    Max Searches: {maxSearches}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    Local Memberships: {localMembershipCount}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    Has Multiple Accounts:{" "}
                    {derive(hasMultipleAccounts, (h) => h ? "Yes ⚠️" : "No")}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    Pending Submissions: {derive(
                      searcher.pendingSubmissions,
                      (p) => (p || []).length,
                    )}
                  </div>
                </ct-vstack>
              </details>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);

export default HotelMembershipExtractorV2;
