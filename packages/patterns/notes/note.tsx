/// <cts-enable />
import {
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

// Type for backlinks (inline to work around CLI path resolution bug)
type MentionablePiece = {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionablePiece[];
  backlinks: MentionablePiece[];
};

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

type MinimalPiece = {
  [NAME]?: string;
};

type NotebookPiece = {
  [NAME]?: string;
  notes?: NotePiece[];
};

type NotePiece = {
  [NAME]?: string;
  noteId?: string;
};

type Input = {
  title?: Writable<Default<string, "Untitled Note">>;
  content?: Writable<Default<string, "">>;
  isHidden?: Default<boolean, false>;
  noteId?: Default<string, "">;
  /** Pattern JSON for [[wiki-links]]. Defaults to creating new Notes. */
  linkPattern?: Writable<Default<string, "">>;
  /** Parent notebook reference (passed via SELF from notebook.tsx) */
  parentNotebook?: any;
};

/** Represents a small #note a user took to remember some text. */
type Output = {
  [NAME]?: string;
  [UI]: VNode;
  mentioned: Default<Array<MentionablePiece>, []>;
  backlinks: MentionablePiece[];
  parentNotebook: any; // Reference to parent notebook (set on navigation for back link)

  content: Default<string, "">;
  isHidden: Default<boolean, false>;
  noteId: Default<string, "">;
  grep: PatternToolResult<{ content: string }>;
  translate: PatternToolResult<{ content: string }>;
  editContent: Stream<{ detail: { value: string } }>;
  /** Minimal UI for embedding in containers like Record. Use via ct-render variant="embedded". */
  embeddedUI: VNode;
};

const _updateTitle = handler<
  { detail: { value: string } },
  { title: Writable<string> }
>(
  (event, state) => {
    state.title.set(event.detail?.value ?? "");
  },
);

const _updateContent = handler<
  { detail: { value: string } },
  { content: Writable<string> }
>(
  (event, state) => {
    state.content.set(event.detail?.value ?? "");
  },
);

const handlePieceLinkClick = handler<
  {
    detail: {
      piece: Writable<MentionablePiece>;
    };
  },
  Record<string, never>
>(({ detail }, _) => {
  return navigateTo(detail.piece);
});

const handleNewBacklink = handler<
  {
    detail: {
      text: string;
      pieceId: any;
      piece: Writable<MentionablePiece>;
      navigate: boolean;
    };
  },
  {
    mentionable: Writable<MentionablePiece[]>;
    allPieces: Writable<MinimalPiece[]>;
  }
>(({ detail }, { mentionable, allPieces }) => {
  console.log("new piece", detail.text, detail.pieceId);

  // Push to allPieces so it appears in default-app (this was the missing piece!)
  allPieces.push(detail.piece);

  if (detail.navigate) {
    return navigateTo(detail.piece);
  } else {
    mentionable.push(detail.piece);
  }
});

/** This edits the content */
const handleEditContent = handler<
  { detail: { value: string }; result?: Writable<string> },
  { content: Writable<string> }
>(
  ({ detail, result }, { content }) => {
    content.set(detail.value);
    result?.set("test!");
  },
);

const handlePieceLinkClicked = handler<
  void,
  { piece: Writable<MentionablePiece> }
>(
  (_, { piece }) => {
    return navigateTo(piece);
  },
);

// Handler to start editing title
const startEditingTitle = handler<
  Record<string, never>,
  { isEditingTitle: Writable<boolean> }
>((_, { isEditingTitle }) => {
  isEditingTitle.set(true);
});

// Handler to stop editing title
const stopEditingTitle = handler<
  Record<string, never>,
  { isEditingTitle: Writable<boolean> }
>((_, { isEditingTitle }) => {
  isEditingTitle.set(false);
});

// Handler for keydown on title input (Enter to save)
const handleTitleKeydown = handler<
  { key?: string },
  { isEditingTitle: Writable<boolean> }
>((event, { isEditingTitle }) => {
  if (event?.key === "Enter") {
    isEditingTitle.set(false);
  }
});

// Toggle dropdown menu
const toggleMenu = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(!menuOpen.get()),
);

// Close dropdown menu
const closeMenu = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(false),
);

// Create new note (adds to parent notebook if present)
const createNewNote = handler<
  void,
  {
    allPieces: Writable<MinimalPiece[]>;
    parentNotebook: Writable<NotebookPiece | null>;
  }
>((_, { allPieces, parentNotebook }) => {
  const notebook = parentNotebook?.get?.();

  const note = Note({
    title: "New Note",
    content: "",
    noteId: generateId(),
    isHidden: !!notebook, // Hide from default-app if in a notebook
    parentNotebook: notebook ?? undefined, // Set parent for back navigation
  });
  allPieces.push(note);

  // Add to parent notebook using Cell.key() pattern
  if (notebook) {
    const piecesList = allPieces.get();
    const nbName = (notebook as any)?.[NAME];
    const nbIndex = piecesList.findIndex((c: any) =>
      (c as any)?.[NAME] === nbName
    );
    if (nbIndex >= 0) {
      const notebookCell = allPieces.key(nbIndex);
      const notesCell = notebookCell.key("notes");
      notesCell.push(note);
    }
  }

  return navigateTo(note);
});

// Menu: Navigate to a notebook
const menuGoToNotebook = handler<
  void,
  { menuOpen: Writable<boolean>; notebook: Writable<MinimalPiece> }
>((_, { menuOpen, notebook }) => {
  menuOpen.set(false);
  return navigateTo(notebook);
});

// Navigate to parent notebook
const goToParent = handler<Record<string, never>, { self: any }>(
  (_, { self }) => {
    const p = (self as any).parentNotebook;
    if (p) navigateTo(p);
  },
);

// Handler that creates NoteMd dynamically when clicked (not during pattern construction)
// This avoids the sub-recipe serialization issue with $pattern
const goToViewer = handler<
  void,
  {
    title: Writable<string>;
    content: Writable<string>;
    backlinks: Writable<MentionablePiece[]>;
    noteId: Writable<string>;
    self: any;
  }
>((_, state) => {
  return navigateTo(
    NoteMd({
      note: {
        title: state.title,
        content: state.content,
        backlinks: state.backlinks,
        noteId: state.noteId,
      },
      // Pass direct reference to source note for Edit button
      sourceNoteRef: state.self,
      // Pass content Writable for checkbox updates
      content: state.content,
    }),
  );
});

// Grep function for patternTool - filters content lines by query
const grepFn = (
  { query, content }: { query: string; content: string },
) => {
  return computed(() => {
    return content.split("\n").filter((c) => c.includes(query));
  });
};

// Translate function for patternTool - translates content to specified language
const translateFn = (
  { language, content }: {
    language: string;
    content: string;
  },
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

// Menu: All Notes (find existing only - can't create due to circular imports)
const menuAllNotebooks = handler<
  void,
  { menuOpen: Writable<boolean>; allPieces: Writable<MinimalPiece[]> }
>((_, { menuOpen, allPieces }) => {
  menuOpen.set(false);
  const pieces = allPieces.get();
  const existing = pieces.find((piece: any) => {
    const name = piece?.[NAME];
    return typeof name === "string" && name.startsWith("All Notes");
  });
  if (existing) {
    return navigateTo(existing);
  }
  // Can't create NotesImportExport here due to circular imports
  // User should create it from default-app first
});

const Note = pattern<Input, Output>(
  (
    {
      title,
      content,
      isHidden,
      noteId,
      linkPattern,
      parentNotebook: parentNotebookProp,
      [SELF]: self,
    },
  ) => {
    const { allPieces } = wish<{ allPieces: MinimalPiece[] }>("#default");
    const mentionable = wish<Default<MentionablePiece[], []>>(
      "#mentionable",
    );
    const _recentPieces = wish<MinimalPiece[]>("#recent");
    const mentioned = Writable.of<MentionablePiece[]>([]);

    // Dropdown menu state
    const menuOpen = Writable.of(false);

    // State for inline title editing
    const isEditingTitle = Writable.of<boolean>(false);

    // LAZY: Only filter notebooks when menu is open (dropdown needs them)
    // This avoids O(n) filter on every allPieces change for every note
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
    // This avoids O(n*m) computation on every allPieces change
    const containingNotebookNames = computed(() => {
      // Only compute when menu is actually open
      if (!menuOpen.get()) return [];

      const myId = noteId; // CTS handles Cell unwrapping
      if (!myId) return []; // Can't match if we have no noteId
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

    // Parent notebook: use direct reference (set when navigating from notebook)
    // No expensive fallback - if parentNotebook isn't set, it's null
    const parentNotebook = computed(() => {
      // Read from self.parentNotebook for reactive updates when navigating
      const selfParent = (self as any)?.parentNotebook;
      if (selfParent) return selfParent;

      // If parent was passed explicitly as prop, use it
      if (parentNotebookProp) return parentNotebookProp;

      // No expensive fallback - just return null if not set
      return null;
    });

    // populated in backlinks-index.tsx
    const backlinks = Writable.of<MentionablePiece[]>([]);

    // Use provided linkPattern or default to creating new Notes
    // linkPattern is a Writable<string> - access reactively, not as raw string
    const patternJson = computed(() => {
      // deno-lint-ignore no-explicit-any
      const lpValue = (linkPattern as any)?.get?.() ?? linkPattern;
      const custom = typeof lpValue === "string" ? lpValue.trim() : "";
      return custom || JSON.stringify(Note);
    });

    // Editor component - used in both full UI and embeddedUI
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
            {/* Parent notebook chip - shows where we navigated from */}
            <ct-hstack
              gap="2"
              align="center"
              style={{
                display: computed(() => {
                  const p = (self as any).parentNotebook;
                  return p ? "flex" : "none";
                }),
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
                onct-click={goToParent({ self })}
              />
            </ct-hstack>

            <ct-hstack
              gap="3"
              style={{ alignItems: "center" }}
            >
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
                onClick={startEditingTitle({ isEditingTitle })}
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
                  onct-blur={stopEditingTitle({ isEditingTitle })}
                  onct-keydown={handleTitleKeydown({ isEditingTitle })}
                />
              </div>

              {/* View Mode button */}
              <ct-button
                variant="ghost"
                onClick={goToViewer({
                  title,
                  content,
                  backlinks,
                  noteId,
                  self,
                })}
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
                onClick={createNewNote({ allPieces, parentNotebook })}
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
                onClick={toggleMenu({ menuOpen })}
                style={{
                  alignItems: "center",
                  padding: "8px 16px",
                  fontSize: "14px",
                  borderRadius: "8px",
                }}
              >
                Notebooks {"\u25BE"}
              </ct-button>

              {/* Backdrop to close menu when clicking outside */}
              <div
                onClick={closeMenu({ menuOpen })}
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
                {/* List of notebooks with ✓ for membership */}
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
                    display: computed(() => allNotesPiece ? "block" : "none"),
                    height: "1px",
                    background: "var(--ct-color-border, #e5e5e7)",
                    margin: "4px 8px",
                  }}
                />

                <ct-button
                  variant="ghost"
                  onClick={menuAllNotebooks({ menuOpen, allPieces })}
                  style={{
                    display: computed(() => allNotesPiece ? "flex" : "none"),
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
              <ct-button
                onClick={handlePieceLinkClicked({ piece })}
              >
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
      editContent: handleEditContent({ content }),
      // Minimal UI for embedding in containers (e.g., Record modules)
      embeddedUI: editorUI,
    };
  },
);

export default Note;
