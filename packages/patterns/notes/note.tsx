/// <cts-enable />
import {
  action,
  computed,
  type Default,
  generateText,
  handler,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  type PatternToolResult,
  SELF,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";
import NoteMd from "./note-md.tsx";
import {
  generateId,
  type MentionablePiece,
  type MinimalPiece,
  type NotebookPiece,
  type NoteInput,
  type NotePiece,
} from "./schemas.tsx";

// ===== Output Type =====

/** Represents a small #note a user took to remember some text. */
interface NoteOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  content: string;
  mentioned: Default<MentionablePiece[], []>;
  backlinks: MentionablePiece[];
  isHidden: boolean;
  noteId: string;
  grep: PatternToolResult<{ content: string }>;
  translate: PatternToolResult<{ content: string }>;
  editContent: Stream<{ detail: { value: string } }>;
  createNewNote: Stream<void>;
  /** Parent notebook reference, null if not in a notebook */
  parentNotebook: NotebookPiece | null;
  /** Minimal UI for embedding in containers like Record. Use via ct-render variant="embedded". */
  embeddedUI: VNode;
  // Test-accessible state
  menuOpen: boolean;
  isEditingTitle: boolean;
  // Test-accessible action streams
  toggleMenu: Stream<void>;
  closeMenu: Stream<void>;
  startEditingTitle: Stream<void>;
  stopEditingTitle: Stream<void>;
}

// ===== Module-scope handlers (reused with different bindings) =====

// Used in ct-code-editor - binds mentionable and allPieces
const handleNewBacklink = handler<
  {
    detail: {
      text: string;
      pieceId: unknown;
      piece: Writable<MentionablePiece>;
      navigate: boolean;
    };
  },
  {
    mentionable: Writable<MentionablePiece[]>;
    allPieces: Writable<MinimalPiece[]>;
  }
>(({ detail }, { mentionable, allPieces }) => {
  // Push to allPieces so it appears in default-app
  allPieces.push(detail.piece);

  if (detail.navigate) {
    return navigateTo(detail.piece);
  } else {
    mentionable.push(detail.piece);
  }
});

// Used in .map() over notebooks - binds different notebook each time
const menuGoToNotebook = handler<
  void,
  { menuOpen: Writable<boolean>; notebook: Writable<MinimalPiece> }
>((_, { menuOpen, notebook }) => {
  menuOpen.set(false);
  return navigateTo(notebook);
});

// Used in .map() over backlinks - binds different piece each time
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>(
  (_, { piece }) => navigateTo(piece),
);

// ===== Utility functions =====

// Grep function for patternTool - filters content lines by query
const grepFn = ({ query, content }: { query: string; content: string }) => {
  return computed(() => content.split("\n").filter((c) => c.includes(query)));
};

// Translate function for patternTool - translates content to specified language
const translateFn = (
  { language, content }: { language: string; content: string },
) => {
  const genResult = generateText({
    system: computed(() => `Translate the content to ${language}.`),
    prompt: computed(() => `<to_translate>${content}</to_translate>`),
  });

  return computed(() => {
    if (genResult.pending) return undefined;
    if (genResult.result == null) return "Error occurred";
    return genResult.result;
  });
};

// ===== Pattern =====

const Note = pattern<NoteInput, NoteOutput>(
  ({
    title,
    content,
    isHidden,
    noteId,
    linkPattern,
    parentNotebook,
    [SELF]: self,
  }) => {
    // Type-based discovery for notebooks and "All Notes" piece
    const notebookWish = wish<NotebookPiece>({
      query: "#notebook",
      scope: ["."],
    });
    const allNotesWish = wish<MinimalPiece>({
      query: "#allNotes",
      scope: ["."],
    });

    // Notebooks and "All Notes" from wish scope (must be before actions that reference them)
    const notebooks = notebookWish.candidates;
    const allNotesPiece = allNotesWish.result;

    // Still need allPieces for write operations (push new notes, push backlinks)
    const { allPieces } =
      wish<{ allPieces: Writable<MinimalPiece[]> }>({ query: "#default" })
        .result;
    const mentionable = wish<Default<MentionablePiece[], []>>(
      { query: "#mentionable" },
    ).result;
    const _recentPieces = wish<MinimalPiece[]>({ query: "#recent" }).result;
    const mentioned = Writable.of<MentionablePiece[]>([]);

    // UI state
    const menuOpen = Writable.of(false);
    const isEditingTitle = Writable.of(false);

    // Backlinks - populated by backlinks-index.tsx
    const backlinks = Writable.of<MentionablePiece[]>([]);

    // ===== Actions =====

    const handlePieceLinkClick = action(
      ({ detail }: { detail: { piece: Writable<MentionablePiece> } }) =>
        navigateTo(detail.piece),
    );

    const toggleMenu = action(() => menuOpen.set(!menuOpen.get()));
    const closeMenu = action(() => menuOpen.set(false));

    const startEditingTitle = action(() => isEditingTitle.set(true));
    const stopEditingTitle = action(() => isEditingTitle.set(false));

    const handleTitleKeydown = action((event: { key?: string }) => {
      if (event?.key === "Enter") {
        isEditingTitle.set(false);
      }
    });

    const goToParent = action(() => {
      const p = parentNotebook.get();
      if (p) navigateTo(p);
    });

    const goToViewer = action(() => {
      return navigateTo(
        NoteMd({
          note: {
            title,
            content,
            backlinks,
            noteId,
          },
          sourceNoteRef: self as NotePiece,
          content,
        }),
      );
    });

    // Create new note action - closes over allPieces and parentNotebook
    const createNewNote = action(() => {
      const notebook = parentNotebook.get();

      const note = Note({
        title: "New Note",
        content: "",
        noteId: generateId(),
        isHidden: !!notebook,
        parentNotebook: notebook,
      });
      allPieces.push(note as any); // Required for persistence

      // Add to parent notebook if we can find it in mentionable
      if (notebook) {
        const nbName = notebook[NAME];
        const found = mentionable.find((c) => c[NAME] === nbName) as
          | NotebookPiece
          | undefined;
        if (found?.isNotebook && found?.notes) {
          (found.notes as NotePiece[]).push(note);
        }
      }

      return navigateTo(note);
    });

    const menuAllNotebooks = action(() => {
      menuOpen.set(false);
      if (allNotesPiece) {
        return navigateTo(allNotesPiece);
      }
    });

    // Exported stream for external content editing
    const editContent = action(
      ({ detail }: { detail: { value: string } }) => {
        content.set(detail.value);
      },
    );

    // LAZY: Only compute which notebooks contain this note when menu is open
    const containingNotebookNames = computed(() => {
      if (!menuOpen.get()) return [];

      const myId = noteId;
      if (!myId) return [];
      const result: string[] = [];
      for (const nb of notebooks) {
        const nbNotes = (nb as any)?.notes ?? [];
        const nbName = (nb as any)?.[NAME] ?? "";
        for (const n of nbNotes) {
          if (n?.noteId && n.noteId === myId) {
            result.push(nbName);
            break;
          }
        }
      }
      return result;
    });

    // Link pattern for wiki-links
    const patternJson = computed(() => {
      const lpValue = (linkPattern as any)?.get?.() ?? linkPattern;
      const custom = typeof lpValue === "string" ? lpValue.trim() : "";
      return custom || JSON.stringify(Note);
    });

    // ===== Pre-computed UI values =====

    // Parent notebook display state - read from input prop
    const hasParentNotebook = computed(() => !!parentNotebook.get());
    const parentNotebookLabel = computed(() => {
      const p = parentNotebook.get();
      return p?.[NAME] ?? p?.title ?? "Notebook";
    });

    // Menu display states
    const menuDisplayStyle = computed(() => menuOpen.get() ? "flex" : "none");
    const allNotesDividerDisplay = computed(() =>
      allNotesPiece ? "block" : "none"
    );
    const allNotesButtonDisplay = computed(() =>
      allNotesPiece ? "flex" : "none"
    );

    // Title editing display states
    const titleDisplayStyle = computed(() =>
      isEditingTitle.get() ? "none" : "flex"
    );
    const titleInputDisplayStyle = computed(() =>
      isEditingTitle.get() ? "flex" : "none"
    );

    // ===== Shared UI Styles =====

    const headerButtonStyle = {
      alignItems: "center",
      padding: "6px 12px",
      fontSize: "14px",
      borderRadius: "8px",
    };

    // ===== UI =====

    const editorUI = (
      <ct-code-editor
        $value={content}
        $mentionable={mentionable}
        $mentioned={mentioned}
        $pattern={patternJson}
        onbacklink-click={handlePieceLinkClick}
        onbacklink-create={handleNewBacklink({ mentionable, allPieces })}
        language="text/markdown"
        theme="light"
        wordWrap
        tabIndent
        lineNumbers
      />
    );

    return {
      [NAME]: computed(() => `📝 ${title.get()}`),
      [UI]: (
        <ct-screen>
          <ct-vstack
            slot="header"
            gap="2"
            padding="4"
            style={{
              borderBottom: "1px solid var(--ct-color-border, #e5e5e7)",
            }}
          >
            {/* Parent notebook chip */}
            <ct-hstack
              gap="2"
              align="center"
              style={{
                display: computed(() => hasParentNotebook ? "flex" : "none"),
                marginBottom: "4px",
              }}
            >
              <span
                style={{
                  fontSize: "13px",
                  color: "var(--ct-color-text-secondary)",
                }}
              >
                In:
              </span>
              <ct-chip
                label={parentNotebookLabel}
                interactive
                onct-click={goToParent}
              />
            </ct-hstack>

            <ct-hstack gap="3" style={{ alignItems: "center" }}>
              {/* Editable Title - click to edit */}
              <div
                style={{
                  display: titleDisplayStyle,
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                  flex: 1,
                }}
                onClick={startEditingTitle}
              >
                <span
                  style={{ margin: 0, fontSize: "15px", fontWeight: "600" }}
                >
                  {title}
                </span>
              </div>
              <div
                style={{
                  display: titleInputDisplayStyle,
                  flex: 1,
                  marginRight: "12px",
                }}
              >
                <ct-input
                  $value={title}
                  placeholder="Note title..."
                  style={{ flex: 1 }}
                  onct-blur={stopEditingTitle}
                  onct-keydown={handleTitleKeydown}
                />
              </div>

              {/* View Mode button */}
              <ct-button
                variant="ghost"
                onClick={goToViewer}
                style={headerButtonStyle}
                title="View as markdown"
              >
                View
              </ct-button>

              {/* New Note button */}
              <ct-button
                variant="ghost"
                onClick={createNewNote}
                style={{ ...headerButtonStyle, gap: "4px" }}
                title="Create new note"
              >
                📝 New
              </ct-button>

              <ct-button
                variant="ghost"
                onClick={toggleMenu}
                style={{ ...headerButtonStyle, padding: "8px 16px" }}
              >
                Notebooks ▾
              </ct-button>

              {/* Backdrop to close menu */}
              <div
                onClick={closeMenu}
                style={{
                  display: computed(() => menuOpen.get() ? "block" : "none"),
                  position: "fixed",
                  inset: "0",
                  zIndex: "999",
                }}
              />

              {/* Dropdown Menu */}
              <ct-vstack
                gap="0"
                style={{
                  display: menuDisplayStyle,
                  position: "fixed",
                  top: "112px",
                  right: "16px",
                  background: "var(--ct-color-bg, white)",
                  border: "1px solid var(--ct-color-border, #e5e5e7)",
                  borderRadius: "12px",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  minWidth: "180px",
                  zIndex: "1000",
                  padding: "4px",
                }}
              >
                {notebooks.map((notebook) => (
                  <ct-button
                    variant="ghost"
                    onClick={menuGoToNotebook({ menuOpen, notebook })}
                    style={{ justifyContent: "flex-start" }}
                  >
                    {"  "}
                    {notebook?.[NAME] ?? "Untitled"}
                    {computed(() => {
                      const nbName = (notebook as any)?.[NAME] ?? "";
                      return containingNotebookNames.includes(nbName)
                        ? " ✓"
                        : "";
                    })}
                  </ct-button>
                ))}

                {/* Divider + All Notes - only show if All Notes piece exists */}
                <div
                  style={{
                    display: allNotesDividerDisplay,
                    height: "1px",
                    background: "var(--ct-color-border, #e5e5e7)",
                    margin: "4px 8px",
                  }}
                />

                <ct-button
                  variant="ghost"
                  onClick={menuAllNotebooks}
                  style={{
                    display: allNotesButtonDisplay,
                    justifyContent: "flex-start",
                  }}
                >
                  {"  "}📁 All Notes
                </ct-button>
              </ct-vstack>
            </ct-hstack>
          </ct-vstack>

          {editorUI}

          <ct-hstack slot="footer">
            {backlinks?.map((piece) => (
              <ct-button onClick={handleBacklinkClick({ piece })}>
                {piece?.[NAME]}
              </ct-button>
            ))}
          </ct-hstack>
        </ct-screen>
      ),
      title,
      content,
      mentioned,
      backlinks,
      isHidden,
      noteId,
      parentNotebook,
      grep: patternTool(grepFn, { content }),
      translate: patternTool(translateFn, { content }),
      editContent,
      createNewNote,
      embeddedUI: editorUI,
      // Test-accessible state
      menuOpen,
      isEditingTitle,
      // Test-accessible action streams
      toggleMenu,
      closeMenu,
      startEditingTitle,
      stopEditingTitle,
    };
  },
);

export default Note;
