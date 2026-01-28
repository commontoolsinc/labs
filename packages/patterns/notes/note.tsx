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
  type NotebookCell,
  type NotebookPiece,
  type NoteInput,
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
  parentNotebook: NotebookPiece | null;
  isHidden: boolean;
  noteId: string;
  grep: PatternToolResult<{ content: string }>;
  translate: PatternToolResult<{ content: string }>;
  editContent: Stream<{ detail: { value: string } }>;
  /** Minimal UI for embedding in containers like Record. Use via ct-render variant="embedded". */
  embeddedUI: VNode;
}

// ===== Module-scope handlers (reused with different bindings) =====

// Used in ct-code-editor - no state binding needed, just forwards event
const handlePieceLinkClick = handler<
  { detail: { piece: Writable<MentionablePiece> } },
  Record<string, never>
>(({ detail }) => navigateTo(detail.piece));

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

// Navigate to parent notebook - binds self to access parentNotebook
const goToParentHandler = handler<
  Record<string, never>,
  { self: { parentNotebook?: unknown } }
>((_, { self }) => {
  const p = self?.parentNotebook;
  if (p) navigateTo(p);
});

// ===== Utility functions =====

// Type guard for notebook cells (mentionable items that have isNotebook and notes)
const isNotebookCell = (item: unknown): item is NotebookCell => {
  const maybe = item as { isNotebook?: boolean; notes?: unknown };
  return !!maybe.isNotebook && !!maybe.notes;
};

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
    parentNotebook: parentNotebookProp,
    [SELF]: self,
  }) => {
    const { allPieces } =
      wish<{ allPieces: MinimalPiece[] }>({ query: "#default" }).result;
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

    // ===== Computed values =====

    // Parent notebook: use direct reference (set when navigating from notebook)
    const parentNotebook = computed(() => {
      const selfParent = (self as any)?.parentNotebook;
      if (selfParent) return selfParent;
      if (parentNotebookProp) return parentNotebookProp;
      return null;
    });

    // Find the parent notebook in mentionable (for adding notes to it)
    // mentionable is a superset that includes notebooks with their notes arrays
    const parentNotebookCell = computed((): NotebookCell | null => {
      const notebook = parentNotebookProp;
      if (!notebook) return null;

      const nbName = notebook[NAME];
      const found = mentionable.find((c) => c[NAME] === nbName);
      if (!found || !isNotebookCell(found)) return null;

      return found;
    });

    // ===== Actions =====

    const toggleMenu = action(() => menuOpen.set(!menuOpen.get()));
    const closeMenu = action(() => menuOpen.set(false));

    const startEditingTitle = action(() => isEditingTitle.set(true));
    const stopEditingTitle = action(() => isEditingTitle.set(false));

    const handleTitleKeydown = action((event: { key?: string }) => {
      if (event?.key === "Enter") {
        isEditingTitle.set(false);
      }
    });

    const goToParent = goToParentHandler({ self });

    const goToViewer = action(() => {
      return navigateTo(
        NoteMd({
          note: {
            title,
            content,
            backlinks,
            noteId,
          },
          sourceNoteRef: self,
          content,
        }),
      );
    });

    // Create new note action - closes over allPieces and parentNotebookProp
    const createNewNote = action(() => {
      const notebook = parentNotebookProp;
      const notebookCell = parentNotebookCell;

      const note = Note({
        title: "New Note",
        content: "",
        noteId: generateId(),
        isHidden: !!notebook,
        parentNotebook: notebook,
      });
      allPieces.push(note as any); // Required for persistence

      // Add to parent notebook if we have a reference to it
      if (notebookCell) {
        notebookCell.notes.push(note);
      }

      return navigateTo(note);
    });

    const menuAllNotebooks = action(() => {
      menuOpen.set(false);
      const existing = allPieces.find((piece: any) => {
        const name = piece?.[NAME];
        return typeof name === "string" && name.startsWith("All Notes");
      });
      if (existing) {
        return navigateTo(existing);
      }
    });

    // Exported stream for external content editing
    const editContent = action(
      (
        { detail, result }: {
          detail: { value: string };
          result?: Writable<string>;
        },
      ) => {
        content.set(detail.value);
        result?.set("test!");
      },
    );

    // LAZY: Only filter notebooks when menu is open
    const notebooks = computed(() => {
      if (!menuOpen.get()) return [];
      return allPieces.filter((piece: any) => {
        const name = piece?.[NAME];
        return typeof name === "string" && name.startsWith("📓");
      });
    });

    // LAZY: Only check for "All Notes" piece when menu is open
    const allNotesPiece = computed(() => {
      if (!menuOpen.get()) return null;
      return allPieces.find((piece: any) => {
        const name = piece?.[NAME];
        return typeof name === "string" && name.startsWith("All Notes");
      });
    });

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

    // ===== UI =====

    const editorUI = (
      <ct-code-editor
        $value={content}
        $mentionable={mentionable}
        $mentioned={mentioned}
        $pattern={patternJson}
        onbacklink-click={handlePieceLinkClick({})}
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
                display: computed(() =>
                  (self as any).parentNotebook ? "flex" : "none"
                ),
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
                label={computed(() => {
                  const p = (self as any).parentNotebook;
                  return p?.[NAME] ?? p?.title ?? "Notebook";
                })}
                interactive
                onct-click={goToParent}
              />
            </ct-hstack>

            <ct-hstack gap="3" style={{ alignItems: "center" }}>
              {/* Editable Title - click to edit */}
              <div
                style={{
                  display: computed(() =>
                    isEditingTitle.get() ? "none" : "flex"
                  ),
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
                  display: computed(() =>
                    isEditingTitle.get() ? "flex" : "none"
                  ),
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
                style={{
                  alignItems: "center",
                  padding: "6px 12px",
                  fontSize: "14px",
                  borderRadius: "8px",
                }}
                title="View as markdown"
              >
                View
              </ct-button>

              {/* New Note button */}
              <ct-button
                variant="ghost"
                onClick={createNewNote}
                style={{
                  alignItems: "center",
                  padding: "6px 12px",
                  fontSize: "14px",
                  borderRadius: "8px",
                  gap: "4px",
                }}
                title="Create new note"
              >
                📝 New
              </ct-button>

              <ct-button
                variant="ghost"
                onClick={toggleMenu}
                style={{
                  alignItems: "center",
                  padding: "8px 16px",
                  fontSize: "14px",
                  borderRadius: "8px",
                }}
              >
                Notebooks {"\u25BE"}
              </ct-button>

              {/* Backdrop to close menu */}
              <div
                onClick={closeMenu}
                style={{
                  display: computed(() => (menuOpen.get() ? "block" : "none")),
                  position: "fixed",
                  inset: "0",
                  zIndex: "999",
                }}
              />

              {/* Dropdown Menu */}
              <ct-vstack
                gap="0"
                style={{
                  display: computed(() => (menuOpen.get() ? "flex" : "none")),
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
                    {"\u00A0\u00A0"}
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
                    display: computed(() => (allNotesPiece ? "block" : "none")),
                    height: "1px",
                    background: "var(--ct-color-border, #e5e5e7)",
                    margin: "4px 8px",
                  }}
                />

                <ct-button
                  variant="ghost"
                  onClick={menuAllNotebooks}
                  style={{
                    display: computed(() => (allNotesPiece ? "flex" : "none")),
                    justifyContent: "flex-start",
                  }}
                >
                  {"\u00A0\u00A0"}📁 All Notes
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
      parentNotebook,
      isHidden,
      noteId,
      grep: patternTool(grepFn, { content }),
      translate: patternTool(translateFn, { content }),
      editContent,
      embeddedUI: editorUI,
    };
  },
);

export default Note;
