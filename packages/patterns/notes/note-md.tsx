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
} from "commontools";

// Type for backlinks (same as note.tsx)
type MentionableCharm = {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionableCharm[];
  backlinks: MentionableCharm[];
};

// Handler for clicking a backlink chip - must be at module scope
const handleBacklinkClick = (charm: MentionableCharm) => {
  return navigateTo(charm as any);
};

// Handler for Edit button - go back to note editor (module scope)
const goToEdit = handler<void, { sourceNote: any }>((_ev, { sourceNote }) => {
  const noteRef = sourceNote?.get?.() ?? sourceNote;
  if (noteRef) {
    return navigateTo(noteRef);
  }
});

interface NoteData {
  title?: string;
  content?: string;
  backlinks?: MentionableCharm[];
  noteId?: string;
}

interface Input {
  /** Cell reference to note data (title + content + backlinks + noteId) */
  note?: Default<
    NoteData,
    { title: ""; content: ""; backlinks: []; noteId: "" }
  >;
}

interface Output {
  /** Passthrough note reference */
  note: NoteData;
  /** Hidden from default-app charm list */
  isHidden: true;
  /** Excluded from mentions autocomplete (notes in notebooks may be hidden but still mentionable) */
  isMentionable: false;
  /** Minimal UI for embedding in other patterns */
  embeddedUI: VNode;
}

export default pattern<Input, Output>(({ note }) => {
  const displayName = computed(() => {
    const title = note?.title || "Untitled";
    return `📖 ${title}`;
  });

  const hasBacklinks = computed(() => (note?.backlinks?.length ?? 0) > 0);

  // Convert [[Name (id)]] wiki-links to markdown links [Name](/of:id)
  // ct-markdown will then convert these to clickable ct-cell-link components
  const processedContent = computed(() => {
    const raw = note?.content || "";
    // Match [[Name (id)]] pattern and convert to [Name](/of:id)
    return raw.replace(
      /\[\[([^\]]*?)\s*\(([^)]+)\)\]\]/g,
      (_match, name, id) => `[${name.trim()}](/of:${id})`,
    );
  });

  // Find source note by noteId using wish()
  const { allCharms } = wish<{ allCharms: any[] }>("/");
  const sourceNote = computed(() => {
    const myNoteId = note?.noteId;
    if (!myNoteId) return null;
    return allCharms.find((charm: any) => charm?.noteId === myNoteId);
  });

  // Scrollable content with markdown + backlinks (for print support)
  const markdownViewer = (
    <ct-vscroll flex showScrollbar fadeEdges>
      <div style={{ padding: "1rem", minHeight: "100%" }}>
        {/* Markdown content with wiki-links converted to clickable links */}
        <ct-markdown content={processedContent} />

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
            {note?.backlinks?.map((charm) => (
              <ct-chip
                label={charm?.[NAME] ?? "Untitled"}
                interactive
                onct-click={() => handleBacklinkClick(charm)}
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
