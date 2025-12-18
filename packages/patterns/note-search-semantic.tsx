/// <cts-enable />
import {
  Default,
  generateObject,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  OpaqueRef,
  pattern,
  UI,
} from "commontools";

/**
 * Represents a note charm that can be searched.
 */
export type NoteCharm = {
  [NAME]?: string;
  title?: string;
  content?: string;
};

/**
 * LLM evaluation result for semantic matching.
 */
interface MatchResult {
  matches: boolean;
  reason: string;
}

type Input = {
  /** Notes to search through */
  notes: Default<NoteCharm[], []>;
  /** Natural language search query */
  query: Default<string, "">;
};

type Output = {
  /** Count of matches */
  matchCount: number;
  /** Count of pending evaluations */
  pendingCount: number;
};

/**
 * SemanticNoteSearch - Searches notes using LLM-powered semantic matching.
 *
 * Input:
 * - notes: Array of note charms to search
 * - query: Natural language description of what to find
 *
 * Output:
 * - matchCount: Number of matches
 * - pendingCount: Number of evaluations still in progress
 */
export default pattern<Input, Output>(({ notes, query }) => {
  // Count notes with content for stats
  const notesCount = lift((ns: NoteCharm[]) => {
    return (ns ?? []).filter(n => n?.content !== undefined || n?.title !== undefined).length;
  })(notes);

  // Process each note with LLM evaluation
  // Map directly on input notes array
  const evaluations = notes.map((note: OpaqueRef<NoteCharm>) => {
    // Check if this note has content/title (skip if not)
    const hasContent = lift((n: NoteCharm) =>
      n?.content !== undefined || n?.title !== undefined
    )(note);

    const noteTitle = lift((n: NoteCharm) =>
      n?.title ?? n?.[NAME] ?? "Untitled"
    )(note);

    const noteContentPreview = lift((n: NoteCharm) => {
      const content = n?.content ?? "";
      if (!content) return "(no content)";
      if (content.length <= 100) return content;
      return content.slice(0, 100) + "...";
    })(note);

    // Build prompt for LLM - empty string if no query or no content
    const semanticPrompt = lift(({ n, q }: { n: NoteCharm; q: string }) => {
      const trimmed = (q ?? "").trim();
      if (!trimmed) return "";
      // Skip notes without content/title
      if (n?.content === undefined && n?.title === undefined) return "";

      const title = n?.title ?? n?.[NAME] ?? "Untitled";
      const content = n?.content ?? "(empty)";

      return `Search query: "${trimmed}"

Note to evaluate:
Title: ${title}
Content: ${content}

Does this note match the search query? Be generous - if there's any reasonable connection, consider it a match.`;
    })({ n: note, q: query });

    // LLM evaluation - only runs when prompt is non-empty
    const llmResult = generateObject<MatchResult>({
      system: `You are evaluating whether a note matches a search query.
The search query is a natural language description of what the user is looking for.
Return matches: true if the note content is relevant to what the user is searching for.
Return reason: a brief explanation of why it matches (or doesn't).`,
      prompt: semanticPrompt,
    });

    const matches = lift(({ q, pending, error, result, has }: { q: string; pending: boolean; error: unknown; result?: MatchResult; has: boolean }) => {
      if (!has) return false; // Skip notes without content
      const trimmed = (q ?? "").trim();
      if (!trimmed) return false;
      if (pending) return false;
      if (error) return false;
      return result?.matches === true;
    })({ q: query, pending: llmResult.pending, error: llmResult.error, result: llmResult.result, has: hasContent });

    const pending = lift(({ q, p, has }: { q: string; p: boolean; has: boolean }) => {
      if (!has) return false; // Skip notes without content
      const trimmed = (q ?? "").trim();
      return trimmed.length > 0 && p;
    })({ q: query, p: llmResult.pending, has: hasContent });

    const reason = lift(({ result }: { result?: MatchResult }) =>
      result?.reason ?? ""
    )({ result: llmResult.result });

    // Combined state for simpler rendering
    const showPending = lift(({ has, pend }: { has: boolean; pend: boolean }) =>
      has && pend
    )({ has: hasContent, pend: pending });

    const showMatch = lift(({ has, pend, match }: { has: boolean; pend: boolean; match: boolean }) =>
      has && !pend && match
    )({ has: hasContent, pend: pending, match: matches });

    // Handler to navigate to this note
    const goToNote = handler<void, { n: OpaqueRef<NoteCharm> }>((_, { n }) => {
      navigateTo(n);
    })({ n: note });

    return {
      note,
      noteTitle,
      noteContentPreview,
      showPending,
      showMatch,
      reason,
      goToNote,
    };
  });

  // Placeholder counts - actual counts come from UI rendering
  const matchCount = notesCount;
  const pendingCount = lift(() => 0)(notes);

  return {
    [NAME]: "Semantic Note Search",
    [UI]: (
      <ct-vstack gap={1}>
        {evaluations.map((ev) => (
          <div>
            {ifElse(
              ev.showPending,
              <ct-card>
                <ct-hstack gap={1}>
                  <ct-loader size="sm" />
                  <span>Evaluating: {ev.noteTitle}</span>
                </ct-hstack>
              </ct-card>,
              null,
            )}
            {ifElse(
              ev.showMatch,
              <ct-card style={{ cursor: "pointer" }} onClick={ev.goToNote}>
                <ct-vstack gap={1}>
                  <strong>{ev.noteTitle}</strong>
                  <div style={{ fontSize: "0.9em", color: "#555" }}>
                    {ev.noteContentPreview}
                  </div>
                  <div style={{ fontSize: "0.8em", color: "#888", fontStyle: "italic" }}>
                    {ev.reason}
                  </div>
                </ct-vstack>
              </ct-card>,
              null,
            )}
          </div>
        ))}
      </ct-vstack>
    ),
    matchCount,
    pendingCount,
  };
});
