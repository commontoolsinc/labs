/// <cts-enable />
import {
  Cell,
  Default,
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

type Input = {
  /** Notes to search through */
  notes: Default<NoteCharm[], []>;
  /** Regex pattern (without surrounding slashes) */
  regexPattern: Default<string, "">;
};

type Output = {
  /** Count of matches */
  matchCount: number;
};

/**
 * RegexNoteSearch - Searches notes using regex pattern matching.
 *
 * Uses .map() on the input notes array to evaluate each note against the pattern.
 * This ensures proper reactivity since .map() only works on input arrays.
 */
export default pattern<Input, Output>(({ notes, regexPattern }) => {
  // Compute match count using a single lift on the notes array
  const matchCount = lift(({ ns, pat }: { ns: NoteCharm[]; pat: string }) => {
    const pattern = (pat ?? "").trim();
    if (!pattern || !ns) return 0;
    try {
      const regex = new RegExp(pattern, "i");
      return ns.filter((n) => {
        const content = n?.content ?? "";
        const title = n?.title ?? n?.[NAME] ?? "";
        return regex.test(content) || regex.test(title);
      }).length;
    } catch {
      return 0;
    }
  })({ ns: notes, pat: regexPattern });

  // Map over input notes to evaluate each one for display
  const evaluations = notes.map((note: OpaqueRef<NoteCharm>) => {
    // Check if this note matches the regex
    const matches = lift(({ n, pat }: { n: NoteCharm; pat: string }) => {
      const pattern = (pat ?? "").trim();
      if (!pattern) return false;

      try {
        const regex = new RegExp(pattern, "i");
        const content = n?.content ?? "";
        const title = n?.title ?? n?.[NAME] ?? "";
        return regex.test(content) || regex.test(title);
      } catch {
        return false;
      }
    })({ n: note, pat: regexPattern });

    // Get note title
    const noteTitle = lift((n: NoteCharm) =>
      n?.title ?? n?.[NAME] ?? "Untitled"
    )(note);

    // Generate snippet
    const snippet = lift(({ n, pat }: { n: NoteCharm; pat: string }) => {
      const pattern = (pat ?? "").trim();
      const content = n?.content ?? "";
      if (!pattern || !content) {
        return content.slice(0, 100) + (content.length > 100 ? "..." : "");
      }

      try {
        const regex = new RegExp(pattern, "i");
        const match = content.match(regex);
        if (match && match.index !== undefined) {
          const start = Math.max(0, match.index - 30);
          const end = Math.min(
            content.length,
            match.index + match[0].length + 30,
          );
          let s = content.slice(start, end);
          if (start > 0) s = "..." + s;
          if (end < content.length) s = s + "...";
          return s;
        }
      } catch {
        // Invalid regex
      }
      return content.slice(0, 100) + (content.length > 100 ? "..." : "");
    })({ n: note, pat: regexPattern });

    // Handler to navigate to this note
    const goToNote = handler<void, { n: Cell<NoteCharm> }>(
      (_, { n }) => {
        return navigateTo(n);
      },
      { proxy: true },
    )({ n: note });

    return { note, matches, noteTitle, snippet, goToNote };
  });

  return {
    [NAME]: "Regex Note Search",
    [UI]: (
      <ct-vstack gap={1}>
        {evaluations.map((ev) => (
          <div>
            {ifElse(
              ev.matches,
              <ct-card style={{ cursor: "pointer" }} onClick={ev.goToNote}>
                <ct-vstack gap={1}>
                  <strong>{ev.noteTitle}</strong>
                  <div style={{ fontSize: "0.9em", color: "#555" }}>
                    {ev.snippet}
                  </div>
                </ct-vstack>
              </ct-card>,
              null,
            )}
          </div>
        ))}
        {ifElse(
          lift((c: number) => c === 0)(matchCount),
          <div style={{ color: "#888", padding: "8px" }}>No matches found</div>,
          null,
        )}
      </ct-vstack>
    ),
    matchCount,
  };
});
