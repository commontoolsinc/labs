import {
  action,
  computed,
  equals,
  handler,
  NAME,
  navigateTo,
  pattern,
  type Stream,
  TILE_UI,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  type MentionablePiece,
  type MentionRefMap,
  type NoteMdInput,
  type NotePiece,
} from "./schemas.tsx";

// Handler for clicking a backlink chip - module scope required for .map() binding
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>((_, { piece }) => navigateTo(piece));

/**
 * The address of a reference's destination, or undefined when the map does not
 * hold the key.
 *
 * The scheme comes from the destination rather than being prepended. A
 * wiki-link's embedded id is bare and provably `of:`, because the embed format
 * rejects every other scheme, so the renderer can put `of:` back. A
 * reference's destination is a cell carrying whatever scheme it has, and
 * assuming `of:` for it would address a different entity than the one meant.
 *
 * `resolveAsCell` and `sourceURI` are cell-runtime surface rather than the
 * pattern Writable type, hence the cast — the same one notes' `appendLink`
 * makes.
 */
const referenceAddresses = (
  references: Writable<MentionRefMap> | undefined,
): Record<string, string> => {
  const addresses: Record<string, string> = {};
  // `.get()` here is also what subscribes the caller to the map, which is why
  // this runs in the computed's own body rather than inside the replacement
  // callback below it: a read from a nested callback resolves the address
  // correctly and registers no dependency, so the rendered content would be
  // right once and then never again.
  const map = references?.get?.();
  if (!map) return addresses;

  for (const key of Object.keys(map)) {
    // `destination` is typed unknown and so reads back undefined, but the
    // ENTRY still materializes — `modifiedTitle` is a boolean — and the
    // address comes from the path to the destination, not from its value.
    const destination = (references as any).key(key).key("destination");
    const uri: string | undefined = destination?.resolveAsCell?.()?.sourceURI;
    if (uri) addresses[key] = `/${uri}`;
  }

  return addresses;
};

// ===== Output Type =====

export interface NoteMdOutput {
  [NAME]: string;
  [UI]: VNode;
  /** Passthrough note reference */
  note: NotePiece;
  /** Hidden from default-app piece list */
  isHidden: true;
  /** Excluded from mentions autocomplete (notes in notebooks may be hidden but still mentionable) */
  isMentionable: false;
  /** Tile variant (CT-1764): minimal embedded UI for `<cf-render variant="tile">`. */
  [TILE_UI]: VNode;
  /** Processed content with wiki-links converted to markdown links */
  processedContent: string;
  /** Stream to toggle checkboxes in content */
  checkboxToggle: Stream<{ detail: { index: number; checked: boolean } }>;
  /** Whether backlinks section should be visible */
  hasBacklinks: boolean;
  /** Stream to navigate back to source note for editing */
  goToEdit: Stream<void>;
}

export default pattern<NoteMdInput, NoteMdOutput>(
  ({ note, sourceNoteRef, content, references }) => {
    const displayName = computed(() => {
      const title = note?.title || "Untitled";
      return `📖 ${title}`;
    });

    const hasBacklinks = computed(() => (note?.backlinks?.length ?? 0) > 0);

    // Convert both mention forms to markdown links, which cf-markdown then
    // turns into clickable cf-cell-link components. Use the content prop if
    // provided, otherwise fall back to note.content.
    //
    // A wiki-link's embedded id is the BARE tagged hash by contract: the
    // editor strips `of:` at embed time (mentionIdFromCellId in packages/ui)
    // and REJECTS `computed:` ids, so prepending `/of:` is always correct for
    // that form. A reference's destination carries its own scheme, so that
    // form reads the address off the destination instead.
    const processedContent = computed(() => {
      const raw = content?.get?.() ?? note?.content ?? "";
      const withWikiLinks = raw.replace(
        /\[\[([^\]]*?)\s*\(([^)]+)\)\]\]/g,
        (_match, name, id) => `[${name.trim()}](/of:${id})`,
      );
      const addresses = referenceAddresses(references);

      // Match `[Label][key]`, the reference form. The key shape matches what
      // the editor mints (`mintRefKey`, `packages/ui/src/v2/core/mention-refs.ts`);
      // a pattern cannot import from the UI package, so the two are held in
      // step by hand. The literal is built here rather than at module scope,
      // where a stateful RegExp is not allowed.
      //
      // A key with no address is left exactly as written. It may be a
      // hand-written reference link, or a mention pasted out of a note whose
      // map is elsewhere; either way the label survives and the reader sees
      // what the author typed rather than a link to nothing.
      return withWikiLinks.replace(
        /\[([^\]\n]*)\]\[([0-9a-z]{6,10})\]/g,
        (match: string, label: string, key: string) =>
          addresses[key] ? `[${label}](${addresses[key]})` : match,
      );
    });

    // Type-based discovery for notes via mentionable list
    const noteWish = wish<NotePiece>({
      query: "#note",
      scope: ["."],
      headless: true,
    });

    // Use sourceNoteRef directly if provided, otherwise fall back to equality lookup
    const sourceNote = computed(() => {
      if (sourceNoteRef) {
        return sourceNoteRef;
      }
      if (!note) return null;
      return noteWish.candidates.find((piece) => equals(piece, note));
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
      <cf-vscroll flex showScrollbar fadeEdges>
        <div style={{ padding: "1rem", minHeight: "100%" }}>
          {/* Markdown content with wiki-links converted to clickable links */}
          <cf-markdown
            content={processedContent}
            oncf-checkbox-change={handleCheckboxToggle}
          />

          {/* Backlinks section - cf-chips at bottom */}
          <div
            style={{
              display: computed(() => (hasBacklinks ? "block" : "none")),
              marginTop: "2rem",
              paddingTop: "1rem",
              borderTop: "1px solid var(--cf-theme-color-border, #e5e5e7)",
            }}
          >
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: "600",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--cf-colors-gray-500, #6b7280)",
                marginBottom: "0.5rem",
                display: "block",
              }}
            >
              Linked from:
            </span>
            <cf-hstack gap="2" wrap>
              {(note?.backlinks as MentionablePiece[] | undefined)?.map((
                piece,
              ) => (
                <cf-chip
                  label={piece?.[NAME] ?? "Untitled"}
                  interactive
                  oncf-click={handleBacklinkClick({ piece })}
                />
              ))}
            </cf-hstack>
          </div>
        </div>
      </cf-vscroll>
    );

    return {
      [NAME]: displayName,
      [UI]: (
        <cf-screen>
          <cf-hstack
            slot="header"
            padding="4"
            gap="3"
            align="center"
            style={{
              borderBottom: "1px solid var(--cf-theme-color-border, #e5e5e7)",
            }}
          >
            <cf-heading level={1} style={{ flex: "1" }}>
              {computed(() => note?.title || "Untitled Note")}
            </cf-heading>
            {/* Edit button - navigates back to source note for editing */}
            <cf-button
              color="neutral"
              variant="outline"
              size="sm"
              onClick={goToEdit}
            >
              Edit
            </cf-button>
          </cf-hstack>
          {markdownViewer}
        </cf-screen>
      ),
      note,
      isHidden: true,
      isMentionable: false,
      [TILE_UI]: markdownViewer,
      processedContent,
      checkboxToggle: handleCheckboxToggle,
      hasBacklinks,
      goToEdit,
    };
  },
);
