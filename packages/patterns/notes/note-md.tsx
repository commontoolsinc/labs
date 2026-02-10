/// <cts-enable />
import {
  action,
  computed,
  handler,
  NAME,
  navigateTo,
  pattern,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";
import {
  type MentionablePiece,
  type NoteMdInput,
  type NotePiece,
} from "./schemas.tsx";

// Handler for clicking a backlink chip - module scope required for .map() binding
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>((_, { piece }) => navigateTo(piece));

// ===== Output Type =====

interface NoteMdOutput {
  [NAME]: string;
  [UI]: VNode;
  /** Passthrough note reference */
  note: NotePiece;
  /** Hidden from default-app piece list */
  isHidden: true;
  /** Excluded from mentions autocomplete (notes in notebooks may be hidden but still mentionable) */
  isMentionable: false;
  /** Minimal UI for embedding in other patterns */
  embeddedUI: VNode;
  /** Processed content with wiki-links converted to markdown links */
  processedContent: string;
  /** Stream to toggle checkboxes in content */
  checkboxToggle: Stream<{ detail: { index: number; checked: boolean } }>;
}

export default pattern<NoteMdInput, NoteMdOutput>(
  ({ note, sourceNoteRef, content }) => {
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
    // Contains mixed piece types, so we use NotePiece for note-specific lookups
    const { allPieces } =
      wish<{ allPieces: NotePiece[] }>({ query: "#default" }).result;

    // Use sourceNoteRef directly if provided, otherwise fall back to noteId lookup
    const sourceNote = computed(() => {
      if (sourceNoteRef) {
        return sourceNoteRef;
      }
      const myNoteId = note?.noteId;
      if (!myNoteId) return null;
      return allPieces.find((piece) => piece?.noteId === myNoteId);
    });

    // Action: navigate back to source note for editing
    const goToEdit = action(() => {
      if (sourceNote) {
        return navigateTo(sourceNote);
      }
    });

    // Action: handle checkbox toggle in markdown content
    const handleCheckboxToggle = action(
      (event: { detail: { index: number; checked: boolean } }) => {
        if (!content) return;
        const currentContent = content.get();
        const { index, checked } = event.detail;

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
        }
      },
    );

    // Scrollable content with markdown + backlinks (for print support)
    const markdownViewer = (
      <ct-vscroll flex showScrollbar fadeEdges>
        <div style={{ padding: "1rem", minHeight: "100%" }}>
          {/* Markdown content with wiki-links converted to clickable links */}
          <ct-markdown
            content={processedContent}
            onct-checkbox-change={handleCheckboxToggle}
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
                  onct-click={handleBacklinkClick({ piece })}
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
            style={{
              borderBottom: "1px solid var(--ct-color-border, #e5e5e7)",
            }}
          >
            <ct-heading level={1} style={{ flex: "1" }}>
              {computed(() => note?.title || "Untitled Note")}
            </ct-heading>
            {/* Edit button - navigates back to source note for editing */}
            <ct-button variant="secondary" size="sm" onClick={goToEdit}>
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
      processedContent,
      checkboxToggle: handleCheckboxToggle,
    };
  },
);
