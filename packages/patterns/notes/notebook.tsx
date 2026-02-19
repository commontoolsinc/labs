/// <cts-enable />
import {
  action,
  computed,
  equals,
  handler,
  NAME,
  navigateTo,
  pattern,
  SELF,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";

import Note from "./note.tsx";
import {
  generateId,
  getPieceName,
  type MentionablePiece,
  type MinimalPiece,
  type NotebookInput,
  type NotebookPiece,
  type NotePiece,
} from "./schemas.tsx";

// ===== Shared Utility Functions =====

/**
 * Remove items from all notebooks' notes arrays using equals() for identity comparison.
 * Optionally skip a target notebook index (for move operations).
 */
const removeFromAllNotebooks = (
  notebooks: Writable<NotebookPiece[]>,
  itemsToRemove: NotePiece[],
  skipIndex?: number,
): void => {
  const notebooksList = notebooks.get();
  for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
    if (skipIndex !== undefined && nbIdx === skipIndex) continue;

    const nbNotesCell = notebooks.key(nbIdx).key("notes");
    const nbNotes = nbNotesCell.get() ?? [];

    const filtered = nbNotes.filter(
      (n: any) => !itemsToRemove.some((item) => equals(n, item as any)),
    );
    if (filtered.length !== nbNotes.length) {
      nbNotesCell.set(filtered);
    }
  }
};

// ===== Output Type =====

/** A #notebook that organizes notes into collections. */
interface NotebookOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  notes: NotePiece[];
  noteCount: number;
  isNotebook: boolean;
  isHidden: boolean;
  backlinks: MentionablePiece[];
  // LLM-callable streams for omnibot integration
  createNote: Stream<{ title: string; content: string }>;
  createNotes: Stream<{ notesData: Array<{ title: string; content: string }> }>;
  setTitle: Stream<{ newTitle: string }>;
  createNotebook: Stream<{
    title: string;
    notesData?: Array<{ title: string; content: string }>;
  }>;
  // Test-accessible action streams
  selectAllNotes: Stream<void>;
  deselectAllNotes: Stream<void>;
  deleteSelected: Stream<void>;
  duplicateSelected: Stream<void>;
  showNewNoteModal: Stream<void>;
  cancelNewNote: Stream<void>;
  showNewNotebookModal: Stream<void>;
  cancelNewNotebook: Stream<void>;
  cancelNewNestedNotebook: Stream<void>;
  startEditTitle: Stream<void>;
  stopEditTitle: Stream<void>;
  // Test-accessible state
  selectedNoteIndices: number[];
  selectedCount: number;
  hasSelection: boolean;
  showNewNotePrompt: boolean;
  showNewNotebookPrompt: boolean;
  showNewNestedNotebookPrompt: boolean;
  isEditingTitle: boolean;
}

// Handler to remove a note from this notebook (but keep it in the space)
const removeFromNotebook = handler<
  void,
  { note: Writable<NotePiece>; notes: Writable<NotePiece[]> }
>((_, { note, notes }) => {
  const notebookNotes = notes.get();
  const index = notebookNotes.findIndex((n: any) => equals(n, note));
  if (index !== -1) {
    const copy = [...notebookNotes];
    copy.splice(index, 1);
    notes.set(copy);
  }
  // Make it visible in the space again
  note.key("isHidden").set(false);
});

// Handler for dropping items onto the current notebook's card
// This MOVES the dropped notebook - removes from all other notebooks, adds here
// Supports multi-item drag: if dragged item is in selection, moves ALL selected items
const handleDropOntoCurrentNotebook = handler<
  { detail: { sourceCell: Writable<unknown> } },
  {
    notes: Writable<NotePiece[]>;
    notebooks: Writable<NotebookPiece[]>;
    selectedNoteIndices: Writable<number[]>;
  }
>((event, { notes, notebooks, selectedNoteIndices }) => {
  const sourceCell = event.detail.sourceCell;
  const notesList = notes.get();
  const selected = selectedNoteIndices.get();

  // Check if dragged item is in the selection
  const draggedIndex = notesList.findIndex((n: any) => equals(sourceCell, n));
  const isDraggedInSelection = draggedIndex >= 0 &&
    selected.includes(draggedIndex);

  if (isDraggedInSelection && selected.length > 1) {
    // Multi-item move
    const itemsToMove = selected.map((idx) => notesList[idx]).filter(Boolean);

    // Remove from all notebooks
    removeFromAllNotebooks(notebooks, itemsToMove);

    // Add all to this notebook (deduplicated)
    for (const item of itemsToMove) {
      if (!notesList.some((n) => equals(item as any, n as any))) {
        notes.push(item as any);
        (item as any).key?.("isHidden")?.set?.(true);
      }
    }
    selectedNoteIndices.set([]);
  } else {
    // Single-item move
    if (notesList.some((n) => equals(sourceCell, n as any))) return;

    removeFromAllNotebooks(notebooks, [sourceCell as any]);
    sourceCell.key("isHidden").set(true);
    notes.push(sourceCell as any);
  }
});

// Handler for dropping any item onto a notebook - moves from current notebook to target
// Supports multi-item drag: if dragged item is in selection, moves ALL selected items
const handleDropOntoNotebook = handler<
  { detail: { sourceCell: Writable<unknown> } },
  {
    targetNotebook: Writable<{
      title?: string;
      notes?: unknown[];
      isNotebook?: boolean;
    }>;
    currentNotes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    notebooks: Writable<NotebookPiece[]>;
  }
>((event, { targetNotebook, currentNotes, selectedNoteIndices, notebooks }) => {
  const sourceCell = event.detail.sourceCell;

  // Check if target is actually a notebook
  if (!targetNotebook.key("isNotebook").get()) return;

  const targetNotesCell = targetNotebook.key("notes");
  const targetNotesList = (targetNotesCell.get() as unknown[]) ?? [];
  const currentList = currentNotes.get();
  const selected = selectedNoteIndices.get();

  // Check if dragged item is in the selection
  const draggedIndex = currentList.findIndex((n: any) => equals(sourceCell, n));
  const isDraggedInSelection = draggedIndex >= 0 &&
    selected.includes(draggedIndex);

  if (isDraggedInSelection && selected.length > 1) {
    // Multi-item move
    const itemsToMove = selected.map((idx) => currentList[idx]).filter(Boolean);

    // Add all to target (deduplicated)
    for (const item of itemsToMove) {
      if (!targetNotesList.some((n) => equals(item as any, n as any))) {
        targetNotesCell.push(item);
        (item as any).key?.("isHidden")?.set?.(true);
      }
    }

    // Find target notebook index to skip it during removal
    const notebooksList = notebooks.get();
    const targetIndex = notebooksList.findIndex(
      (nb: any) => equals(nb, targetNotebook),
    );

    // Remove from all notebooks except target
    removeFromAllNotebooks(notebooks, itemsToMove, targetIndex);

    // Remove from current notebook
    currentNotes.set(
      currentList.filter(
        (n: any) => !itemsToMove.some((item) => equals(n, item as any)),
      ),
    );
    selectedNoteIndices.set([]);
  } else {
    // Single-item move
    if (targetNotesList.some((n) => equals(sourceCell, n as any))) return;

    // Remove from current notebook if present
    const indexInCurrent = currentList.findIndex((n: any) =>
      equals(sourceCell, n)
    );
    if (indexInCurrent !== -1) {
      const copy = [...currentList];
      copy.splice(indexInCurrent, 1);
      currentNotes.set(copy);
    }

    sourceCell.key("isHidden").set(true);
    targetNotesCell.push(sourceCell);
  }
});

// Handler for clicking on a backlink
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>(
  (_, { piece }) => navigateTo(piece),
);

// Handler to navigate to a child (note or notebook) - sets parent for back navigation
// Must be module-scope handler because it's used in .map() with per-iteration child bindings
const navigateToChild = handler<
  void,
  { child: Writable<any>; self: any }
>(
  (_, { child, self }) => {
    child.key("parentNotebook").set(self);
    navigateTo(child);
  },
);

// Handler to permanently delete selected notes from the space
const deleteSelectedNotes = handler<
  void,
  {
    notes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    allPieces: Writable<NotePiece[]>;
    notebooks: Writable<NotebookPiece[]>;
  }
>((_, { notes, selectedNoteIndices, allPieces, notebooks }) => {
  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const itemsToDelete = selected.map((idx) => notesList[idx]).filter(Boolean);

  // Remove from all notebooks
  removeFromAllNotebooks(notebooks, itemsToDelete);

  // Remove from this notebook's notes array
  notes.set(
    notesList.filter(
      (n: any) => !itemsToDelete.some((item) => equals(n, item as any)),
    ),
  );

  // Remove from allPieces (permanent delete)
  allPieces.set(
    allPieces.get().filter(
      (piece: any) => !itemsToDelete.some((item) => equals(piece, item as any)),
    ),
  );

  selectedNoteIndices.set([]);
});

// Handler to add selected notes to another notebook
const addSelectedToNotebook = handler<
  { target?: { value: string }; detail?: { value: string } },
  {
    notes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    notebooks: Writable<NotebookPiece[]>;
    selectedAddNotebook: Writable<string>;
    showNewNotebookPrompt: Writable<boolean>;
    pendingNotebookAction: Writable<"add" | "move" | "">;
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

  // Collect notes first, then batch push (reduces N reactive cycles to 1)
  const notesToAdd: NotePiece[] = [];
  for (const idx of selected) {
    const note = notesList[idx];
    if (note) notesToAdd.push(note);
  }
  (targetNotebookNotes as Writable<NotePiece[] | undefined>).push(
    ...notesToAdd,
  );

  selectedNoteIndices.set([]);
  selectedAddNotebook.set("");
});

// Handler to move selected notes to another notebook (remove from current)
const moveSelectedToNotebook = handler<
  { target?: { value: string }; detail?: { value: string } },
  {
    notes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    notebooks: Writable<NotebookPiece[]>;
    selectedMoveNotebook: Writable<string>;
    showNewNotebookPrompt: Writable<boolean>;
    pendingNotebookAction: Writable<"add" | "move" | "">;
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
  const value = event.target?.value ?? event.detail?.value ?? "";
  if (!value) return;

  if (value === "new") {
    pendingNotebookAction.set("move");
    showNewNotebookPrompt.set(true);
    selectedMoveNotebook.set("");
    return;
  }

  const nbIndex = parseInt(value, 10);
  if (nbIndex < 0) return;

  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const notesToMove = selected.map((idx) => notesList[idx]).filter(Boolean);

  // Add to target notebook
  const targetNotebookNotes = notebooks.key(nbIndex).key("notes");
  (targetNotebookNotes as Writable<NotePiece[] | undefined>).push(
    ...notesToMove,
  );

  // Remove from all notebooks except target
  removeFromAllNotebooks(notebooks, notesToMove, nbIndex);

  // Remove from this notebook
  notes.set(
    notesList.filter(
      (n: any) => !notesToMove.some((item) => equals(n, item as any)),
    ),
  );

  selectedNoteIndices.set([]);
  selectedMoveNotebook.set("");
});

// Handler to create notebook from prompt and add/move selected notes
const createNotebookFromPrompt = handler<
  void,
  {
    newNotebookName: Writable<string>;
    showNewNotebookPrompt: Writable<boolean>;
    pendingNotebookAction: Writable<"add" | "move" | "">;
    selectedNoteIndices: Writable<number[]>;
    notes: Writable<NotePiece[]>;
    allPieces: Writable<MinimalPiece[]>;
    notebooks: Writable<NotebookPiece[]>;
  }
>((_, state) => {
  const {
    newNotebookName,
    showNewNotebookPrompt,
    pendingNotebookAction,
    selectedNoteIndices,
    notes,
    allPieces,
    notebooks,
  } = state;

  const name = newNotebookName.get().trim() || "New Notebook";
  const actionType = pendingNotebookAction.get();

  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const selectedItems = selected.map((idx) => notesList[idx]).filter(Boolean);

  // Create the notebook with items included
  const newNotebook = Notebook({
    title: name,
    notes: selectedItems,
    isHidden: true,
  });
  allPieces.push(newNotebook);

  if (actionType === "move") {
    // Remove from all existing notebooks
    removeFromAllNotebooks(notebooks, selectedItems);

    // Remove from this notebook, then add new notebook
    notes.set([
      ...notesList.filter(
        (n: any) => !selectedItems.some((item) => equals(n, item as any)),
      ),
      newNotebook,
    ]);
  } else {
    // For add: just add the new notebook as sibling
    notes.push(newNotebook);
  }

  // Clean up state
  selectedNoteIndices.set([]);
  newNotebookName.set("");
  pendingNotebookAction.set("");
  showNewNotebookPrompt.set(false);
});

// Handler to toggle checkbox selection with shift-click support
const toggleNoteCheckbox = handler<
  { shiftKey?: boolean },
  {
    index: number;
    selectedNoteIndices: Writable<number[]>;
    lastSelectedNoteIndex: Writable<number>;
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

const Notebook = pattern<NotebookInput, NotebookOutput>(
  ({ title, notes, isNotebook, isHidden, parentNotebook, [SELF]: self }) => {
    // Type-based discovery for notebooks and "All Notes" piece
    const notebookWish = wish<NotebookPiece>({
      query: "#notebook",
      scope: ["."],
    });
    // Notebooks discovered via wish scope (replaces allPieces emoji filtering)
    const notebooks = notebookWish.candidates;

    // Still need allPieces for write operations (push new notes/notebooks)
    const { allPieces } = wish<{ allPieces: Writable<NotePiece[]> }>(
      { query: "#default" },
    ).result;

    // Use computed() for proper reactive tracking of notes.length
    const noteCount = computed(() => notes.get().length);
    const hasNotes = computed(() => notes.get().length > 0);

    // Selection state for multi-select
    const selectedNoteIndices = Writable.of<number[]>([]);
    const lastSelectedNoteIndex = Writable.of<number>(-1);
    const selectedAddNotebook = Writable.of<string>("");
    const selectedMoveNotebook = Writable.of<string>("");

    // Computed helpers for selection
    const selectedCount = computed(() => selectedNoteIndices.get().length);
    const hasSelection = computed(() => selectedNoteIndices.get().length > 0);

    // State for "New Notebook" prompt modal
    const showNewNotebookPrompt = Writable.of<boolean>(false);
    const newNotebookName = Writable.of<string>("");
    const pendingNotebookAction = Writable.of<"add" | "move" | "">(""); // Track which action triggered the modal

    // State for "New Note" prompt modal
    const showNewNotePrompt = Writable.of<boolean>(false);
    const newNoteTitle = Writable.of<string>("");
    const usedCreateAnotherNote = Writable.of<boolean>(false); // Track if "Create Another" was used

    // State for "New Nested Notebook" prompt modal (from dropdown menu)
    const showNewNestedNotebookPrompt = Writable.of<boolean>(false);
    const newNestedNotebookTitle = Writable.of<string>("");

    const usedCreateAnotherNotebook = Writable.of<boolean>(false); // Track if "Create Another" was used

    // Backlinks - populated by backlinks-index.tsx
    const backlinks = Writable.of<MentionablePiece[]>([]);

    // State for inline title editing
    const isEditingTitle = Writable.of<boolean>(false);

    // ===== Actions (converted from module-scope handlers) =====

    const showNewNoteModalAction = action(() => showNewNotePrompt.set(true));
    const showNewNotebookModalAction = action(() =>
      showNewNestedNotebookPrompt.set(true)
    );

    const cancelNewNotePromptAction = action(() => {
      showNewNotePrompt.set(false);
      newNoteTitle.set("");
      usedCreateAnotherNote.set(false);
    });

    const cancelNewNestedNotebookPromptAction = action(() => {
      showNewNestedNotebookPrompt.set(false);
      newNestedNotebookTitle.set("");
      usedCreateAnotherNotebook.set(false);
    });

    const cancelNewNotebookPromptAction = action(() => {
      showNewNotebookPrompt.set(false);
      newNotebookName.set("");
      pendingNotebookAction.set("");
      selectedAddNotebook.set("");
      selectedMoveNotebook.set("");
    });

    const goToAllNotesAction = action(() => {
      const pieces = allPieces.get();
      const existing = pieces.find((piece: any) => {
        const name = piece?.[NAME];
        return typeof name === "string" && name.startsWith("All Notes");
      });
      if (existing) {
        return navigateTo(existing);
      }
    });

    const goToParentAction = action(() => {
      const p = parentNotebook.get();
      if (p) navigateTo(p);
    });

    const selectAllNotesAction = action(() => {
      const notesList = notes.get();
      selectedNoteIndices.set(notesList.map((_, i) => i));
    });

    const deselectAllNotesAction = action(() => {
      selectedNoteIndices.set([]);
    });

    const startEditingTitleAction = action(() => isEditingTitle.set(true));
    const stopEditingTitleAction = action(() => isEditingTitle.set(false));

    const handleTitleKeydownAction = action((event: { key?: string }) => {
      if (event?.key === "Enter") {
        isEditingTitle.set(false);
      }
    });

    // ===== Actions (close over notes, allPieces, self) =====
    // These work because all inputs use Default<> (not optional ?), so self
    // always satisfies the output schema's required properties at runtime.

    // LLM-callable: Create a single note in this notebook
    const createNoteStreamAction = action(
      ({ title: noteTitle, content }: { title: string; content: string }) => {
        const newNote = Note({
          title: noteTitle,
          content,
          isHidden: true,
          noteId: generateId(),
          parentNotebook: self,
        });
        allPieces.push(newNote as any);
        notes.push(newNote);
        return newNote;
      },
    );

    // LLM-callable: Create multiple notes in bulk
    const createNotesStreamAction = action(
      (
        { notesData }: {
          notesData: Array<{ title: string; content: string }>;
        },
      ) => {
        const created: NotePiece[] = [];
        for (const data of notesData) {
          created.push(Note({
            title: data.title,
            content: data.content,
            isHidden: true,
            noteId: generateId(),
            parentNotebook: self,
          }));
        }
        allPieces.push(...created);
        notes.push(...created);
        return created;
      },
    );

    // LLM-callable: Rename the notebook
    const setTitleAction = action(({ newTitle }: { newTitle: string }) => {
      title.set(newTitle);
      return newTitle;
    });

    // LLM-callable: Create a new notebook (optionally with notes)
    const createNotebookStreamAction = action(
      (
        { title: nbTitle, notesData }: {
          title: string;
          notesData?: Array<{ title: string; content: string }>;
        },
      ) => {
        const notesToAdd: NotePiece[] = [];
        if (notesData && notesData.length > 0) {
          for (const data of notesData) {
            notesToAdd.push(Note({
              title: data.title,
              content: data.content,
              isHidden: true,
              noteId: generateId(),
            }));
          }
        }

        const newNotebook = Notebook({
          title: nbTitle,
          notes: notesToAdd,
        });

        allPieces.push(newNotebook);
        return newNotebook;
      },
    );

    // Create note - shared logic for "Create" and "Create Another" buttons
    const createNoteAction = action(() => {
      const noteTitle = newNoteTitle.get() || "New Note";
      const newNote = Note({
        title: noteTitle,
        content: "",
        isHidden: true,
        noteId: generateId(),
        parentNotebook: self,
      });
      allPieces.push(newNote as any);
      notes.push(newNote);

      // Close modal and navigate (unless "Create Another" was previously used)
      const shouldNavigate = !usedCreateAnotherNote.get();
      showNewNotePrompt.set(false);
      newNoteTitle.set("");
      usedCreateAnotherNote.set(false);
      if (shouldNavigate) {
        return navigateTo(newNote);
      }
    });

    const createAnotherNoteAction = action(() => {
      const noteTitle = newNoteTitle.get() || "New Note";
      const newNote = Note({
        title: noteTitle,
        content: "",
        isHidden: true,
        noteId: generateId(),
        parentNotebook: self,
      });
      allPieces.push(newNote as any);
      notes.push(newNote);

      // Keep modal open for "Create Another"
      usedCreateAnotherNote.set(true);
      newNoteTitle.set("");
    });

    // Create nested notebook - shared logic for "Create" and "Create Another" buttons
    const createNestedNotebookAction = action(() => {
      const nbTitle = newNestedNotebookTitle.get() || "New Notebook";
      const nb = Notebook({
        title: nbTitle,
        notes: [],
        isHidden: true,
        parentNotebook: self,
      });
      allPieces.push(nb);
      notes.push(nb);

      const shouldNavigate = !usedCreateAnotherNotebook.get();
      showNewNestedNotebookPrompt.set(false);
      newNestedNotebookTitle.set("");
      usedCreateAnotherNotebook.set(false);
      if (shouldNavigate) {
        return navigateTo(nb);
      }
    });

    const createAnotherNestedNotebookAction = action(() => {
      const nbTitle = newNestedNotebookTitle.get() || "New Notebook";
      const nb = Notebook({
        title: nbTitle,
        notes: [],
        isHidden: true,
        parentNotebook: undefined,
      });
      allPieces.push(nb);
      notes.push(nb);

      usedCreateAnotherNotebook.set(true);
      newNestedNotebookTitle.set("");
    });

    // Action to duplicate selected notes
    const doDuplicateSelectedNotes = action(() => {
      const selected = selectedNoteIndices.get();

      for (const idx of selected) {
        const original = notes.key(idx);
        if (original) {
          const newNote = Note({
            title: ((original as any).title ?? "Note") + " (Copy)",
            content: (original as any).content ?? "",
            isHidden: true,
            noteId: generateId(),
            parentNotebook: self, // Set parent for back navigation
          });
          allPieces.push(newNote as any);
          notes.push(newNote);
        }
      }
      selectedNoteIndices.set([]);
    });

    // COMBINED computed for ALL notebook relationships to avoid nested computed access issues
    // Returns parents, children, siblings, and their boolean flags all in one place
    // NOTE: Prefixed with _ because siblings feature is disabled; kept for re-enabling
    const _notebookRelationships = computed(() => {
      // Current notebook's name for comparison - use title since it's our local prop
      const currentTitle = title;
      // Build a pattern to match our NAME format: "📓 {title} ({count})"
      const _currentNamePattern = `📓 ${currentTitle}`;
      const nbCount = notebooks.length;

      // Find parent notebooks (notebooks that contain this notebook in their notes)
      // For now, skip parent detection as it requires accessing notes arrays of other pieces
      const parents: any[] = [];
      // Note: Parent detection requires deeper integration with piece introspection

      // Find child notebooks (notebooks in our notes list)
      const notesList = notes.get() ?? [];
      const childNames = (Array.isArray(notesList) ? notesList : [])
        .filter((n: any) => n?.isNotebook === true)
        .map((n: any) => getPieceName(n))
        .filter((t: any) => t.length > 0);

      const children: any[] = [];
      for (let i = 0; i < nbCount; i++) {
        const nb = notebooks[i];
        const nbName = getPieceName(nb);
        if (
          childNames.some((cn) => nbName.includes(cn) || cn.includes(nbName))
        ) {
          children.push(nb);
        }
      }

      // ========================================================================
      // SIBLINGS FEATURE DISABLED FOR PERFORMANCE
      // ========================================================================
      // The "Other notebooks" sibling feature was causing significant performance
      // issues with 50+ notebooks due to O(n*m) complexity in the computation.
      //
      // To re-enable:
      // 1. Uncomment the siblings computation below
      // 2. Uncomment the UI section in JSX (search for "DISABLED FOR PERFORMANCE")
      // 3. Set hasSiblings to: siblings.length > 0
      //
      // Performance consideration: Consider implementing lazy evaluation or
      // a collapsible UI that only computes siblings when expanded.
      // ========================================================================

      // const notesListNames = (Array.isArray(notesList) ? notesList : [])
      //   .map((n: any) => getPieceName(n))
      //   .filter((t: any) => t.length > 0);
      //
      // const siblings: any[] = [];
      // for (let i = 0; i < nbCount; i++) {
      //   const nb = notebooks[i];
      //   const nbName = getPieceName(nb);
      //   if (nbName.length === 0) continue;
      //   if (nbName.startsWith(currentNamePattern)) continue;
      //   if (notesListNames.some((n) => nbName.includes(n) || n.includes(nbName))) continue;
      //   siblings.push(nb);
      // }

      const siblings: any[] = []; // Empty - siblings feature disabled

      return {
        parents,
        hasParents: parents.length > 0,
        children,
        hasChildren: children.length > 0,
        siblings,
        hasSiblings: false, // Set to: siblings.length > 0 when re-enabling
      };
    });

    // Computed items for ct-select dropdowns (notebooks + "New Notebook...")
    // ct-select has proper bidirectional DOM sync, unlike native <select>
    const notebookSelectItems = computed(() => [
      ...notebooks.map((nb: any, idx: number) => ({
        label: nb?.[NAME] ?? "Untitled",
        value: String(idx),
      })),
      { label: "────────────", value: "_divider", disabled: true },
      { label: "New Notebook...", value: "new" },
    ]);

    // ===== Pre-computed UI values =====

    // Parent notebook display state - read from input prop
    const hasParentNotebook = computed(() => !!parentNotebook.get());
    const parentNotebookLabel = computed(() => {
      const p = parentNotebook.get();
      return p?.[NAME] ?? p?.title ?? "Parent";
    });

    // Title editing display states
    const titleDisplayStyle = computed(() =>
      isEditingTitle.get() ? "none" : "flex"
    );
    const titleInputDisplayStyle = computed(() =>
      isEditingTitle.get() ? "flex" : "none"
    );

    // Notes list display
    const notesListDisplay = computed(() => hasNotes ? "flex" : "none");
    const emptyStateDisplay = computed(() => hasNotes ? "none" : "flex");
    const selectAllDisplay = computed(() =>
      notes.get().length > 1 ? "flex" : "none"
    );

    // Selection state display
    const actionBarDisplay = computed(() => hasSelection ? "flex" : "none");

    // Backlinks display
    const backlinksDisplay = computed(() =>
      backlinks.get().length > 0 ? "flex" : "none"
    );

    // All Notes button display - search allPieces by name (matches default-app approach)
    const allNotesButtonDisplay = computed(() => {
      const pieces = allPieces.get();
      const exists = pieces.some((piece: any) => {
        const name = piece?.[NAME];
        return typeof name === "string" && name.startsWith("All Notes");
      });
      return exists ? "flex" : "none";
    });

    // ===== Shared UI Styles =====

    const newButtonStyle = {
      padding: "6px 12px",
      display: "flex",
      alignItems: "center",
      gap: "4px",
    };

    return {
      // Include 📓 marker in NAME for reliable identification through proxy
      [NAME]: computed(() => `📓 ${title.get()} (${noteCount})`),
      isNotebook,
      isHidden,
      [UI]: (
        <ct-screen>
          <div
            style={{
              flex: 1,
              overflow: "auto",
              minHeight: 0,
            }}
          >
            <ct-vstack gap="4" padding="6">
              {/* Header row - parent link on left, Notebooks dropdown on right */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                }}
              >
                {/* Parent link - shows parent notebook chip if parentNotebook is set */}
                <ct-hstack
                  gap="2"
                  align="center"
                  style={{
                    display: computed(() =>
                      hasParentNotebook ? "flex" : "none"
                    ),
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
                    onct-click={goToParentAction}
                  />
                </ct-hstack>
                {/* Spacer when no parent */}
                <div
                  style={{
                    display: computed(() =>
                      hasParentNotebook ? "none" : "block"
                    ),
                  }}
                />

                <ct-button
                  variant="ghost"
                  onClick={goToAllNotesAction}
                  style={{
                    padding: "8px 16px",
                    fontSize: "16px",
                    borderRadius: "8px",
                    display: allNotesButtonDisplay,
                  }}
                >
                  📁 All Notes
                </ct-button>
              </div>

              <ct-card>
                <ct-vstack gap="4">
                  {/* Header - also a drop zone for receiving items from "Other notebooks" */}
                  <ct-drop-zone
                    accept="sibling"
                    onct-drop={handleDropOntoCurrentNotebook({
                      notes,
                      notebooks,
                      selectedNoteIndices,
                    })}
                    style={{ width: "100%" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        width: "100%",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px",
                        borderRadius: "8px",
                        background: "var(--ct-color-bg-primary, #fff)",
                      }}
                    >
                      {/* Editable Title */}
                      <div
                        style={{
                          display: titleDisplayStyle,
                          alignItems: "center",
                          gap: "8px",
                          cursor: "pointer",
                        }}
                        onClick={startEditingTitleAction}
                      >
                        <span
                          style={{
                            margin: 0,
                            fontSize: "15px",
                            fontWeight: "600",
                          }}
                        >
                          📓 {title} ({noteCount})
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
                          placeholder="Notebook name..."
                          style={{ flex: 1 }}
                          onct-blur={stopEditingTitleAction}
                          onct-keydown={handleTitleKeydownAction}
                        />
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <ct-button
                          size="sm"
                          variant="ghost"
                          title="New Note"
                          onClick={showNewNoteModalAction}
                          style={newButtonStyle}
                        >
                          <span style={{ fontSize: "14px" }}>📝</span>
                          <span style={{ fontSize: "13px", fontWeight: "500" }}>
                            New
                          </span>
                        </ct-button>
                        <ct-button
                          size="sm"
                          variant="ghost"
                          title="New Notebook"
                          onClick={showNewNotebookModalAction}
                          style={newButtonStyle}
                        >
                          <span style={{ fontSize: "14px" }}>📓</span>
                          <span style={{ fontSize: "13px", fontWeight: "500" }}>
                            New
                          </span>
                        </ct-button>
                      </div>
                    </div>
                  </ct-drop-zone>

                  {/* Empty state - shown when notebook has no notes, opens new note modal */}
                  <div
                    style={{
                      display: emptyStateDisplay,
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "48px 24px",
                      cursor: "pointer",
                      borderRadius: "8px",
                      border: "2px dashed var(--ct-color-border, #e5e5e7)",
                      background: "var(--ct-color-bg-secondary, #f9f9f9)",
                    }}
                    onClick={showNewNoteModalAction}
                  >
                    <span style={{ fontSize: "32px", marginBottom: "12px" }}>
                      📝
                    </span>
                    <span
                      style={{
                        fontSize: "15px",
                        fontWeight: "500",
                        color: "var(--ct-color-text-primary)",
                      }}
                    >
                      Click to create your first note
                    </span>
                  </div>

                  <ct-vstack
                    gap="0"
                    style={{
                      display: notesListDisplay,
                    }}
                  >
                    {/* Notes List - using ct-table like default-app for consistent spacing */}
                    <ct-table full-width hover>
                      <tbody>
                        {notes.map((note, index) => (
                          <tr
                            style={{
                              background: computed(() =>
                                selectedNoteIndices.get().includes(index)
                                  ? "var(--ct-color-bg-secondary, #f5f5f7)"
                                  : "transparent"
                              ),
                            }}
                          >
                            <td
                              style={{
                                width: "32px",
                                padding: "0 4px",
                                verticalAlign: "middle",
                              }}
                            >
                              <div
                                style={{
                                  cursor: "pointer",
                                  userSelect: "none",
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
                            </td>
                            <td style={{ verticalAlign: "middle" }}>
                              {/* Drop zone + drag source on the item itself */}
                              <ct-drop-zone
                                accept="note,notebook"
                                onct-drop={handleDropOntoNotebook({
                                  targetNotebook: note as any,
                                  currentNotes: notes,
                                  selectedNoteIndices,
                                  notebooks,
                                })}
                              >
                                <ct-drag-source $cell={note} type="note">
                                  <div
                                    style={{ cursor: "pointer" }}
                                    onClick={navigateToChild({
                                      child: note,
                                      self,
                                    })}
                                  >
                                    <ct-cell-context $cell={note}>
                                      <ct-chip
                                        label={note?.[NAME] ?? note?.title ??
                                          "Untitled"}
                                        interactive
                                      />
                                    </ct-cell-context>
                                  </div>
                                </ct-drag-source>
                              </ct-drop-zone>
                            </td>
                            <td
                              style={{
                                width: "40px",
                                verticalAlign: "middle",
                              }}
                            >
                              <ct-button
                                size="sm"
                                variant="ghost"
                                onClick={removeFromNotebook({ note, notes })}
                              >
                                ✕
                              </ct-button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </ct-table>

                    {/* Select All footer - only show when more than 1 item */}
                    <div
                      style={{
                        display: selectAllDisplay,
                        alignItems: "center",
                        padding: "4px 0",
                        fontSize: "13px",
                        color: "var(--ct-color-text-secondary, #6e6e73)",
                      }}
                    >
                      {/* Checkbox column (32px + 4px padding) */}
                      <div style={{ width: "32px", padding: "0 4px" }}>
                        <ct-checkbox
                          checked={computed(() => notes.get().length > 0 &&
                            selectedNoteIndices.get().length ===
                              notes.get().length
                          )}
                          onct-change={computed(() =>
                            selectedNoteIndices.get().length ===
                                notes.get().length
                              ? deselectAllNotesAction
                              : selectAllNotesAction
                          )}
                        />
                      </div>
                      {/* Text aligned with piece pills */}
                      <span style={{ paddingLeft: "4px" }}>Select All</span>
                    </div>
                  </ct-vstack>

                  {/* Action Bar - Use CSS display to keep DOM alive (preserves handler streams) */}
                  <ct-hstack
                    padding="3"
                    gap="3"
                    style={{
                      display: actionBarDisplay,
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
                      items={notebookSelectItems}
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
                      items={notebookSelectItems}
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
                      onClick={doDuplicateSelectedNotes}
                    >
                      Duplicate
                    </ct-button>
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={deleteSelectedNotes({
                        notes,
                        selectedNoteIndices,
                        allPieces,
                        notebooks,
                      })}
                      style={{ color: "var(--ct-color-danger, #dc3545)" }}
                    >
                      Delete
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              </ct-card>

              {/* Siblings feature disabled for performance - see _notebookRelationships for re-enabling */}
            </ct-vstack>
          </div>

          {/* New Notebook Prompt Modal */}
          <ct-modal
            $open={showNewNotebookPrompt}
            dismissable
            size="sm"
            label="New Notebook"
          >
            <span slot="header">New Notebook</span>
            <ct-input
              $value={newNotebookName}
              placeholder="Enter notebook name..."
            />
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={cancelNewNotebookPromptAction}
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
                  allPieces,
                  notebooks,
                })}
              >
                Create
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* New Note Prompt Modal */}
          <ct-modal
            $open={showNewNotePrompt}
            dismissable
            size="sm"
            label="New Note"
          >
            <span slot="header">New Note</span>
            <ct-input
              $value={newNoteTitle}
              placeholder="Enter note title..."
            />
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={cancelNewNotePromptAction}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="ghost"
                onClick={createAnotherNoteAction}
              >
                Create Another
              </ct-button>
              <ct-button
                variant="primary"
                onClick={createNoteAction}
              >
                Create
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* New Nested Notebook Prompt Modal */}
          <ct-modal
            $open={showNewNestedNotebookPrompt}
            dismissable
            size="sm"
            label="New Notebook"
          >
            <span slot="header">New Notebook</span>
            <ct-input
              $value={newNestedNotebookTitle}
              placeholder="Enter notebook title..."
            />
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={cancelNewNestedNotebookPromptAction}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="ghost"
                onClick={createAnotherNestedNotebookAction}
              >
                Create Another
              </ct-button>
              <ct-button
                variant="primary"
                onClick={createNestedNotebookAction}
              >
                Create
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* Backlinks footer - show pieces that link to this notebook */}
          <ct-hstack
            slot="footer"
            gap="2"
            padding="3"
            style={{
              display: backlinksDisplay,
              alignItems: "center",
              borderTop: "1px solid var(--ct-color-border, #e5e5e7)",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                lineHeight: "28px",
                color: "var(--ct-color-text-secondary, #666)",
              }}
            >
              Linked from:
            </span>
            {backlinks.map((piece) => (
              <ct-button
                variant="ghost"
                size="sm"
                onClick={handleBacklinkClick({ piece })}
                style={{ fontSize: "12px" }}
              >
                {piece?.[NAME]}
              </ct-button>
            ))}
          </ct-hstack>
        </ct-screen>
      ),
      title,
      notes,
      noteCount,
      backlinks,
      // Make notes discoverable via [[ autocomplete system-wide
      mentionable: notes,
      // LLM-callable streams for omnibot integration
      createNote: createNoteStreamAction,
      createNotes: createNotesStreamAction,
      setTitle: setTitleAction,
      createNotebook: createNotebookStreamAction,
      // Test-accessible action streams
      selectAllNotes: selectAllNotesAction,
      deselectAllNotes: deselectAllNotesAction,
      deleteSelected: deleteSelectedNotes({
        notes,
        selectedNoteIndices,
        allPieces,
        notebooks,
      }),
      duplicateSelected: doDuplicateSelectedNotes,
      showNewNoteModal: showNewNoteModalAction,
      cancelNewNote: cancelNewNotePromptAction,
      showNewNotebookModal: showNewNotebookModalAction,
      cancelNewNotebook: cancelNewNotebookPromptAction,
      cancelNewNestedNotebook: cancelNewNestedNotebookPromptAction,
      startEditTitle: startEditingTitleAction,
      stopEditTitle: stopEditingTitleAction,
      // Test-accessible state
      selectedNoteIndices,
      selectedCount,
      hasSelection,
      showNewNotePrompt,
      showNewNotebookPrompt,
      showNewNestedNotebookPrompt,
      isEditingTitle,
    };
  },
);

export default Notebook;
