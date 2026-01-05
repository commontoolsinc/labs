/// <cts-enable />
import {
  Cell,
  computed,
  type Default,
  generateText,
  handler,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  Stream,
  UI,
  type VNode,
  wish,
} from "commontools";
import NoteMd from "./note-md.tsx";

// Type for backlinks (inline to work around CLI path resolution bug)
type MentionableCharm = {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionableCharm[];
  backlinks: MentionableCharm[];
};

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

type MinimalCharm = {
  [NAME]?: string;
};

type NotebookCharm = {
  [NAME]?: string;
  notes?: NoteCharm[];
};

type NoteCharm = {
  [NAME]?: string;
  noteId?: string;
};

type Input = {
  title?: Cell<Default<string, "Untitled Note">>;
  content?: Cell<Default<string, "">>;
  isHidden?: Default<boolean, false>;
  noteId?: Default<string, "">;
  /** Pattern JSON for [[wiki-links]]. Defaults to creating new Notes. */
  linkPattern?: Cell<Default<string, "">>;
};

/** Represents a small #note a user took to remember some text. */
type Output = {
  mentioned: Default<Array<MentionableCharm>, []>;
  backlinks: MentionableCharm[];

  content: Default<string, "">;
  isHidden: Default<boolean, false>;
  noteId: Default<string, "">;
  grep: Stream<{ query: string }>;
  translate: Stream<{ language: string }>;
  editContent: Stream<{ detail: { value: string } }>;
  /** Minimal UI for embedding in containers like Record. Use via ct-render variant="embedded". */
  embeddedUI: VNode;
};

const _updateTitle = handler<
  { detail: { value: string } },
  { title: Cell<string> }
>(
  (event, state) => {
    state.title.set(event.detail?.value ?? "");
  },
);

const _updateContent = handler<
  { detail: { value: string } },
  { content: Cell<string> }
>(
  (event, state) => {
    state.content.set(event.detail?.value ?? "");
  },
);

const handleCharmLinkClick = handler<
  {
    detail: {
      charm: Cell<MentionableCharm>;
    };
  },
  Record<string, never>
>(({ detail }, _) => {
  return navigateTo(detail.charm);
});

const handleNewBacklink = handler<
  {
    detail: {
      text: string;
      charmId: any;
      charm: Cell<MentionableCharm>;
      navigate: boolean;
    };
  },
  {
    mentionable: Cell<MentionableCharm[]>;
    allCharms: Cell<MinimalCharm[]>;
  }
>(({ detail }, { mentionable, allCharms }) => {
  console.log("new charm", detail.text, detail.charmId);

  // Push to allCharms so it appears in default-app (this was the missing piece!)
  allCharms.push(detail.charm as unknown as MinimalCharm);

  if (detail.navigate) {
    return navigateTo(detail.charm);
  } else {
    mentionable.push(detail.charm as unknown as MentionableCharm);
  }
});

/** This edits the content */
const handleEditContent = handler<
  { detail: { value: string }; result?: Cell<string> },
  { content: Cell<string> }
>(
  ({ detail, result }, { content }) => {
    content.set(detail.value);
    result?.set("test!");
  },
);

const handleCharmLinkClicked = handler<void, { charm: Cell<MentionableCharm> }>(
  (_, { charm }) => {
    return navigateTo(charm);
  },
);

// Handler to start editing title
const startEditingTitle = handler<
  Record<string, never>,
  { isEditingTitle: Cell<boolean> }
>((_, { isEditingTitle }) => {
  isEditingTitle.set(true);
});

// Handler to stop editing title
const stopEditingTitle = handler<
  Record<string, never>,
  { isEditingTitle: Cell<boolean> }
>((_, { isEditingTitle }) => {
  isEditingTitle.set(false);
});

// Handler for keydown on title input (Enter to save)
const handleTitleKeydown = handler<
  { key?: string },
  { isEditingTitle: Cell<boolean> }
>((event, { isEditingTitle }) => {
  if (event?.key === "Enter") {
    isEditingTitle.set(false);
  }
});

// Toggle dropdown menu
const toggleMenu = handler<void, { menuOpen: Cell<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(!menuOpen.get()),
);

// Close dropdown menu
const closeMenu = handler<void, { menuOpen: Cell<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(false),
);

// Create new note (adds to parent notebook if present)
const createNewNote = handler<
  void,
  {
    allCharms: Cell<MinimalCharm[]>;
    parentNotebook: Cell<NotebookCharm | null>;
  }
>((_, { allCharms, parentNotebook }) => {
  const notebook = parentNotebook?.get?.();

  const note = Note({
    title: "New Note",
    content: "",
    noteId: generateId(),
    isHidden: !!notebook, // Hide from default-app if in a notebook
  });
  allCharms.push(note as unknown as MinimalCharm);

  // Add to parent notebook using Cell.key() pattern
  if (notebook) {
    const charmsList = allCharms.get();
    const nbName = (notebook as any)?.[NAME];
    const nbIndex = charmsList.findIndex((c: any) =>
      (c as any)?.[NAME] === nbName
    );
    if (nbIndex >= 0) {
      const notebookCell = allCharms.key(nbIndex);
      const notesCell = notebookCell.key("notes") as Cell<NoteCharm[]>;
      notesCell.push(note as unknown as NoteCharm);
    }
  }

  return navigateTo(note);
});

// Menu: Navigate to a notebook
const menuGoToNotebook = handler<
  void,
  { menuOpen: Cell<boolean>; notebook: Cell<MinimalCharm> }
>((_, { menuOpen, notebook }) => {
  menuOpen.set(false);
  return navigateTo(notebook);
});

// Navigate to parent notebook
const goToParent = handler<void, { parent: Cell<NotebookCharm> }>(
  (_, { parent }) => navigateTo(parent),
);

// Menu: All Notes (find existing only - can't create due to circular imports)
const menuAllNotebooks = handler<
  void,
  { menuOpen: Cell<boolean>; allCharms: Cell<MinimalCharm[]> }
>((_, { menuOpen, allCharms }) => {
  menuOpen.set(false);
  const charms = allCharms.get();
  const existing = charms.find((charm: any) => {
    const name = charm?.[NAME];
    return typeof name === "string" && name.startsWith("All Notes");
  });
  if (existing) {
    return navigateTo(existing);
  }
  // Can't create NotesImportExport here due to circular imports
  // User should create it from default-app first
});

const Note = pattern<Input, Output>(
  ({ title, content, isHidden, noteId, linkPattern }) => {
    const { allCharms } = wish<{ allCharms: MinimalCharm[] }>("/");
    const mentionable = wish<Default<MentionableCharm[], []>>(
      "#mentionable",
    );
    const recentCharms = wish<MinimalCharm[]>("#recent");
    const mentioned = Cell.of<MentionableCharm[]>([]);

    // Dropdown menu state
    const menuOpen = Cell.of(false);

    // State for inline title editing
    const isEditingTitle = Cell.of<boolean>(false);

    // Filter to find all notebooks (using 📓 prefix in NAME)
    const notebooks = computed(() =>
      allCharms.filter((charm: any) => {
        const name = charm?.[NAME];
        return typeof name === "string" && name.startsWith("📓");
      }) as unknown as NotebookCharm[]
    );

    // Check if "All Notes" charm exists in the space
    const allNotesCharm = computed(() =>
      allCharms.find((charm: any) => {
        const name = charm?.[NAME];
        return typeof name === "string" && name.startsWith("All Notes");
      })
    );

    // Compute which notebooks contain this note by noteId
    const containingNotebookNames = computed(() => {
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

    // Compute actual notebook references that contain this note
    const containingNotebooks = computed(() => {
      const myId = noteId; // CTS handles Cell unwrapping
      if (!myId) return []; // Can't match if we have no noteId
      return notebooks.filter((nb) => {
        const nbNotes = (nb as any)?.notes ?? [];
        return nbNotes.some((n: any) => n?.noteId && n.noteId === myId);
      });
    });

    // Find parent notebook: prioritize most recently visited, fall back to first
    const parentNotebook = computed(() => {
      if (containingNotebooks.length === 0) return null;

      // Find most recent notebook that contains this note
      for (const recent of (recentCharms ?? [])) {
        const name = (recent as any)?.[NAME];
        if (typeof name === "string" && name.startsWith("📓")) {
          if (containingNotebooks.some((nb: any) => nb?.[NAME] === name)) {
            return recent;
          }
        }
      }
      // Fall back to first containing notebook
      return containingNotebooks[0];
    });

    // populated in backlinks-index.tsx
    const backlinks = Cell.of<MentionableCharm[]>([]);

    // Use provided linkPattern or default to creating new Notes
    // linkPattern is a Cell<string> - access reactively, not as raw string
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
        onbacklink-click={handleCharmLinkClick({})}
        onbacklink-create={handleNewBacklink({ mentionable, allCharms })}
        language="text/markdown"
        theme="light"
        wordWrap
        tabIndent
        lineNumbers
      />
    );

    // Handler that creates NoteMd dynamically when clicked (not during pattern construction)
    // This avoids the sub-recipe serialization issue with $pattern
    const goToViewer = handler<
      void,
      {
        title: Cell<string>;
        content: Cell<string>;
        backlinks: Cell<MentionableCharm[]>;
        noteId: Cell<string>;
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
        }),
      );
    });

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
            <ct-hstack
              gap="3"
              style={{ alignItems: "center" }}
            >
              {/* Parent notebook button */}
              <ct-button
                variant="ghost"
                onClick={goToParent({ parent: parentNotebook })}
                style={{
                  display: computed(() => (parentNotebook ? "flex" : "none")),
                  alignItems: "center",
                  padding: "6px 8px",
                  fontSize: "16px",
                }}
                title={computed(() =>
                  `Go to ${parentNotebook?.[NAME] ?? "notebook"}`
                )}
              >
                ⬆️
              </ct-button>

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
                onClick={goToViewer({ title, content, backlinks, noteId })}
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
                onClick={createNewNote({ allCharms, parentNotebook })}
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

                {/* Divider + All Notes - only show if All Notes charm exists */}
                <div
                  style={{
                    display: computed(() => allNotesCharm ? "block" : "none"),
                    height: "1px",
                    background: "var(--ct-color-border, #e5e5e7)",
                    margin: "4px 8px",
                  }}
                />

                <ct-button
                  variant="ghost"
                  onClick={menuAllNotebooks({ menuOpen, allCharms })}
                  style={{
                    display: computed(() => allNotesCharm ? "flex" : "none"),
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
            {backlinks?.map((charm) => (
              <ct-button
                onClick={handleCharmLinkClicked({ charm })}
              >
                {charm?.[NAME]}
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
      grep: patternTool(
        ({ query, content }: { query: string; content: string }) => {
          return computed(() => {
            return content.split("\n").filter((c) => c.includes(query));
          });
        },
        { content },
      ),
      translate: patternTool(
        (
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
            if (genResult.result == null) return "Error occured";
            return genResult.result;
          });
        },
        { content },
      ),
      editContent: handleEditContent({ content }),
      // Minimal UI for embedding in containers (e.g., Record modules)
      embeddedUI: editorUI,
    };
  },
);

export default Note;
