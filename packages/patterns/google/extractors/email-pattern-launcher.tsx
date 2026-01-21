/// <cts-enable />
/**
 * Email Pattern Launcher
 *
 * Automatically discovers and launches relevant email-based patterns
 * based on incoming Gmail messages.
 *
 * Flow:
 * 1. Fetches pattern registry JSON (maps email addresses to patterns)
 * 2. Builds Gmail query from all registered email patterns
 * 3. Uses GmailImporter to fetch matching emails
 * 4. Matches emails to patterns by 'from' address
 * 5. Launches each matched pattern via fetchAndRunPattern
 * 6. Renders pattern previews with navigation links
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth email-pattern-launcher/linkedAuth
 */
import {
  //compileAndRun,
  computed,
  derive,
  fetchData,
  //fetchProgram,
  NAME,
  navigateTo,
  pattern,
  UI,
  when,
} from "commontools";
import GmailExtractor, {
  type Auth,
} from "../building-blocks/gmail-extractor.tsx";

import USPSInformedDeliveryPattern from "./usps-informed-delivery.tsx";
import BerkeleyLibraryPattern from "./berkeley-library.tsx";
import ChaseBillPattern from "./chase-bill-tracker.tsx";
import BAMSchoolDashboardPattern from "./bam-school-dashboard.tsx";
import BofABillTrackerPattern from "./bofa-bill-tracker.tsx";
import EmailTicketFinderPattern from "./email-ticket-finder.tsx";
import CalendarChangeDetectorPattern from "./calendar-change-detector.tsx";
import EmailNotesPattern from "./email-notes.tsx";
import UnitedFlightTrackerPattern from "./united-flight-tracker.tsx";

const PATTERNS: any = {
  "google/extractors/usps-informed-delivery.tsx": USPSInformedDeliveryPattern,
  "google/extractors/berkeley-library.tsx": BerkeleyLibraryPattern,
  "google/extractors/chase-bill-tracker.tsx": ChaseBillPattern,
  "google/extractors/bam-school-dashboard.tsx": BAMSchoolDashboardPattern,
  "google/extractors/bofa-bill-tracker.tsx": BofABillTrackerPattern,
  "google/extractors/email-ticket-finder.tsx": EmailTicketFinderPattern,
  "google/extractors/calendar-change-detector.tsx":
    CalendarChangeDetectorPattern,
  "google/extractors/email-notes.tsx": EmailNotesPattern,
  "google/extractors/united-flight-tracker.tsx": UnitedFlightTrackerPattern,
};

// =============================================================================
// TYPES
// =============================================================================

/** Registry entry mapping a pattern to email address patterns */
interface RegistryEntry {
  /** Path to the pattern file (relative to /api/patterns/) */
  patternUri: string;
  /** Glob-style email patterns (e.g., "*@usps.com") */
  emailPatterns: string[];
}

/** Info about a pattern that matched emails */
interface PatternMatchInfo {
  /** Path to the pattern file */
  patternUri: string;
  /** The full registry entry */
  entry: RegistryEntry;
  /** Email addresses that triggered this pattern */
  matchedEmails: string[];
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Check if an email address matches a glob pattern.
 * Supports wildcards: "*@domain.com" matches any email at that domain.
 */
function matchesEmailPattern(email: string, pattern: string): boolean {
  if (!email || !pattern) return false;

  const emailLower = email.toLowerCase();
  const patternLower = pattern.toLowerCase();

  // Convert glob pattern to regex
  // * matches anything before @, and @ and . are literal
  const regexPattern = patternLower
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special regex chars except *
    .replace(/\*/g, ".*"); // Convert * to .*

  const regex = new RegExp(`${regexPattern}$`, "i");
  return regex.test(emailLower);
}

/**
 * Build Gmail query from email patterns.
 */
function buildGmailQuery(entries: RegistryEntry[]): string { // Build "from:@domain1 OR from:@domain2 ..." query
  const parts = entries.filter(Boolean).flatMap((entry) =>
    entry.emailPatterns.filter(Boolean).map((pattern) => `from:${pattern}`)
  );
  return parts.join(" OR ");
}

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  // Optional: Link auth directly from a Google Auth charm
  // Use: ct charm link googleAuthCharm/auth emailPatternLauncher/linkedAuth
  linkedAuth?: Auth;
}

/** Email pattern launcher that discovers and runs relevant patterns. #emailPatternLauncher */
interface PatternOutput {
  matchedPatterns: unknown[];
  emailCount: number;
  matchCount: number;
  previewUI: unknown;
}

export default pattern<PatternInput, PatternOutput>(({ linkedAuth }) => {
  // ==========================================================================
  // FETCH REGISTRY
  // ==========================================================================

  const registryFetch = fetchData<RegistryEntry[]>({
    url: "/api/patterns/google/extractors/email-pattern-registry.json",
    mode: "json",
  });

  const registry = computed<RegistryEntry[]>(() => registryFetch.result || []);
  const registryError = computed(() => registryFetch.error);
  const registryLoading = computed(() => registryFetch.pending);

  // ==========================================================================
  // BUILD GMAIL QUERY AND FETCH EMAILS
  // ==========================================================================

  // Build combined Gmail query from all registry patterns
  const gmailQuery = computed(() => {
    const entries = registry;
    if (!entries || entries.length === 0) return "";
    return buildGmailQuery(entries);
  });

  // Instantiate GmailExtractor with the combined query (raw mode - no extraction)
  const extractor = GmailExtractor({
    gmailQuery,
    limit: 100,
    linkedAuth,
  });

  const allEmails = extractor.emails;
  const emailCount = extractor.emailCount;

  // ==========================================================================
  // MATCH EMAILS TO PATTERNS
  // ==========================================================================

  // Find which patterns have matching emails - returns array of matches
  const patternMatches = computed<PatternMatchInfo[]>(() => {
    const matchMap = new Map<
      string,
      { entry: RegistryEntry; emails: Set<string> }
    >();

    const entries = registry;
    const emails = allEmails || [] as any[];

    if (!entries || entries.length === 0) return [];

    for (const email of emails) {
      const fromAddress = email?.from;
      if (!fromAddress) continue;

      for (const entry of entries) {
        if (!entry) continue;
        for (const emailPattern of entry.emailPatterns) {
          if (matchesEmailPattern(fromAddress, emailPattern)) {
            const key = entry.patternUri;
            if (!matchMap.has(key)) {
              matchMap.set(key, { entry, emails: new Set() });
            }
            matchMap.get(key)!.emails.add(fromAddress);
            break; // Only match once per entry
          }
        }
      }
    }

    // Convert Map to array
    const results: PatternMatchInfo[] = [];
    for (const [patternUri, { entry, emails }] of matchMap) {
      results.push({
        patternUri,
        entry,
        matchedEmails: Array.from(emails),
      });
    }
    return results;
  });

  const matchCount = computed(() => patternMatches?.length || 0);

  // ==========================================================================
  // LAUNCH MATCHED PATTERNS
  // ==========================================================================

  // Launch each matched pattern - use .map() for reactive pattern instantiation
  const launchedPatterns = patternMatches.map((matchInfo) => {
    /*
    const url = computed(() => `/api/patterns/${matchInfo.patternUri}`);

    // Fetch the pattern program
    const programFetch = fetchProgram({ url });

    // Use computed to safely handle when program is undefined/pending
    // Filter out undefined elements to handle race condition where array proxy
    // pre-allocates with undefined before populating elements
    const compileParams = computed(() => ({
      // Note: Type predicate removed - doesn't work with OpaqueCell types after transformation
      files: (programFetch.result?.files ?? []).filter(
        (f) => f !== undefined && f !== null && typeof f.name === "string",
      ),
      main: programFetch.result?.main ?? "",
      input: { linkedAuth },
    }));

    // Compile and run the pattern
    const compiled = compileAndRun(compileParams);
    */

    const compiled = {
      result: derive(matchInfo.patternUri, (patternUri) => {
        const pattern = PATTERNS[patternUri];
        if (!pattern) return null;
        return pattern({} as any).for(patternUri);
      }),
    };

    return {
      patternUri: matchInfo.patternUri,
      entry: matchInfo.entry,
      matchedEmails: matchInfo.matchedEmails,
      pending: false, /*computed(
        () => programFetch.pending || compiled.pending,
      ),*/
      error: null,
      /* error: computed(
        () => programFetch.error || compiled.error,
      ),*/
      result: compiled.result,
    };
  });

  // Preview UI for compact display
  const previewUI = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 12px",
      }}
    >
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "8px",
          backgroundColor: "#3b82f6",
          color: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: "bold",
          fontSize: "16px",
        }}
      >
        {matchCount}
      </div>
      <div>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>
          Email Patterns
        </div>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          {matchCount} active patterns · {emailCount} emails scanned
        </div>
      </div>
    </div>
  );

  return {
    [NAME]: "Email Pattern Launcher",

    matchedPatterns: launchedPatterns,
    emailCount,
    matchCount,
    previewUI,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-heading level={3}>Email Pattern Launcher</ct-heading>
        </div>

        <ct-vscroll flex showScrollbar>
          <ct-vstack padding="6" gap="4">
            {/* Auth UI from GmailExtractor */}
            {extractor.ui.authStatusUI}

            {/* Status Section */}
            <div
              style={{
                padding: "12px 16px",
                backgroundColor: "#f3f4f6",
                borderRadius: "8px",
              }}
            >
              <div
                style={{ display: "flex", gap: "24px", alignItems: "center" }}
              >
                <div>
                  <div style={{ fontSize: "24px", fontWeight: "bold" }}>
                    {matchCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Active Patterns
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "24px", fontWeight: "bold" }}>
                    {emailCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Emails Scanned
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "24px", fontWeight: "bold" }}>
                    {computed(() => registry.length)}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Registered Patterns
                  </div>
                </div>
              </div>
            </div>

            {/* Fetch Button */}
            <button
              type="button"
              onClick={extractor.refresh}
              style={{
                padding: "10px 16px",
                backgroundColor: "#10b981",
                color: "white",
                border: "none",
                borderRadius: "8px",
                cursor: "pointer",
                fontWeight: "500",
              }}
            >
              Refresh Emails
            </button>

            {/* Registry Error */}
            {when(
              registryError,
              <div
                style={{
                  display: "block",
                  padding: "12px",
                  backgroundColor: "#fee2e2",
                  borderRadius: "8px",
                  color: "#b91c1c",
                }}
              >
                Error loading registry:{" "}
                {computed(() =>
                  console.log("registryError 2", registryError)
                ) &&
                  ""}
                <pre>{JSON.stringify(registryError, null, 2)}</pre>
              </div>,
            )}

            {/* Registry Loading */}
            {registryLoading && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "12px",
                  backgroundColor: "#eff6ff",
                  borderRadius: "8px",
                }}
              >
                <ct-loader size="sm" />
                <span>Loading pattern registry...</span>
              </div>
            )}

            {/* No Matches Message */}
            {computed(() =>
              !registryLoading && emailCount > 0 && matchCount === 0
            ) && (
              <div
                style={{
                  display: "block",
                  padding: "16px",
                  backgroundColor: "#fef3c7",
                  borderRadius: "8px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontWeight: "600", marginBottom: "4px" }}>
                  No Matching Patterns Found
                </div>
                <div style={{ fontSize: "14px", color: "#92400e" }}>
                  Scanned {emailCount}{" "}
                  emails but no registered patterns matched.
                </div>
              </div>
            )}

            {/* Matched Patterns Section */}
            {matchCount > 0 && (
              <div
                style={{
                  display: "block",
                }}
              >
                <h3
                  style={{
                    fontSize: "18px",
                    fontWeight: "600",
                    marginBottom: "12px",
                  }}
                >
                  Active Email Patterns
                </h3>

                <ct-vstack gap="3">
                  {launchedPatterns.map((patternInfo) => (
                    <div
                      style={{
                        padding: "16px",
                        backgroundColor: "#ffffff",
                        borderRadius: "12px",
                        border: "1px solid #e5e7eb",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                      }}
                    >
                      {/* Pattern Header */}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "12px",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: "600", fontSize: "16px" }}>
                            {patternInfo.patternUri}
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280" }}>
                            Matched: {computed(() =>
                              (patternInfo.matchedEmails || []).join(", ")
                            )}
                          </div>
                        </div>

                        {/* Navigate Button */}
                        <button
                          type="button"
                          onClick={() => navigateTo(patternInfo.result)}
                          style={{
                            padding: "8px 16px",
                            backgroundColor: "#3b82f6",
                            color: "white",
                            border: "none",
                            borderRadius: "6px",
                            cursor: "pointer",
                            fontWeight: "500",
                            fontSize: "14px",
                            display: "block",
                          }}
                        >
                          Open
                        </button>
                      </div>

                      {/* Loading State */}
                      {patternInfo.pending && (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "12px",
                            backgroundColor: "#eff6ff",
                            borderRadius: "8px",
                          }}
                        >
                          <ct-loader size="sm" />
                          <span>Loading pattern...</span>
                        </div>
                      )}

                      {/* Error State */}
                      {patternInfo.error && (
                        <div
                          style={{
                            display: "block",
                            padding: "12px",
                            backgroundColor: "#fee2e2",
                            borderRadius: "8px",
                            color: "#b91c1c",
                            fontSize: "14px",
                          }}
                        >
                          Error: {patternInfo.error}
                        </div>
                      )}

                      {/* Preview UI from launched pattern */}
                      {computed(() =>
                        patternInfo.result && !patternInfo.pending &&
                        !patternInfo.error
                      ) && (
                        <div
                          style={{
                            display: "block",
                            marginTop: "8px",
                            padding: "12px",
                            backgroundColor: "#f9fafb",
                            borderRadius: "8px",
                          }}
                        >
                          {/* Render the pattern's previewUI if available */}
                          {
                            /*<ct-render
                            $cell={patternInfo.result}
                            variant="preview"
                          />*/
                          }
                          {patternInfo.result.previewUI}
                        </div>
                      )}
                    </div>
                  ))}
                </ct-vstack>
              </div>
            )}

            {/* Debug: Gmail Query */}
            <details style={{ marginTop: "16px" }}>
              <summary
                style={{
                  cursor: "pointer",
                  fontWeight: "600",
                  fontSize: "14px",
                  color: "#6b7280",
                }}
              >
                Debug Info
              </summary>
              <div
                style={{
                  marginTop: "8px",
                  padding: "12px",
                  backgroundColor: "#f3f4f6",
                  borderRadius: "8px",
                  fontSize: "12px",
                  fontFamily: "monospace",
                }}
              >
                <div>
                  <strong>Gmail Query:</strong>
                </div>
                <div style={{ marginTop: "4px", wordBreak: "break-all" }}>
                  {gmailQuery}
                </div>
                <div style={{ marginTop: "12px" }}>
                  <strong>Registered Patterns:</strong>
                </div>
                {registry.map((entry: RegistryEntry) => (
                  <div style={{ marginTop: "4px" }}>
                    {entry.patternUri}: {entry.emailPatterns.join(", ")}
                  </div>
                ))}
              </div>
            </details>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
  };
});
