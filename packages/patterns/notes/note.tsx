import {
  action,
  computed,
  type Default,
  equals,
  FS,
  type FsProjection,
  generateText,
  handler,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  type PatternToolResult,
  SELF,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import NoteMd from "./note-md.tsx";
import {
  type MentionablePiece,
  type MinimalPiece,
  type NotebookPiece,
  type NoteInput,
  type NotePiece,
} from "./schemas.tsx";

export { NotePiece };

// ===== Output Type =====

/** Represents a small #note a user took to remember some text. */
interface NoteOutput extends NotePiece {
  [NAME]: string;
  [UI]: VNode;
  [FS]: FsProjection;
  title: string;
  content: string;
  summary: string;
  mentioned: Default<MentionablePiece[], []>;
  backlinks: MentionablePiece[];
  isHidden: boolean;
  grep: PatternToolResult<{ content: string }>;
  translate: PatternToolResult<{ content: string }>;
  editContent: Stream<{ detail: { value: string } }>;
  setTitle: Stream<string>;
  appendLink: Stream<{ piece: Writable<MentionablePiece> }>;
  createNewNote: Stream<void>;
  /** Parent notebook reference, null if not in a notebook */
  parentNotebook: NotebookPiece | null;
  /** Minimal UI for embedding in containers like Record. Use via cf-render variant="embedded". */
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

// Used in cf-code-editor - binds mentionable and allPieces
const handleNewBacklink = handler<
  {
    detail: {
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

// Grep sub-pattern for patternTool - filters content lines by query
const grepPattern = pattern<
  { query: string; content: string },
  string[]
>(({ query, content }) => {
  return computed(() => {
    return content.split("\n").filter((c: string) => c.includes(query));
  });
});

// Translate sub-pattern for patternTool - translates content to specified language
const translatePattern = pattern<
  { language: string; content: string },
  string | undefined
>(({ language, content }) => {
  const genResult = generateText({
    system: computed(() => `Translate the content to ${language}.`),
    prompt: computed(() => `<to_translate>${content}</to_translate>`),
  });

  return computed(() => {
    if (genResult.pending !== false) return undefined;
    if (genResult.result == null) return "Error occurred";
    return genResult.result;
  });
});

// ===== Pattern =====

const Note = pattern<NoteInput, NoteOutput>(
  ({
    title,
    content,
    isHidden,
    linkPattern,
    parentNotebook,
    [SELF]: self,
  }) => {
    // Type-based discovery for notebooks and "All Notes" piece
    const notebookWish = wish<NotebookPiece>({
      query: "#notebook",
      scope: ["."],
      headless: true,
    });
    const allNotesWish = wish<MinimalPiece>({
      query: "#allNotes",
      scope: ["."],
      headless: true,
    });

    // Notebooks and "All Notes" from wish scope (must be before actions that reference them)
    const notebooks = notebookWish.candidates;
    const allNotesPiece = allNotesWish.result;

    // Still need allPieces for write operations (push new notes, push backlinks)
    const { allPieces } = wish<{ allPieces: Writable<MinimalPiece[]> }>(
      { query: "#default", headless: true },
    ).result!;
    const mentionable = wish<Default<MentionablePiece[], []>>(
      { query: "#mentionable", headless: true },
    ).result;
    const _recentPieces = wish<MinimalPiece[]>(
      { query: "#recent", headless: true },
    ).result;
    const mentioned = Writable.of<MentionablePiece[]>([]);

    // UI state
    const menuOpen = Writable.of(false);
    const isEditingTitle = Writable.of(false);

    // Backlinks - populated by backlinks-index.tsx
    const backlinks = Writable.of<MentionablePiece[]>([]);

    // Summary - truncated content for search indexing
    const summary = computed(() => {
      const text = content.get();
      if (!text || text.trim() === "") return "";
      const cleaned = text.trim();
      if (cleaned.length <= 200) return cleaned;
      const truncated = cleaned.slice(0, 200);
      const lastSpace = truncated.lastIndexOf(" ");
      return lastSpace > 150
        ? truncated.slice(0, lastSpace) + "..."
        : truncated + "...";
    });

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
          },
          sourceNoteRef: self as NotePiece,
          content,
        }),
      );
    });

    // Create new note action - closes over allPieces and parentNotebook
    const createNewNote = action(() => {
      const notebook = parentNotebook.get();

      if (notebook) {
        notebook.createNote.send({
          title: "New Note",
          content: "",
          navigate: true,
        });
      } else {
        const note = Note({
          title: "New Note",
          content: "",
          isHidden: !!notebook,
          parentNotebook: notebook,
        });
        allPieces.push(note as any);
        return navigateTo(note);
      }
    });

    const menuAllNotebooks = action(() => {
      menuOpen.set(false);
      if (allNotesPiece) {
        return navigateTo(allNotesPiece);
      }
    });

    // Exported stream for external content editing
    const editContent = action(
      (rawInput: { detail: { value: string } }) => {
        // Single widening cast to allow runtime validation of unexpected shapes
        const loose = rawInput as { detail?: { value?: unknown } };
        const value = loose?.detail?.value;
        if (typeof value !== "string") {
          console.error(
            `editContent: invalid input shape. Expected { detail: { value: string } }, got: ${
              JSON.stringify(rawInput)
            }`,
          );
          return;
        }
        content.set(value);
      },
    );

    // Exported stream for external title editing
    const setTitle = action((newTitle: string) => {
      title.set(newTitle);
    });

    // Append a wiki-link to another piece at the end of the note content
    const appendLink = action(
      ({ piece }: { piece: Writable<MentionablePiece> }) => {
        const name = piece.get()[NAME] ?? "";
        const resolved = (piece as any).resolveAsCell();
        const entityId = resolved?.entityId?.["/"];
        if (!name || !entityId) return;

        const link = `[[${name} (${entityId})]]`;
        const current = content.get();
        content.set(current ? `${current}\n${link}` : link);

        mentioned.push(piece);
      },
    );

    // LAZY: Only compute which notebooks contain this note when menu is open
    const containingNotebooks = computed(() => {
      if (!menuOpen.get()) return [];

      const result: NotebookPiece[] = [];
      for (const nb of notebooks) {
        for (const n of nb?.notes ?? []) {
          if (equals(n, self)) {
            result.push(nb);
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
      <cf-code-editor
        $value={content}
        $mentionable={mentionable!}
        $mentioned={mentioned}
        $pattern={patternJson}
        onbacklink-click={handlePieceLinkClick}
        onbacklink-create={handleNewBacklink({
          mentionable: mentionable!,
          allPieces,
        })}
        language="text/markdown"
        mode="prose"
        wordWrap
        tabIndent
        placeholder="Start writing..."
      />
    );

    return {
      [NAME]: computed(() => `📝 ${title.get()}`),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title },
        content,
      },
      [UI]: (
        <cf-screen>
          <cf-vstack
            slot="header"
            gap="2"
            padding="4"
            style={{
              borderBottom: "1px solid var(--cf-color-border, #e5e5e7)",
            }}
          >
            {/* Parent notebook chip */}
            <cf-hstack
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
                  color: "var(--cf-color-text-secondary)",
                }}
              >
                In:
              </span>
              <cf-chip
                label={parentNotebookLabel}
                interactive
                oncf-click={goToParent}
              />
            </cf-hstack>

            <cf-hstack gap="3" style={{ alignItems: "center" }}>
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
                <cf-input
                  $value={title}
                  placeholder="Note title..."
                  style={{ flex: 1 }}
                  oncf-blur={stopEditingTitle}
                  oncf-keydown={handleTitleKeydown}
                />
              </div>

              {/* View Mode button */}
              <cf-button
                variant="ghost"
                onClick={goToViewer}
                style={headerButtonStyle}
                title="View as markdown"
              >
                View
              </cf-button>

              {/* New Note button */}
              <cf-button
                variant="ghost"
                onClick={createNewNote}
                style={{ ...headerButtonStyle, gap: "4px" }}
                title="Create new note"
              >
                📝 New
              </cf-button>

              <cf-button
                variant="ghost"
                onClick={toggleMenu}
                style={{ ...headerButtonStyle, padding: "8px 16px" }}
              >
                Notebooks ▾
              </cf-button>

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
              <cf-vstack
                gap="0"
                style={{
                  display: menuDisplayStyle,
                  position: "fixed",
                  top: "112px",
                  right: "16px",
                  background: "var(--cf-color-bg, white)",
                  border: "1px solid var(--cf-color-border, #e5e5e7)",
                  borderRadius: "12px",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  minWidth: "180px",
                  zIndex: "1000",
                  padding: "4px",
                }}
              >
                {notebooks.map((notebook) => (
                  <cf-button
                    variant="ghost"
                    onClick={menuGoToNotebook({ menuOpen, notebook })}
                    style={{ justifyContent: "flex-start" }}
                  >
                    {"  "}
                    {notebook?.[NAME] ?? "Untitled"}
                    {computed(() => {
                      return containingNotebooks
                          .find((nb) => equals(nb, notebook))
                        ? " ✓"
                        : "";
                    })}
                  </cf-button>
                ))}

                {/* Divider + All Notes - only show if All Notes piece exists */}
                <div
                  style={{
                    display: allNotesDividerDisplay,
                    height: "1px",
                    background: "var(--cf-color-border, #e5e5e7)",
                    margin: "4px 8px",
                  }}
                />

                <cf-button
                  variant="ghost"
                  onClick={menuAllNotebooks}
                  style={{
                    display: allNotesButtonDisplay,
                    justifyContent: "flex-start",
                  }}
                >
                  {"  "}📁 All Notes
                </cf-button>
              </cf-vstack>
            </cf-hstack>
          </cf-vstack>

          {editorUI}

          <cf-hstack slot="footer">
            {backlinks?.map((piece) => (
              <cf-button onClick={handleBacklinkClick({ piece })}>
                {piece?.[NAME]}
              </cf-button>
            ))}
          </cf-hstack>
        </cf-screen>
      ),
      title,
      content,
      summary,
      mentioned,
      backlinks,
      isHidden,
      parentNotebook,
      grep: patternTool(grepPattern, { content }),
      translate: patternTool(translatePattern, { content }),
      editContent,
      setTitle,
      appendLink,
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
