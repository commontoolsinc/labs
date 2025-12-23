/// <cts-enable />
import {
  Cell,
  computed,
  type Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  wish,
} from "commontools";

import Note from "./note.tsx";

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

type NoteCharm = {
  [NAME]?: string;
  title?: string;
  content?: string;
  isHidden?: boolean;
  noteId?: string;
};

type MinimalCharm = {
  [NAME]?: string;
};

interface Input {
  title?: Default<string, "Notebook">;
  notes?: Default<NoteCharm[], []>;
  isNotebook?: Default<boolean, true>; // Marker for identification through proxy
}

interface Output {
  title: string;
  notes: NoteCharm[];
  noteCount: number;
  isNotebook: boolean;
  // LLM-callable streams for omnibot integration
  createNote: Stream<{ title: string; content: string }>;
  createNotes: Stream<{ notesData: Array<{ title: string; content: string }> }>;
  setTitle: Stream<{ newTitle: string }>;
  createNotebook: Stream<{
    title: string;
    notesData?: Array<{ title: string; content: string }>;
  }>;
}

// Handler to create a new note within this notebook (hidden from default-app)
const addNote = handler<
  Record<string, never>,
  { notes: Cell<NoteCharm[]>; allCharms: Cell<NoteCharm[]> }
>((_, { notes, allCharms }) => {
  const newNote = Note({
    title: "New Note",
    content: "",
    isHidden: true,
    noteId: generateId(),
  });
  // Push to allCharms first to persist in space
  allCharms.push(newNote as unknown as NoteCharm);
  // Then add to this notebook's notes
  notes.push(newNote as unknown as NoteCharm);
});

// Handler to toggle note visibility in default-app listing
const toggleNoteVisibility = handler<
  Record<string, never>,
  { note: Cell<NoteCharm> }
>((_, { note }) => {
  const isHiddenCell = note.key("isHidden");
  const current = isHiddenCell.get() ?? false;
  isHiddenCell.set(!current);
});

// Handler to remove a note from this notebook (but keep it in the space)
const removeFromNotebook = handler<
  Record<string, never>,
  { note: Cell<NoteCharm>; notes: Cell<NoteCharm[]> }
>((_, { note, notes }) => {
  const notebookNotes = notes.get();
  const index = notebookNotes.findIndex((n: any) => Cell.equals(n, note));
  if (index !== -1) {
    const copy = [...notebookNotes];
    copy.splice(index, 1);
    notes.set(copy);
  }
  // Make it visible in the space again
  note.key("isHidden").set(false);
});

// Toggle dropdown menu
const toggleMenu = handler<void, { menuOpen: Cell<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(!menuOpen.get()),
);

// Close dropdown menu
const closeMenu = handler<void, { menuOpen: Cell<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(false),
);

// Menu: New Note (adds to this notebook)
const menuNewNote = handler<
  void,
  {
    menuOpen: Cell<boolean>;
    notes: Cell<NoteCharm[]>;
    allCharms: Cell<NoteCharm[]>;
  }
>((_, { menuOpen, notes, allCharms }) => {
  menuOpen.set(false);
  const newNote = Note({
    title: "New Note",
    content: "",
    isHidden: true,
    noteId: generateId(),
  });
  allCharms.push(newNote as unknown as NoteCharm);
  notes.push(newNote as unknown as NoteCharm);
});

// Menu: New Notebook
const menuNewNotebook = handler<
  void,
  { menuOpen: Cell<boolean>; allCharms: Cell<NoteCharm[]> }
>((_, { menuOpen, allCharms }) => {
  menuOpen.set(false);
  const nb = Notebook({ title: "New Notebook" });
  allCharms.push(nb as unknown as NoteCharm);
  return navigateTo(nb);
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
  { menuOpen: Cell<boolean>; allCharms: Cell<NoteCharm[]> }
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

// Handler to select all notes in this notebook
const selectAllNotes = handler<
  Record<string, never>,
  { notes: Cell<NoteCharm[]>; selectedNoteIndices: Cell<number[]> }
>((_, { notes, selectedNoteIndices }) => {
  const notesList = notes.get();
  selectedNoteIndices.set(notesList.map((_, i) => i));
});

// Handler to deselect all notes
const deselectAllNotes = handler<
  Record<string, never>,
  { selectedNoteIndices: Cell<number[]> }
>((_, { selectedNoteIndices }) => {
  selectedNoteIndices.set([]);
});

// Handler to duplicate selected notes
const duplicateSelectedNotes = handler<
  Record<string, never>,
  {
    notes: Cell<NoteCharm[]>;
    selectedNoteIndices: Cell<number[]>;
    allCharms: Cell<NoteCharm[]>;
  }
>((_, { notes, selectedNoteIndices, allCharms }) => {
  const selected = selectedNoteIndices.get();
  const notesList = notes.get();

  for (const idx of selected) {
    const original = notesList[idx];
    if (original) {
      const copy = Note({
        title: (original.title ?? "Note") + " (Copy)",
        content: original.content ?? "",
        isHidden: true,
        noteId: generateId(),
      });
      allCharms.push(copy as unknown as NoteCharm);
      notes.push(copy as unknown as NoteCharm);
    }
  }
  selectedNoteIndices.set([]);
});

type NotebookCharm = {
  [NAME]?: string;
  notes?: NoteCharm[];
};

// Handler to permanently delete selected notes from the space
const deleteSelectedNotes = handler<
  Record<string, never>,
  {
    notes: Cell<NoteCharm[]>;
    selectedNoteIndices: Cell<number[]>;
    allCharms: Cell<NoteCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
  }
>((_, { notes, selectedNoteIndices, allCharms, notebooks }) => {
  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const allCharmsList = allCharms.get();
  const notebooksList = notebooks.get();

  // Collect noteIds to delete
  const noteIdsToDelete: string[] = [];
  for (const idx of selected) {
    const note = notesList[idx];
    const noteId = (note as any)?.noteId;
    if (noteId) noteIdsToDelete.push(noteId);
  }

  // Remove from all notebooks first (including this one)
  for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
    const nbCell = notebooks.key(nbIdx);
    const nbNotesCell = nbCell.key("notes");
    const nbNotes = nbNotesCell.get() ?? [];

    const filtered = nbNotes.filter((n: any) =>
      !noteIdsToDelete.includes(n?.noteId)
    );
    if (filtered.length !== nbNotes.length) {
      nbNotesCell.set(filtered);
    }
  }

  // Also remove from this notebook's notes array
  const filteredNotes = notesList.filter((n: any) =>
    !noteIdsToDelete.includes(n?.noteId)
  );
  notes.set(filteredNotes);

  // Remove from allCharms (permanent delete)
  const filteredCharms = allCharmsList.filter((charm: any) => {
    const noteId = charm?.noteId;
    return !noteId || !noteIdsToDelete.includes(noteId);
  });
  allCharms.set(filteredCharms);

  selectedNoteIndices.set([]);
});

// Handler to add selected notes to another notebook
const addSelectedToNotebook = handler<
  { target?: { value: string }; detail?: { value: string } },
  {
    notes: Cell<NoteCharm[]>;
    selectedNoteIndices: Cell<number[]>;
    notebooks: Cell<NotebookCharm[]>;
    selectedAddNotebook: Cell<string>;
    showNewNotebookPrompt: Cell<boolean>;
    pendingNotebookAction: Cell<"add" | "move" | "">;
  }
>((
  event,
  {
    notes,
    selectedNoteIndices,
    notebooks,
    selectedAddNotebook,
    showNewNotebookPrompt,
    pendingNotebookAction,
  },
) => {
  // Handle both native select (target.value) and ct-select (detail.value)
  const value = event.target?.value ?? event.detail?.value ?? "";
  if (!value) return;

  // Handle "new-*" - show prompt to get name from user
  if (value === "new") {
    pendingNotebookAction.set("add");
    showNewNotebookPrompt.set(true);
    selectedAddNotebook.set("");
    return;
  }

  // Add to existing notebook
  const nbIndex = parseInt(value, 10);
  if (nbIndex < 0) return;

  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const targetNotebookCell = notebooks.key(nbIndex);
  const targetNotebookNotes = targetNotebookCell.key("notes");

  for (const idx of selected) {
    const note = notesList[idx];
    if (note) {
      (targetNotebookNotes as Cell<NoteCharm[] | undefined>).push(note);
    }
  }

  selectedNoteIndices.set([]);
  selectedAddNotebook.set("");
});

// Handler to move selected notes to another notebook (remove from current)
const moveSelectedToNotebook = handler<
  { target?: { value: string }; detail?: { value: string } },
  {
    notes: Cell<NoteCharm[]>;
    selectedNoteIndices: Cell<number[]>;
    notebooks: Cell<NotebookCharm[]>;
    selectedMoveNotebook: Cell<string>;
    showNewNotebookPrompt: Cell<boolean>;
    pendingNotebookAction: Cell<"add" | "move" | "">;
  }
>((
  event,
  {
    notes,
    selectedNoteIndices,
    notebooks,
    selectedMoveNotebook,
    showNewNotebookPrompt,
    pendingNotebookAction,
  },
) => {
  // Handle both native select (target.value) and ct-select (detail.value)
  const value = event.target?.value ?? event.detail?.value ?? "";
  if (!value) return;

  // Handle "new-*" - show prompt to get name from user
  if (value === "new") {
    pendingNotebookAction.set("move");
    showNewNotebookPrompt.set(true);
    selectedMoveNotebook.set("");
    return;
  }

  // Move to existing notebook
  const nbIndex = parseInt(value, 10);
  if (nbIndex < 0) return;

  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const notebooksList = notebooks.get();
  const targetNotebookCell = notebooks.key(nbIndex);
  const targetNotebookNotes = targetNotebookCell.key("notes");

  // Get noteIds of selected notes
  const selectedNoteIds: string[] = [];
  for (const idx of selected) {
    const note = notesList[idx];
    const noteId = (note as any)?.noteId;
    if (noteId) selectedNoteIds.push(noteId);
    // Add to target notebook
    if (note) (targetNotebookNotes as Cell<NoteCharm[] | undefined>).push(note);
  }

  // Remove from all notebooks
  for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
    // Don't remove from the target notebook we just added to
    if (nbIdx === nbIndex) continue;

    const nbCell = notebooks.key(nbIdx);
    const nbNotesCell = nbCell.key("notes");
    const nbNotes = nbNotesCell.get() ?? [];

    const filtered = nbNotes.filter((n: any) =>
      !selectedNoteIds.includes(n?.noteId)
    );
    if (filtered.length !== nbNotes.length) {
      nbNotesCell.set(filtered);
    }
  }

  // Remove from this notebook
  const filtered = notesList.filter((n: any) =>
    !selectedNoteIds.includes(n?.noteId)
  );
  notes.set(filtered);

  selectedNoteIndices.set([]);
  selectedMoveNotebook.set("");
});

// Handler to create notebook from prompt and add/move selected notes
const createNotebookFromPrompt = handler<
  void,
  {
    newNotebookName: Cell<string>;
    showNewNotebookPrompt: Cell<boolean>;
    pendingNotebookAction: Cell<"add" | "move" | "">;
    selectedNoteIndices: Cell<number[]>;
    notes: Cell<NoteCharm[]>;
    allCharms: Cell<MinimalCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
  }
>((_, state) => {
  const {
    newNotebookName,
    showNewNotebookPrompt,
    pendingNotebookAction,
    selectedNoteIndices,
    notes,
    allCharms,
    notebooks,
  } = state;

  const name = newNotebookName.get().trim() || "New Notebook";
  const action = pendingNotebookAction.get();

  // Gather selected notes first
  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const selectedNotes: NoteCharm[] = [];
  const selectedNoteIds: string[] = [];

  for (const idx of selected) {
    const note = notesList[idx];
    if (note) {
      selectedNotes.push(note);
      const noteId = (note as any)?.noteId;
      if (noteId) selectedNoteIds.push(noteId);
    }
  }

  // Create the notebook with notes already included
  const newNotebook = Notebook({ title: name, notes: selectedNotes });
  allCharms.push(newNotebook as unknown as MinimalCharm);

  if (action === "move") {
    // For move: remove from existing notebooks and this notebook
    const notebooksList = notebooks.get();

    // Remove from all existing notebooks
    for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
      const nbCell = notebooks.key(nbIdx);
      const nbNotesCell = nbCell.key("notes");
      const nbNotes = nbNotesCell.get() ?? [];
      const filtered = nbNotes.filter((n: any) =>
        !selectedNoteIds.includes(n?.noteId)
      );
      if (filtered.length !== nbNotes.length) {
        nbNotesCell.set(filtered);
      }
    }

    // Remove from this notebook
    const filtered = notesList.filter((n: any) =>
      !selectedNoteIds.includes(n?.noteId)
    );
    notes.set(filtered);
  }
  // For add: notes are already in the new notebook, no removal needed

  // Clean up state
  selectedNoteIndices.set([]);
  newNotebookName.set("");
  pendingNotebookAction.set("");
  showNewNotebookPrompt.set(false);
});

// Handler to cancel new notebook prompt
const cancelNewNotebookPrompt = handler<
  void,
  {
    showNewNotebookPrompt: Cell<boolean>;
    newNotebookName: Cell<string>;
    pendingNotebookAction: Cell<"add" | "move" | "">;
    selectedAddNotebook: Cell<string>;
    selectedMoveNotebook: Cell<string>;
  }
>((_, state) => {
  state.showNewNotebookPrompt.set(false);
  state.newNotebookName.set("");
  state.pendingNotebookAction.set("");
  state.selectedAddNotebook.set("");
  state.selectedMoveNotebook.set("");
});

// Handler to toggle visibility of all selected notes
const _toggleSelectedVisibility = handler<
  { detail: { checked: boolean } },
  { notes: Cell<NoteCharm[]>; selectedNoteIndices: Cell<number[]> }
>((event, { notes, selectedNoteIndices }) => {
  const selected = selectedNoteIndices.get();
  const makeVisible = event.detail?.checked ?? false;
  for (const idx of selected) {
    const noteCell = notes.key(idx);
    if (noteCell) {
      noteCell.key("isHidden").set(!makeVisible);
    }
  }
  selectedNoteIndices.set([]);
});

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

// Handler to toggle checkbox selection with shift-click support
const toggleNoteCheckbox = handler<
  { shiftKey?: boolean },
  {
    index: number;
    selectedNoteIndices: Cell<number[]>;
    lastSelectedNoteIndex: Cell<number>;
  }
>((event, { index, selectedNoteIndices, lastSelectedNoteIndex }) => {
  const current = selectedNoteIndices.get();
  const lastIdx = lastSelectedNoteIndex.get();

  if (event?.shiftKey && lastIdx >= 0 && lastIdx !== index) {
    const start = Math.min(lastIdx, index);
    const end = Math.max(lastIdx, index);
    const range: number[] = [];
    for (let i = start; i <= end; i++) {
      range.push(i);
    }
    selectedNoteIndices.set([...new Set([...current, ...range])]);
  } else {
    const idx = current.indexOf(index);
    if (idx >= 0) {
      selectedNoteIndices.set(current.filter((i: number) => i !== index));
    } else {
      selectedNoteIndices.set([...current, index]);
    }
  }
  lastSelectedNoteIndex.set(index);
});

// LLM-callable handler: Create a single note in this notebook
const handleCreateNote = handler<
  { title: string; content: string },
  { notes: Cell<NoteCharm[]>; allCharms: Cell<NoteCharm[]> }
>(({ title: noteTitle, content }, { notes, allCharms }) => {
  const newNote = Note({
    title: noteTitle,
    content,
    isHidden: true,
    noteId: generateId(),
  });
  allCharms.push(newNote as unknown as NoteCharm);
  notes.push(newNote as unknown as NoteCharm);
  return newNote;
});

// LLM-callable handler: Create multiple notes in bulk
const handleCreateNotes = handler<
  { notesData: Array<{ title: string; content: string }> },
  { notes: Cell<NoteCharm[]>; allCharms: Cell<NoteCharm[]> }
>(({ notesData }, { notes, allCharms }) => {
  const created: NoteCharm[] = [];
  for (const data of notesData) {
    const newNote = Note({
      title: data.title,
      content: data.content,
      isHidden: true,
      noteId: generateId(),
    });
    allCharms.push(newNote as unknown as NoteCharm);
    notes.push(newNote as unknown as NoteCharm);
    created.push(newNote as unknown as NoteCharm);
  }
  return created;
});

// LLM-callable handler: Rename the notebook
const handleSetTitle = handler<
  { newTitle: string },
  { title: Cell<string> }
>(({ newTitle }, { title }) => {
  title.set(newTitle);
  return newTitle;
});

// LLM-callable handler: Create a new notebook (optionally with notes)
const handleCreateNotebook = handler<
  { title: string; notesData?: Array<{ title: string; content: string }> },
  { allCharms: Cell<NoteCharm[]> }
>(({ title: nbTitle, notesData }, { allCharms }) => {
  // Create notes if provided
  const notesToAdd: NoteCharm[] = [];
  if (notesData && notesData.length > 0) {
    for (const data of notesData) {
      const newNote = Note({
        title: data.title,
        content: data.content,
        isHidden: true,
        noteId: generateId(),
      });
      allCharms.push(newNote as unknown as NoteCharm);
      notesToAdd.push(newNote as unknown as NoteCharm);
    }
  }

  // Create the notebook with the notes
  const newNotebook = Notebook({
    title: nbTitle,
    notes: notesToAdd,
  });
  allCharms.push(newNotebook as unknown as NoteCharm);
  return newNotebook;
});

const Notebook = pattern<Input, Output>(({ title, notes, isNotebook }) => {
  const { allCharms } = wish<{ allCharms: NoteCharm[] }>("/");

  // Dropdown menu state
  const menuOpen = Cell.of(false);

  const noteCount = computed(() => notes.length);
  const hasNotes = computed(() => notes.length > 0);

  // Selection state for multi-select
  const selectedNoteIndices = Cell.of<number[]>([]);
  const lastSelectedNoteIndex = Cell.of<number>(-1);
  const selectedAddNotebook = Cell.of<string>("");
  const selectedMoveNotebook = Cell.of<string>("");

  // Computed helpers for selection
  const selectedCount = computed(() => selectedNoteIndices.get().length);
  const hasSelection = computed(() => selectedNoteIndices.get().length > 0);

  // State for "New Notebook" prompt modal
  const showNewNotebookPrompt = Cell.of<boolean>(false);
  const newNotebookName = Cell.of<string>("");
  const pendingNotebookAction = Cell.of<"add" | "move" | "">(""); // Track which action triggered the modal

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

  // Computed items for ct-select dropdowns (notebooks + "New Notebook...")
  // ct-select has proper bidirectional DOM sync, unlike native <select>
  const notebookAddItems = computed(() => [
    ...notebooks.map((nb: any, idx: number) => ({
      label: nb?.[NAME] ?? "Untitled",
      value: String(idx),
    })),
    { label: "────────────", value: "_divider", disabled: true },
    { label: "New Notebook...", value: "new" },
  ]);

  const notebookMoveItems = computed(() => [
    ...notebooks.map((nb: any, idx: number) => ({
      label: nb?.[NAME] ?? "Untitled",
      value: String(idx),
    })),
    { label: "────────────", value: "_divider", disabled: true },
    { label: "New Notebook...", value: "new" },
  ]);

  return {
    // Include 📓 marker in NAME for reliable identification through proxy
    [NAME]: computed(() => `📓 ${title} (${noteCount})`),
    isNotebook,
    [UI]: (
      <ct-screen>
        <ct-hstack
          slot="header"
          gap="3"
          padding="4"
          style={{
            alignItems: "center",
            borderBottom: "1px solid var(--ct-color-border, #e5e5e7)",
          }}
        >
          <span style={{ flex: 1 }} />
          <ct-button
            variant="ghost"
            onClick={toggleMenu({ menuOpen })}
            style={{
              padding: "8px 16px",
              fontSize: "16px",
              borderRadius: "8px",
            }}
          >
            Notes {"\u25BE"}
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
              onClick={menuNewNote({ menuOpen, notes, allCharms })}
              style={{ justifyContent: "flex-start" }}
            >
              {"\u00A0\u00A0"}📝 New Note
            </ct-button>
            <ct-button
              variant="ghost"
              onClick={menuNewNotebook({ menuOpen, allCharms })}
              style={{ justifyContent: "flex-start" }}
            >
              {"\u00A0\u00A0"}📓 New Notebook
            </ct-button>

            {/* Divider */}
            <div
              style={{
                height: "1px",
                background: "var(--ct-color-border, #e5e5e7)",
                margin: "4px 8px",
              }}
            />

            {/* List of notebooks */}
            {notebooks.map((notebook) => (
              <ct-button
                variant="ghost"
                onClick={menuGoToNotebook({ menuOpen, notebook })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}
                {notebook?.[NAME] ?? "Untitled"}
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

        <ct-vscroll flex showScrollbar>
          <ct-vstack gap="4" padding="6">
            <ct-card>
              <ct-vstack gap="4">
                {/* Header */}
                <div
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  {/* Editable Title */}
                  <div
                    style={{
                      display: computed(() =>
                        isEditingTitle.get() ? "none" : "flex"
                      ),
                      alignItems: "center",
                      gap: "8px",
                      cursor: "pointer",
                    }}
                    onClick={startEditingTitle({ isEditingTitle })}
                  >
                    <span
                      style={{ margin: 0, fontSize: "15px", fontWeight: "600" }}
                    >
                      📓 {title} ({noteCount})
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
                      placeholder="Notebook name..."
                      style={{ flex: 1 }}
                      onct-blur={stopEditingTitle({ isEditingTitle })}
                      onct-keydown={handleTitleKeydown({ isEditingTitle })}
                    />
                  </div>
                  <ct-button
                    size="sm"
                    variant="ghost"
                    title="New Note"
                    onClick={addNote({ notes, allCharms })}
                    style={{
                      padding: "6px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    <span style={{ fontSize: "14px" }}>📝</span>
                    <span style={{ fontSize: "13px", fontWeight: "500" }}>
                      New
                    </span>
                  </ct-button>
                </div>

                {!hasNotes ? <></> : (
                  <ct-vstack gap="0">
                    {/* Table Header */}
                    <ct-hstack
                      padding="3"
                      style={{
                        background: "var(--ct-color-bg-secondary, #f5f5f7)",
                        borderRadius: "8px",
                        alignItems: "center",
                        fontSize: "13px",
                        fontWeight: "500",
                        color: "var(--ct-color-text-secondary, #6e6e73)",
                        marginBottom: "4px",
                      }}
                    >
                      <div style={{ width: "32px", flexShrink: 0 }}>
                        <ct-checkbox
                          checked={computed(() =>
                            notes.length > 0 &&
                            selectedNoteIndices.get().length === notes.length
                          )}
                          onct-change={computed(() =>
                            selectedNoteIndices.get().length === notes.length
                              ? deselectAllNotes({ selectedNoteIndices })
                              : selectAllNotes({ notes, selectedNoteIndices })
                          )}
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>Note</div>
                      <div
                        style={{
                          width: "60px",
                          flexShrink: 0,
                          textAlign: "center",
                        }}
                      >
                        Show/Hide
                      </div>
                      <div style={{ width: "40px", flexShrink: 0 }} />
                    </ct-hstack>

                    {/* Notes List */}
                    {notes.map((note, index) => (
                      <ct-hstack
                        padding="3"
                        style={{
                          alignItems: "center",
                          borderBottom:
                            "1px solid var(--ct-color-border, #e5e5e7)",
                          background: computed(() =>
                            selectedNoteIndices.get().includes(index)
                              ? "var(--ct-color-bg-secondary, #f5f5f7)"
                              : "transparent"
                          ),
                        }}
                      >
                        <div
                          style={{
                            width: "32px",
                            flexShrink: 0,
                            cursor: "pointer",
                            userSelect: "none",
                            display: "flex",
                            alignItems: "center",
                          }}
                          onClick={toggleNoteCheckbox({
                            index,
                            selectedNoteIndices,
                            lastSelectedNoteIndex,
                          })}
                        >
                          <ct-checkbox
                            checked={computed(() =>
                              selectedNoteIndices.get().includes(index)
                            )}
                          />
                        </div>
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            display: "flex",
                            alignItems: "center",
                          }}
                        >
                          <ct-cell-context $cell={note}>
                            <ct-cell-link $cell={note} />
                          </ct-cell-context>
                        </div>
                        <div
                          style={{
                            width: "60px",
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <ct-switch
                            checked={computed(() => !(note.isHidden ?? false))}
                            onct-change={toggleNoteVisibility({ note })}
                          />
                        </div>
                        <div
                          style={{
                            width: "40px",
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <ct-button
                            size="sm"
                            variant="ghost"
                            onClick={removeFromNotebook({ note, notes })}
                          >
                            ✕
                          </ct-button>
                        </div>
                      </ct-hstack>
                    ))}
                  </ct-vstack>
                )}

                {/* Action Bar - Use CSS display to keep DOM alive (preserves handler streams) */}
                <ct-hstack
                  padding="3"
                  gap="3"
                  style={{
                    display: computed(() => (hasSelection ? "flex" : "none")),
                    background: "var(--ct-color-bg-secondary, #f5f5f7)",
                    borderRadius: "8px",
                    alignItems: "center",
                    marginTop: "8px",
                  }}
                >
                  <span style={{ fontSize: "13px", fontWeight: "500" }}>
                    {selectedCount} selected
                  </span>
                  <span style={{ flex: 1 }} />
                  <ct-select
                    $value={selectedAddNotebook}
                    items={notebookAddItems}
                    placeholder="Add to notebook..."
                    style={{ width: "160px" }}
                    onChange={addSelectedToNotebook({
                      notes,
                      selectedNoteIndices,
                      notebooks,
                      selectedAddNotebook,
                      showNewNotebookPrompt,
                      pendingNotebookAction,
                    })}
                  />
                  <ct-select
                    $value={selectedMoveNotebook}
                    items={notebookMoveItems}
                    placeholder="Move to..."
                    style={{ width: "140px" }}
                    onChange={moveSelectedToNotebook({
                      notes,
                      selectedNoteIndices,
                      notebooks,
                      selectedMoveNotebook,
                      showNewNotebookPrompt,
                      pendingNotebookAction,
                    })}
                  />
                  <ct-button
                    size="sm"
                    variant="ghost"
                    onClick={duplicateSelectedNotes({
                      notes,
                      selectedNoteIndices,
                      allCharms,
                    })}
                  >
                    Duplicate
                  </ct-button>
                  <ct-button
                    size="sm"
                    variant="ghost"
                    onClick={deleteSelectedNotes({
                      notes,
                      selectedNoteIndices,
                      allCharms,
                      notebooks,
                    })}
                    style={{ color: "var(--ct-color-danger, #dc3545)" }}
                  >
                    Delete
                  </ct-button>
                </ct-hstack>
              </ct-vstack>
            </ct-card>
          </ct-vstack>
        </ct-vscroll>

        {/* New Notebook Prompt Modal - Use CSS display to keep DOM alive for reactivity */}
        <div
          style={{
            display: computed(() =>
              showNewNotebookPrompt.get() ? "flex" : "none"
            ),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
          }}
        >
          <ct-card style={{ minWidth: "320px", padding: "24px" }}>
            <ct-vstack gap="4">
              <h3 style={{ margin: 0 }}>New Notebook</h3>
              <ct-input
                $value={newNotebookName}
                placeholder="Enter notebook name..."
              />
              <ct-hstack gap="2" style={{ justifyContent: "flex-end" }}>
                <ct-button
                  variant="ghost"
                  onClick={cancelNewNotebookPrompt({
                    showNewNotebookPrompt,
                    newNotebookName,
                    pendingNotebookAction,
                    selectedAddNotebook,
                    selectedMoveNotebook,
                  })}
                >
                  Cancel
                </ct-button>
                <ct-button
                  variant="primary"
                  onClick={createNotebookFromPrompt({
                    newNotebookName,
                    showNewNotebookPrompt,
                    pendingNotebookAction,
                    selectedNoteIndices,
                    notes,
                    allCharms,
                    notebooks,
                  })}
                >
                  Create
                </ct-button>
              </ct-hstack>
            </ct-vstack>
          </ct-card>
        </div>
      </ct-screen>
    ),
    title,
    notes,
    noteCount,
    // LLM-callable streams for omnibot integration
    createNote: handleCreateNote({ notes, allCharms }),
    createNotes: handleCreateNotes({ notes, allCharms }),
    setTitle: handleSetTitle({ title }),
    createNotebook: handleCreateNotebook({ allCharms }),
  };
});

export default Notebook;
