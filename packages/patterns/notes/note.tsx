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
  }
>(({ detail }, { mentionable }) => {
  console.log("new charm", detail.text, detail.charmId);

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

// Toggle sidebar menu (hamburger)
const toggleSidebar = handler<void, { sidebarOpen: Cell<boolean> }>(
  (_, { sidebarOpen }) => sidebarOpen.set(!sidebarOpen.get()),
);

// Close sidebar menu
const closeSidebar = handler<void, { sidebarOpen: Cell<boolean> }>(
  (_, { sidebarOpen }) => sidebarOpen.set(false),
);

// Navigate to a note from sidebar (closing sidebar via flattened sidebarItems)
const sidebarGoToNote = handler<
  void,
  { note: Cell<NoteCharm>; sidebarOpen: Cell<boolean> }
>((_, { note, sidebarOpen }) => {
  sidebarOpen.set(false);
  return navigateTo(note);
});

// Navigate to a notebook from sidebar (currently unused - kept for future use)
const _sidebarGoToNotebook = handler<
  void,
  { notebook: Cell<NotebookCharm>; sidebarOpen: Cell<boolean> }
>((_, { notebook, sidebarOpen }) => {
  sidebarOpen.set(false);
  return navigateTo(notebook);
});

// Menu: New Note
const menuNewNote = handler<
  void,
  { menuOpen: Cell<boolean>; allCharms: Cell<MinimalCharm[]> }
>((_, { menuOpen, allCharms }) => {
  menuOpen.set(false);
  const note = Note({
    title: "New Note",
    content: "",
    noteId: generateId(),
  });
  allCharms.push(note as unknown as MinimalCharm);
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

// Menu: Navigate to a recent note
const menuGoToRecentNote = handler<
  void,
  { menuOpen: Cell<boolean>; note: Cell<NoteCharm> }
>((_, { menuOpen, note }) => {
  menuOpen.set(false);
  return navigateTo(note);
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

    // Sidebar menu state (hamburger)
    const sidebarOpen = Cell.of(false);

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

    // Filter recent charms for notes only (📝 prefix), excluding current note
    const recentNotes = computed(() => {
      let myId = "";
      try {
        myId = JSON.parse(JSON.stringify(noteId)) as string;
      } catch { /* ignore */ }

      return (recentCharms ?? []).filter((charm: any) => {
        const name = charm?.[NAME];
        if (typeof name !== "string" || !name.startsWith("📝")) return false;
        // Exclude current note
        return charm?.noteId !== myId;
      }).slice(0, 5) as NoteCharm[]; // Limit to 5 recent
    });

    // Compute which notebooks contain this note by noteId
    const containingNotebookNames = computed(() => {
      // Get our noteId as a resolved string (proxies don't auto-resolve for own inputs)
      let myId: string;
      try {
        myId = JSON.parse(JSON.stringify(noteId)) as string;
      } catch {
        myId = "";
      }
      if (!myId) return [] as string[];

      const result: string[] = [];
      for (const nb of notebooks) {
        const nbNotes = (nb as any)?.notes ?? [];
        const nbName = (nb as any)?.[NAME] ?? "";
        for (const n of nbNotes) {
          if (n?.noteId === myId) {
            result.push(nbName);
            break;
          }
        }
      }
      return result;
    });

    // Compute the actual notebooks (with notes) that contain this note
    // Use .filter() to preserve proxy chain (manual push loses it)
    const containingNotebooks = computed(() => {
      let myId: string;
      try {
        myId = JSON.parse(JSON.stringify(noteId)) as string;
      } catch {
        myId = "";
      }
      if (!myId) return [] as NotebookCharm[];

      return notebooks.filter((nb) => {
        const nbNotes = (nb as any)?.notes ?? [];
        return nbNotes.some((n: any) => n?.noteId === myId);
      });
    });

    // Flattened sidebar items: notebooks and their notes in single array
    // Enables single-level map to pass sidebarOpen to handlers
    const sidebarItems = computed(() => {
      let myId = "";
      try {
        myId = JSON.parse(JSON.stringify(noteId)) as string;
      } catch { /* ignore parse errors */ }

      const items: Array<{
        note: NoteCharm;
        current: number; // 1 = yes, 0 = no
      }> = [];
      for (const notebook of containingNotebooks) {
        for (const note of (notebook.notes ?? []) as NoteCharm[]) {
          items.push({
            note,
            current: note?.noteId === myId ? 1 : 0,
          });
        }
      }
      return items;
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
        onbacklink-create={handleNewBacklink({ mentionable })}
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
            <ct-hstack
              gap="3"
              style={{ alignItems: "center" }}
            >
              {/* Hamburger menu button - only show if note is in at least one notebook */}
              <div
                style={{
                  display: computed(() =>
                    containingNotebooks.length > 0 ? "flex" : "none"
                  ),
                }}
              >
                <ct-button
                  variant="ghost"
                  onClick={toggleSidebar({ sidebarOpen })}
                  style={{
                    padding: "6px 8px",
                    minWidth: "32px",
                    borderRadius: "6px",
                  }}
                  title="Show notebook notes"
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "3px",
                      width: "18px",
                    }}
                  >
                    <div
                      style={{
                        height: "2px",
                        background: "currentColor",
                        borderRadius: "1px",
                      }}
                    />
                    <div
                      style={{
                        height: "2px",
                        background: "currentColor",
                        borderRadius: "1px",
                      }}
                    />
                    <div
                      style={{
                        height: "2px",
                        background: "currentColor",
                        borderRadius: "1px",
                      }}
                    />
                  </div>
                </ct-button>
              </div>

              {/* Sidebar backdrop */}
              <div
                onClick={closeSidebar({ sidebarOpen })}
                style={{
                  display: computed(
                    () => (sidebarOpen.get() ? "block" : "none"),
                  ),
                  position: "fixed",
                  inset: "0",
                  background: "rgba(0,0,0,0.3)",
                  zIndex: "998",
                }}
              />

              {/* Sidebar dropdown with notes grouped by notebook */}
              <ct-vstack
                gap="0"
                style={{
                  display: computed(
                    () => (sidebarOpen.get() ? "flex" : "none"),
                  ),
                  position: "fixed",
                  top: "60px",
                  left: "16px",
                  background: "var(--ct-color-bg, white)",
                  border: "1px solid var(--ct-color-border, #e5e5e7)",
                  borderRadius: "12px",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  minWidth: "220px",
                  maxWidth: "300px",
                  maxHeight: "70vh",
                  overflow: "auto",
                  zIndex: "1000",
                  padding: "8px 0",
                }}
              >
                {sidebarItems.map((item) => (
                  <ct-button
                    variant="ghost"
                    onClick={sidebarGoToNote({ note: item.note, sidebarOpen })}
                    style={{
                      justifyContent: "flex-start",
                      padding: "2px 16px",
                      fontSize: "13px",
                      opacity: item.current === 1 ? 0.5 : 1,
                    }}
                  >
                    {item.current === 1 ? "✓ " : "   "}
                    {item.note?.[NAME] ?? "Untitled"}
                  </ct-button>
                ))}
              </ct-vstack>

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
              <ct-button
                variant="ghost"
                onClick={toggleMenu({ menuOpen })}
                style={{
                  padding: "8px 16px",
                  fontSize: "16px",
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
                <ct-button
                  variant="ghost"
                  onClick={menuNewNote({ menuOpen, allCharms })}
                  style={{ justifyContent: "flex-start" }}
                >
                  {"\u00A0\u00A0"}📝 New Note
                </ct-button>

                {/* Recent Notes section - only show if there are recent notes */}
                <div
                  style={{
                    display: computed(() =>
                      recentNotes.length > 0 ? "block" : "none"
                    ),
                    height: "1px",
                    background: "var(--ct-color-border, #e5e5e7)",
                    margin: "4px 8px",
                  }}
                />
                <div
                  style={{
                    display: computed(() =>
                      recentNotes.length > 0 ? "block" : "none"
                    ),
                    padding: "4px 12px 2px",
                    fontSize: "11px",
                    color: "var(--ct-color-text-secondary, #666)",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  Recent
                </div>
                {recentNotes.map((note) => (
                  <ct-button
                    variant="ghost"
                    onClick={menuGoToRecentNote({ menuOpen, note })}
                    style={{ justifyContent: "flex-start", fontSize: "13px" }}
                  >
                    {"\u00A0\u00A0"}
                    {note[NAME]}
                  </ct-button>
                ))}

                {/* Divider */}
                <div
                  style={{
                    height: "1px",
                    background: "var(--ct-color-border, #e5e5e7)",
                    margin: "4px 8px",
                  }}
                />

                {/* List of notebooks with ✓ for membership */}
                {notebooks.map((notebook) => (
                  <ct-button
                    variant="ghost"
                    onClick={menuGoToNotebook({ menuOpen, notebook })}
                    style={{ justifyContent: "flex-start" }}
                  >
                    {"\u00A0\u00A0"}
                    {notebook[NAME]}
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
