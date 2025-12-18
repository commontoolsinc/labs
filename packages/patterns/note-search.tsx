/// <cts-enable />
import {
  Cell,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  UI,
  wish,
} from "commontools";

import RegexSearch, { type NoteCharm } from "./note-search-regex.tsx";
import SemanticSearch from "./note-search-semantic.tsx";

type Input = void;

type Output = {
  query: string;
  isRegexMode: boolean;
  debugMode: boolean;
};

// Toggle debug mode
const toggleDebug = handler<
  void,
  { debugMode: Cell<boolean> }
>((_, { debugMode }) => {
  debugMode.set(!debugMode.get());
});

/**
 * NoteSearch - Search all notes in a space using either:
 * - Regex mode: /pattern/ syntax for direct text matching
 * - Semantic mode: Natural language queries evaluated by LLM
 *
 * Composes note-search-regex and note-search-semantic patterns.
 * Uses wish("/") to automatically get allCharms from the space.
 */
export default pattern<Input, Output>((_) => {
  // Get allCharms automatically from the space
  const { allCharms } = wish<{ allCharms: NoteCharm[] }>("/");
  // ===================
  // CORE STATE
  // ===================
  const query = Cell.of("");
  const debugMode = Cell.of(false);

  // ===================
  // QUERY ANALYSIS (using lift for proper reactivity)
  // ===================
  const isRegexMode = lift((q: string) => {
    const trimmed = (q ?? "").trim();
    return trimmed.length >= 2 && trimmed.startsWith("/") &&
      trimmed.endsWith("/");
  })(query);

  const isSemanticMode = lift((q: string) => {
    const trimmed = (q ?? "").trim();
    const isRegex = trimmed.length >= 2 && trimmed.startsWith("/") &&
      trimmed.endsWith("/");
    return trimmed.length > 0 && !isRegex;
  })(query);

  const regexPattern = lift((q: string) => {
    const trimmed = (q ?? "").trim();
    const isRegex = trimmed.length >= 2 && trimmed.startsWith("/") &&
      trimmed.endsWith("/");
    if (!isRegex) return "";
    return trimmed.slice(1, -1); // Remove surrounding slashes
  })(query);

  // ===================
  // NOTES FILTERING
  // ===================
  const allCharmsCount = lift((charms: NoteCharm[]) => (charms ?? []).length)(
    allCharms,
  );

  // Filter to only notes (charms with content or title)
  const notesOnly = lift((charms: NoteCharm[]) => {
    return (charms ?? []).filter(
      (charm: NoteCharm) =>
        charm?.content !== undefined || charm?.title !== undefined,
    );
  })(allCharms);
  const notesCount = lift((notes: NoteCharm[]) => notes.length)(notesOnly);

  // ===================
  // COMPOSED SEARCH PATTERNS
  // ===================
  const regexSearch = RegexSearch({
    notes: notesOnly,
    regexPattern: regexPattern,
  });

  const semanticSearch = SemanticSearch({
    notes: notesOnly,
    query: query,
  });

  // ===================
  // UI
  // ===================
  return {
    [NAME]: "Note Search",
    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-hstack gap={2} style="align-items: center;">
            <h2 style={{ margin: 0 }}>Note Search</h2>
            <ct-button onClick={toggleDebug({ debugMode })}>
              {ifElse(debugMode, "Hide Debug", "Show Debug")}
            </ct-button>
          </ct-hstack>
        </div>

        <ct-vstack gap={2}>
          {/* Search Input */}
          <ct-card>
            <ct-vstack gap={1}>
              <ct-input
                $value={query}
                placeholder="Search notes... (use /regex/ for pattern matching)"
              />
              <div style={{ fontSize: "0.85em", color: "#666" }}>
                {ifElse(
                  isRegexMode,
                  <span>🔍 Regex mode - pattern: {regexPattern}</span>,
                  ifElse(
                    isSemanticMode,
                    <span>🤖 Semantic mode - AI-powered search</span>,
                    <span>Type to search...</span>,
                  ),
                )}
              </div>
            </ct-vstack>
          </ct-card>

          {/* Debug Panel */}
          {ifElse(
            debugMode,
            <ct-card>
              <ct-vstack gap={1}>
                <strong>🐛 Debug Info</strong>
                <div
                  style={{
                    fontSize: "0.8em",
                    fontFamily: "monospace",
                    background: "#f5f5f5",
                    padding: "8px",
                    borderRadius: "4px",
                  }}
                >
                  <div>query: "{query}"</div>
                  <div>isRegexMode: {ifElse(isRegexMode, "true", "false")}</div>
                  <div>
                    isSemanticMode: {ifElse(isSemanticMode, "true", "false")}
                  </div>
                  <div>regexPattern: "{regexPattern}"</div>
                  <div>---</div>
                  <div>allCharmsCount: {allCharmsCount}</div>
                  <div>notesCount: {notesCount}</div>
                  <div>---</div>
                  <div>regexMatchCount: {regexSearch.matchCount}</div>
                  <div>semanticMatchCount: {semanticSearch.matchCount}</div>
                  <div>semanticPendingCount: {semanticSearch.pendingCount}</div>
                </div>
              </ct-vstack>
            </ct-card>,
            null,
          )}

          {/* Regex Results */}
          {ifElse(
            isRegexMode,
            <ct-vstack gap={1}>
              <div style={{ fontSize: "0.9em", color: "#666", padding: "4px" }}>
                Regex Results ({regexSearch.matchCount} matches)
              </div>
              <ct-render $cell={regexSearch} />
            </ct-vstack>,
            null,
          )}

          {/* Semantic Results */}
          {ifElse(
            isSemanticMode,
            <ct-vstack gap={1}>
              <div style={{ fontSize: "0.9em", color: "#666", padding: "4px" }}>
                Semantic Results ({semanticSearch.matchCount} matches,{" "}
                {semanticSearch.pendingCount} pending)
              </div>
              <ct-render $cell={semanticSearch} />
            </ct-vstack>,
            null,
          )}

          {/* Footer */}
          <ct-card>
            <div style={{ fontSize: "0.85em", color: "#888" }}>
              Found {notesCount} notes in space (from {allCharmsCount}{" "}
              total charms)
            </div>
          </ct-card>
        </ct-vstack>
      </ct-screen>
    ),
    query,
    isRegexMode,
    debugMode,
  };
});
