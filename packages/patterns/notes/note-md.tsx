/// <cts-enable />
import {
  computed,
  type Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";

// Type for backlinks (same as note.tsx)
type MentionablePiece = {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionablePiece[];
  backlinks: MentionablePiece[];
};

// Handler for clicking a backlink chip - must be at module scope
const handleBacklinkClick = (piece: MentionablePiece) => {
  return navigateTo(piece as any);
};

// Handler for Edit button - go back to note editor (module scope)
const goToEdit = handler<void, { sourceNote: any }>((_ev, { sourceNote }) => {
  console.log("goToEdit called, sourceNote:", sourceNote);
  if (sourceNote) {
    return navigateTo(sourceNote);
  } else {
    console.log("sourceNote is null/undefined, cannot navigate");
  }
});

// Handler for checkbox toggle in markdown
// Uses properly typed Writable<string> for content updates
const handleCheckboxToggle = handler<
  { detail: { index: number; checked: boolean } },
  { content: Writable<string> }
>((event, { content }) => {
  const currentContent = content.get();
  const { index, checked } = event.detail;

  console.log("Toggling checkbox", {
    index,
    checked,
    contentLength: currentContent.length,
  });

  // Find all checkbox patterns in the content
  const checkboxPattern = /- \[([ xX])\]/g;
  let match;
  let currentIndex = 0;
  let result = currentContent;

  checkboxPattern.lastIndex = 0;

  while ((match = checkboxPattern.exec(currentContent)) !== null) {
    if (currentIndex === index) {
      const newCheckbox = checked ? "- [x]" : "- [ ]";
      result = currentContent.slice(0, match.index) +
        newCheckbox +
        currentContent.slice(match.index + match[0].length);
      break;
    }
    currentIndex++;
  }

  if (result !== currentContent) {
    content.set(result);
    console.log("Updated content via Writable.set()");
  }
});

interface NoteData {
  title?: string;
  content?: string;
  backlinks?: MentionablePiece[];
  noteId?: string;
}

interface Input {
  /** Cell reference to note data (title + content + backlinks + noteId) */
  note?: Default<
    NoteData,
    { title: ""; content: ""; backlinks: []; noteId: "" }
  >;
  /** Direct reference to source note for Edit navigation */
  sourceNoteRef?: any;
  /** Writable content cell for checkbox updates */
  content?: Writable<string>;
}

interface Output {
  /** Passthrough note reference */
  note: NoteData;
  /** Hidden from default-app piece list */
  isHidden: true;
  /** Excluded from mentions autocomplete (notes in notebooks may be hidden but still mentionable) */
  isMentionable: false;
  /** Minimal UI for embedding in other patterns */
  embeddedUI: VNode;
}

export default pattern<Input, Output>(({ note, sourceNoteRef, content }) => {
  const displayName = computed(() => {
    const title = note?.title || "Untitled";
    return `📖 ${title}`;
  });

  const hasBacklinks = computed(() => (note?.backlinks?.length ?? 0) > 0);

  // Convert [[Name (id)]] wiki-links to markdown links [Name](/of:id)
  // ct-markdown will then convert these to clickable ct-cell-link components
  // Use content prop if provided, otherwise fall back to note.content
  const processedContent = computed(() => {
    const raw = content?.get?.() ?? note?.content ?? "";
    // Match [[Name (id)]] pattern and convert to [Name](/of:id)
    return raw.replace(
      /\[\[([^\]]*?)\s*\(([^)]+)\)\]\]/g,
      (_match, name, id) => `[${name.trim()}](/of:${id})`,
    );
  });

  // Get allPieces for noteId lookup fallback
  const { allPieces } =
    wish<{ allPieces: any[] }>({ query: "#default" }).result;

  // Use sourceNoteRef directly if provided, otherwise fall back to noteId lookup
  const sourceNote = computed(() => {
    if (sourceNoteRef) {
      console.log("Using sourceNoteRef directly");
      return sourceNoteRef;
    }
    const myNoteId = note?.noteId;
    if (!myNoteId) return null;
    return allPieces.find((piece: any) => piece?.noteId === myNoteId);
  });

  // Bind checkbox toggle handler with properly typed Writable<string>
  // Content is required for checkbox updates to work
  const boundCheckboxToggle = handleCheckboxToggle({ content: content! });

  // Scrollable content with markdown + backlinks (for print support)
  const markdownViewer = (
    <ct-vscroll flex showScrollbar fadeEdges>
      <div style={{ padding: "1rem", minHeight: "100%" }}>
        {/* Markdown content with wiki-links converted to clickable links */}
        <ct-markdown
          content={processedContent}
          onct-checkbox-change={boundCheckboxToggle}
        />

        {/* Backlinks section - ct-chips at bottom */}
        <div
          style={{
            display: computed(() => (hasBacklinks ? "block" : "none")),
            marginTop: "2rem",
            paddingTop: "1rem",
            borderTop: "1px solid var(--ct-color-border, #e5e5e7)",
          }}
        >
          <span
            style={{
              fontSize: "0.75rem",
              fontWeight: "600",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--ct-color-gray-500, #6b7280)",
              marginBottom: "0.5rem",
              display: "block",
            }}
          >
            Linked from:
          </span>
          <ct-hstack gap="2" wrap>
            {note?.backlinks?.map((piece) => (
              <ct-chip
                label={piece?.[NAME] ?? "Untitled"}
                interactive
                onct-click={() => handleBacklinkClick(piece)}
              />
            ))}
          </ct-hstack>
        </div>
      </div>
    </ct-vscroll>
  );

  return {
    [NAME]: displayName,
    [UI]: (
      <ct-screen>
        <ct-hstack
          slot="header"
          padding="4"
          gap="3"
          align="center"
          style={{ borderBottom: "1px solid var(--ct-color-border, #e5e5e7)" }}
        >
          <ct-heading level={1} style={{ flex: "1" }}>
            {computed(() => note?.title || "Untitled Note")}
          </ct-heading>
          {/* Edit button - navigates back to source note for editing */}
          <ct-button
            variant="secondary"
            size="sm"
            onClick={goToEdit({ sourceNote })}
          >
            Edit
          </ct-button>
        </ct-hstack>
        {markdownViewer}
      </ct-screen>
    ),
    note,
    isHidden: true,
    isMentionable: false,
    embeddedUI: markdownViewer,
  };
});
