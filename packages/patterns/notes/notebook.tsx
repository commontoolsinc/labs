/// <cts-enable />
import {
  action,
  computed,
  type Default,
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

type NotePiece = {
  [NAME]?: string;
  title?: string;
  content?: string;
  isHidden?: boolean;
  noteId?: string;
};

type MinimalPiece = {
  [NAME]?: string;
};

// Helper to safely get notes array from a notebook (handles Cell/Writable or plain array)
function _getNotebookNotesArray(notebook: unknown): unknown[] {
  const notes = (notebook as any)?.notes;
  if (!notes) return [];
  // Check if it's a Cell/Writable with .get() method
  if (typeof notes.get === "function") {
    return notes.get() ?? [];
  }
  // Plain array
  return Array.isArray(notes) ? notes : [];
}

// Helper to get a comparable name from a piece (handles both local and wish({ query: "#default" }) pieces)
function getPieceName(piece: unknown): string {
  // First try [NAME] (works for wish({ query: "#default" }) pieces)
  const symbolName = (piece as any)?.[NAME];
  if (typeof symbolName === "string") return symbolName;
  // Fallback to title (works for local pieces)
  const titleProp = (piece as any)?.title;
  if (typeof titleProp === "string") return titleProp;
  return "";
}

interface Input {
  title?: Default<string, "Notebook">;
  notes?: Writable<Default<NotePiece[], []>>;
  isNotebook?: Default<boolean, true>; // Marker for identification through proxy
  isHidden?: Default<boolean, false>; // Hide from default-app piece list when nested
  parentNotebook?: any; // Reference to parent notebook (set on navigation for back link)
}

interface Output {
  [NAME]?: string;
  [UI]?: VNode;
  title: string;
  notes: NotePiece[];
  noteCount: number;
  isNotebook: boolean;
  isHidden: boolean;
  parentNotebook: any; // Reference to parent notebook (reactive)
  backlinks: MentionablePiece[];
  // LLM-callable streams for omnibot integration
  createNote: Stream<{ title: string; content: string }>;
  createNotes: Stream<{ notesData: Array<{ title: string; content: string }> }>;
  setTitle: Stream<{ newTitle: string }>;
  createNotebook: Stream<{
    title: string;
    notesData?: Array<{ title: string; content: string }>;
  }>;
}

// Handler to show the new note modal
const showNewNoteModal = handler<
  void,
  { showNewNotePrompt: Writable<boolean> }
>(
  (_, { showNewNotePrompt }) => showNewNotePrompt.set(true),
);

// Handler to show the new notebook modal (from header button)
const showNewNotebookModal = handler<
  void,
  { showNewNestedNotebookPrompt: Writable<boolean> }
>((_, { showNewNestedNotebookPrompt }) =>
  showNewNestedNotebookPrompt.set(true)
);

// Handler to create note and navigate to it (unless "Create Another" was used)
const createNoteAndOpen = handler<
  void,
  {
    newNoteTitle: Writable<string>;
    showNewNotePrompt: Writable<boolean>;
    notes: Writable<NotePiece[]>;
    allPieces: Writable<NotePiece[]>;
    usedCreateAnotherNote: Writable<boolean>;
    self: any;
  }
>((
  _,
  {
    newNoteTitle,
    showNewNotePrompt,
    notes,
    allPieces,
    usedCreateAnotherNote,
    self,
  },
) => {
  const title = newNoteTitle.get() || "New Note";
  const newNote = Note({
    title,
    content: "",
    isHidden: true,
    noteId: generateId(),
    parentNotebook: self, // Set parent at creation for back navigation
  });
  allPieces.push(newNote as any); // Required for persistence
  notes.push(newNote);

  const shouldNavigate = !usedCreateAnotherNote.get();

  // Reset modal state
  showNewNotePrompt.set(false);
  newNoteTitle.set("");
  usedCreateAnotherNote.set(false);

  // Only navigate if "Create Another" was never used in this session
  if (shouldNavigate) {
    return navigateTo(newNote);
  }
});

// Handler to create note and stay in modal to create another
const createNoteAndContinue = handler<
  void,
  {
    newNoteTitle: Writable<string>;
    notes: Writable<NotePiece[]>;
    allPieces: Writable<NotePiece[]>;
    usedCreateAnotherNote: Writable<boolean>;
    self: any;
  }
>((_, { newNoteTitle, notes, allPieces, usedCreateAnotherNote, self }) => {
  const title = newNoteTitle.get() || "New Note";
  const newNote = Note({
    title,
    content: "",
    isHidden: true,
    noteId: generateId(),
    parentNotebook: self, // Set parent for back navigation
  });
  allPieces.push(newNote as any); // Required for persistence
  notes.push(newNote);
  // Mark that "Create Another" was used
  usedCreateAnotherNote.set(true);
  // Keep modal open, just clear the title for the next note
  newNoteTitle.set("");
});

// Handler to cancel new note prompt
const cancelNewNotePrompt = handler<
  void,
  {
    showNewNotePrompt: Writable<boolean>;
    newNoteTitle: Writable<string>;
    usedCreateAnotherNote: Writable<boolean>;
  }
>((_, { showNewNotePrompt, newNoteTitle, usedCreateAnotherNote }) => {
  showNewNotePrompt.set(false);
  newNoteTitle.set("");
  usedCreateAnotherNote.set(false);
});

// Handler to remove a note from this notebook (but keep it in the space)
const removeFromNotebook = handler<
  Record<string, never>,
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

// Handler for dropping a piece onto this notebook
const _handlePieceDrop = handler<
  { detail: { sourceCell: Writable<NotePiece> } },
  { notes: Writable<NotePiece[]> }
>((event, { notes }) => {
  const sourceCell = event.detail.sourceCell;
  const notesList = notes.get() ?? [];

  // Prevent duplicates using Writable.equals
  const alreadyExists = notesList.some((n) => equals(sourceCell, n as any));
  if (alreadyExists) return;

  // Hide from Pages list
  sourceCell.key("isHidden").set(true);

  // Add to notebook - push cell reference, not value, to maintain piece identity
  notes.push(sourceCell);
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

  // Check if dragged item is in the selection (from a sibling notebook drag)
  // For sibling notebooks, we check if the dragged cell matches any selected item
  const draggedIndex = notesList.findIndex((n: any) => equals(sourceCell, n));
  const isDraggedInSelection = draggedIndex >= 0 &&
    selected.includes(draggedIndex);

  if (isDraggedInSelection && selected.length > 1) {
    // Multi-item move: gather all selected items
    const itemsToMove = selected.map((idx) => notesList[idx]).filter(Boolean);

    // Track by noteId and title (like moveSelectedToNotebook)
    const selectedNoteIds: string[] = [];
    const selectedTitles: string[] = [];
    for (const item of itemsToMove) {
      const noteId = (item as any)?.noteId;
      const title = (item as any)?.title;
      if (noteId) {
        selectedNoteIds.push(noteId);
      } else if (title) {
        selectedTitles.push(title);
      }
    }

    const shouldRemove = (n: any) => {
      if (n?.noteId && selectedNoteIds.includes(n.noteId)) return true;
      if (!n?.noteId && n?.title && selectedTitles.includes(n.title)) {
        return true;
      }
      return false;
    };

    // Remove from ALL other notebooks' notes arrays (move semantics)
    const notebooksList = notebooks.get();
    for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
      const nbCell = notebooks.key(nbIdx);
      const nbNotesCell = nbCell.key("notes");
      const nbNotes = (nbNotesCell.get() as unknown[]) ?? [];

      const filtered = nbNotes.filter((n: any) => !shouldRemove(n));
      if (filtered.length !== nbNotes.length) {
        nbNotesCell.set(filtered as NotePiece[]);
      }
    }

    // Add all to this notebook (deduplicated)
    for (const item of itemsToMove) {
      const alreadyExists = notesList.some((n) =>
        equals(item as any, n as any)
      );
      if (!alreadyExists) {
        notes.push(item as any);
        (item as any).key?.("isHidden")?.set?.(true);
      }
    }

    // Clear selection
    selectedNoteIndices.set([]);
  } else {
    // Single-item move (existing logic)
    const sourceTitle = (sourceCell as any).key("title").get();

    // Prevent duplicates
    const alreadyExists = notesList.some((n) => equals(sourceCell, n as any));
    if (alreadyExists) return;

    // Remove from ALL other notebooks' notes arrays (move semantics)
    const notebooksList = notebooks.get();
    for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
      const nbCell = notebooks.key(nbIdx);
      const nbNotesCell = nbCell.key("notes");
      const nbNotes = (nbNotesCell.get() as unknown[]) ?? [];

      // Find and remove by title or Writable.equals
      const filtered = nbNotes.filter((n: any) => {
        if (n?.title === sourceTitle) return false;
        if (equals(sourceCell, n as any)) return false;
        return true;
      });
      if (filtered.length !== nbNotes.length) {
        nbNotesCell.set(filtered as NotePiece[]);
      }
    }

    // Hide from default-app piece list
    sourceCell.key("isHidden").set(true);

    // Add to this notebook
    notes.push(sourceCell as any);
  }
});

// Handler for dropping any item onto a notebook - moves from current notebook to target
// Supports multi-item drag: if dragged item is in selection, moves ALL selected items
const handleDropOntoNotebook = handler<
  { detail: { sourceCell: Writable<unknown> } },
  {
    targetNotebook: Writable<{ notes?: unknown[]; isNotebook?: boolean }>;
    currentNotes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    notebooks: Writable<NotebookPiece[]>;
  }
>((event, { targetNotebook, currentNotes, selectedNoteIndices, notebooks }) => {
  const sourceCell = event.detail.sourceCell;

  // Check if target is actually a notebook
  const isTargetNotebook = targetNotebook.key("isNotebook").get();
  if (!isTargetNotebook) return;

  const targetNotesCell = targetNotebook.key("notes");
  const targetNotesList = (targetNotesCell.get() as unknown[]) ?? [];
  const currentList = currentNotes.get();
  const selected = selectedNoteIndices.get();

  // Check if dragged item is in the selection
  const draggedIndex = currentList.findIndex((n: any) => equals(sourceCell, n));
  const isDraggedInSelection = draggedIndex >= 0 &&
    selected.includes(draggedIndex);

  if (isDraggedInSelection && selected.length > 1) {
    // Multi-item move: gather all selected items
    const itemsToMove = selected.map((idx) => currentList[idx]).filter(Boolean);

    // Track by noteId and title (like moveSelectedToNotebook)
    const selectedNoteIds: string[] = [];
    const selectedTitles: string[] = [];
    for (const item of itemsToMove) {
      const noteId = (item as any)?.noteId;
      const title = (item as any)?.title;
      if (noteId) {
        selectedNoteIds.push(noteId);
      } else if (title) {
        selectedTitles.push(title);
      }
    }

    const shouldRemove = (n: any) => {
      if (n?.noteId && selectedNoteIds.includes(n.noteId)) return true;
      if (!n?.noteId && n?.title && selectedTitles.includes(n.title)) {
        return true;
      }
      return false;
    };

    // Add all to target (deduplicated)
    for (const item of itemsToMove) {
      const alreadyInTarget = targetNotesList.some((n) =>
        equals(item as any, n as any)
      );
      if (!alreadyInTarget) {
        targetNotesCell.push(item);
        (item as any).key?.("isHidden")?.set?.(true);
      }
    }

    // Remove from all notebooks EXCEPT the target (move semantics)
    const notebooksList = notebooks.get();
    const targetTitle = targetNotebook.key("title").get();
    for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
      const nbCell = notebooks.key(nbIdx);
      // Skip the target notebook - we just added items there
      const nbTitle = nbCell.key("title").get();
      if (nbTitle === targetTitle) continue;

      const nbNotesCell = nbCell.key("notes");
      const nbNotes = nbNotesCell.get() ?? [];

      const filtered = nbNotes.filter((n: any) => !shouldRemove(n));
      if (filtered.length !== nbNotes.length) {
        nbNotesCell.set(filtered);
      }
    }

    // Remove from current notebook (which is different from target)
    const filtered = currentList.filter((n: any) => !shouldRemove(n));
    currentNotes.set(filtered);

    // Clear selection
    selectedNoteIndices.set([]);
  } else {
    // Single-item move (existing logic)
    // Prevent duplicates in target
    const alreadyInTarget = targetNotesList.some((n) =>
      equals(sourceCell, n as any)
    );
    if (alreadyInTarget) return;

    // Remove from current notebook if present
    const indexInCurrent = currentList.findIndex((n: any) =>
      equals(sourceCell, n)
    );
    if (indexInCurrent !== -1) {
      const copy = [...currentList];
      copy.splice(indexInCurrent, 1);
      currentNotes.set(copy);
    }

    // Hide from default-app piece list
    sourceCell.key("isHidden").set(true);

    // Add to target notebook
    targetNotesCell.push(sourceCell);
  }
});

// Create nested notebook and navigate to it (unless "Create Another" was used)
// Note: Notebooks are created empty; a default note is created lazily when opened
const createNestedNotebookAndOpen = handler<
  void,
  {
    newNestedNotebookTitle: Writable<string>;
    showNewNestedNotebookPrompt: Writable<boolean>;
    notes: Writable<NotePiece[]>;
    allPieces: Writable<NotePiece[]>;
    usedCreateAnotherNotebook: Writable<boolean>;
    self: any;
  }
>((
  _,
  {
    newNestedNotebookTitle,
    showNewNestedNotebookPrompt,
    notes,
    allPieces,
    usedCreateAnotherNotebook,
    self,
  },
) => {
  const title = newNestedNotebookTitle.get() || "New Notebook";

  const nb = Notebook({
    title,
    notes: [],
    isHidden: true,
    parentNotebook: self,
  });
  allPieces.push(nb);
  notes.push(nb);

  const shouldNavigate = !usedCreateAnotherNotebook.get();

  // Reset modal state
  showNewNestedNotebookPrompt.set(false);
  newNestedNotebookTitle.set("");
  usedCreateAnotherNotebook.set(false);

  // Only navigate if "Create Another" was never used in this session
  if (shouldNavigate) {
    return navigateTo(nb);
  }
});

// Create nested notebook and keep modal open for another
// Note: Notebooks are created empty; a default note is created lazily when opened
const createNestedNotebookAndContinue = handler<
  void,
  {
    newNestedNotebookTitle: Writable<string>;
    notes: Writable<NotePiece[]>;
    allPieces: Writable<NotePiece[]>;
    usedCreateAnotherNotebook: Writable<boolean>;
  }
>((
  _,
  { newNestedNotebookTitle, notes, allPieces, usedCreateAnotherNotebook },
) => {
  const title = newNestedNotebookTitle.get() || "New Notebook";

  const nb = Notebook({
    title,
    notes: [],
    isHidden: true,
  });
  allPieces.push(nb);
  notes.push(nb);
  // Mark that "Create Another" was used
  usedCreateAnotherNotebook.set(true);
  newNestedNotebookTitle.set("");
});

// Cancel nested notebook creation
const cancelNewNestedNotebookPrompt = handler<
  void,
  {
    showNewNestedNotebookPrompt: Writable<boolean>;
    newNestedNotebookTitle: Writable<string>;
    usedCreateAnotherNotebook: Writable<boolean>;
  }
>((
  _,
  {
    showNewNestedNotebookPrompt,
    newNestedNotebookTitle,
    usedCreateAnotherNotebook,
  },
) => {
  showNewNestedNotebookPrompt.set(false);
  newNestedNotebookTitle.set("");
  usedCreateAnotherNotebook.set(false);
});

// Simple button handler: Go to All Notes (no menu state)
const goToAllNotes = handler<void, { allPieces: Writable<NotePiece[]> }>(
  (_, { allPieces }) => {
    const pieces = allPieces.get();
    const existing = pieces.find((piece: any) => {
      const name = piece?.[NAME];
      return typeof name === "string" && name.startsWith("All Notes");
    });
    if (existing) {
      return navigateTo(existing);
    }
  },
);

// Handler for clicking on a backlink
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>(
  (_, { piece }) => navigateTo(piece),
);

// Handler to navigate to parent notebook
const goToParent = handler<
  Record<string, never>,
  { self: any }
>(
  (_, { self }) => {
    const p = (self as any).parentNotebook;
    if (p) navigateTo(p);
  },
);

// Handler to navigate to a child (note or notebook) - sets parent for back navigation
const navigateToChild = handler<
  Record<string, never>,
  { child: Writable<any>; self: any }
>(
  (_, { child, self }) => {
    // Set the child's parentNotebook to current notebook for back navigation
    child.key("parentNotebook").set(self);
    navigateTo(child);
  },
);

// Handler to select all notes in this notebook
const selectAllNotes = handler<
  Record<string, never>,
  { notes: Writable<NotePiece[]>; selectedNoteIndices: Writable<number[]> }
>((_, { notes, selectedNoteIndices }) => {
  const notesList = notes.get();
  selectedNoteIndices.set(notesList.map((_, i) => i));
});

// Handler to deselect all notes
const deselectAllNotes = handler<
  Record<string, never>,
  { selectedNoteIndices: Writable<number[]> }
>((_, { selectedNoteIndices }) => {
  selectedNoteIndices.set([]);
});

// Handler to duplicate selected notes
const _duplicateSelectedNotes = handler<
  Record<string, never>,
  {
    notes: Writable<NotePiece[]>;
    allPieces: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
  }
>((_, { notes, allPieces, selectedNoteIndices }) => {
  const selected = selectedNoteIndices.get();
  const notesList = notes.get();

  // Collect copies first, then batch push (reduces N reactive cycles to 1)
  const copies: NotePiece[] = [];
  for (const idx of selected) {
    const original = notesList[idx];
    if (original) {
      copies.push(Note({
        title: (original.title ?? "Note") + " (Copy)",
        content: original.content ?? "",
        isHidden: true,
        noteId: generateId(),
      }));
    }
  }
  allPieces.push(...copies); // Required for persistence
  notes.push(...copies);
  selectedNoteIndices.set([]);
});

type NotebookPiece = {
  [NAME]?: string;
  notes?: NotePiece[];
};

// Handler to permanently delete selected notes from the space
const deleteSelectedNotes = handler<
  Record<string, never>,
  {
    notes: Writable<NotePiece[]>;
    selectedNoteIndices: Writable<number[]>;
    allPieces: Writable<NotePiece[]>;
    notebooks: Writable<NotebookPiece[]>;
  }
>((_, { notes, selectedNoteIndices, allPieces, notebooks }) => {
  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const allPiecesList = allPieces.get();
  const notebooksList = notebooks.get();

  // Collect noteIds and titles to delete (titles for notebooks which don't have noteId)
  const noteIdsToDelete: string[] = [];
  const titlesToDelete: string[] = [];
  for (const idx of selected) {
    const item = notesList[idx];
    const noteId = (item as any)?.noteId;
    const title = (item as any)?.title;
    if (noteId) {
      noteIdsToDelete.push(noteId);
    } else if (title) {
      // Notebooks don't have noteId, use title instead
      titlesToDelete.push(title);
    }
  }

  // Helper to check if item should be deleted
  const shouldDelete = (n: any) => {
    if (n?.noteId && noteIdsToDelete.includes(n.noteId)) return true;
    if (!n?.noteId && n?.title && titlesToDelete.includes(n.title)) return true;
    return false;
  };

  // Remove from all notebooks first (including this one)
  for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
    const nbCell = notebooks.key(nbIdx);
    const nbNotesCell = nbCell.key("notes");
    const nbNotes = nbNotesCell.get() ?? [];

    const filtered = nbNotes.filter((n: any) => !shouldDelete(n));
    if (filtered.length !== nbNotes.length) {
      nbNotesCell.set(filtered);
    }
  }

  // Also remove from this notebook's notes array
  const filteredNotes = notesList.filter((n: any) => !shouldDelete(n));
  notes.set(filteredNotes);

  // Remove from allPieces (permanent delete)
  const filteredPieces = allPiecesList.filter((piece: any) =>
    !shouldDelete(piece)
  );
  allPieces.set(filteredPieces);

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

  // Collect notes/notebooks and IDs/titles for removal
  const selectedNoteIds: string[] = [];
  const selectedTitles: string[] = []; // For notebooks (no noteId)
  const notesToMove: NotePiece[] = [];
  for (const idx of selected) {
    const item = notesList[idx];
    const noteId = (item as any)?.noteId;
    const title = (item as any)?.title;
    if (noteId) {
      selectedNoteIds.push(noteId);
    } else if (title) {
      selectedTitles.push(title);
    }
    if (item) notesToMove.push(item);
  }

  // Helper to check if item should be removed
  const shouldRemove = (n: any) => {
    if (n?.noteId && selectedNoteIds.includes(n.noteId)) return true;
    if (!n?.noteId && n?.title && selectedTitles.includes(n.title)) return true;
    return false;
  };

  // Add to target notebook in one operation
  (targetNotebookNotes as Writable<NotePiece[] | undefined>).push(
    ...notesToMove,
  );

  // Remove from all notebooks
  for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
    // Don't remove from the target notebook we just added to
    if (nbIdx === nbIndex) continue;

    const nbCell = notebooks.key(nbIdx);
    const nbNotesCell = nbCell.key("notes");
    const nbNotes = nbNotesCell.get() ?? [];

    const filtered = nbNotes.filter((n: any) => !shouldRemove(n));
    if (filtered.length !== nbNotes.length) {
      nbNotesCell.set(filtered);
    }
  }

  // Remove from this notebook
  const filtered = notesList.filter((n: any) => !shouldRemove(n));
  notes.set(filtered);

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
  const action = pendingNotebookAction.get();

  // Gather selected items and track by noteId (notes) or title (notebooks)
  const selected = selectedNoteIndices.get();
  const notesList = notes.get();
  const selectedItems: NotePiece[] = [];
  const selectedNoteIds: string[] = [];
  const selectedTitles: string[] = []; // For notebooks (no noteId)

  for (const idx of selected) {
    const item = notesList[idx];
    if (item) {
      selectedItems.push(item);
      const noteId = (item as any)?.noteId;
      const title = (item as any)?.title;
      if (noteId) {
        selectedNoteIds.push(noteId);
      } else if (title) {
        selectedTitles.push(title);
      }
    }
  }

  // Helper to check if item should be removed
  const shouldRemove = (n: any) => {
    if (n?.noteId && selectedNoteIds.includes(n.noteId)) return true;
    if (!n?.noteId && n?.title && selectedTitles.includes(n.title)) return true;
    return false;
  };

  // Create the notebook with items already included (hidden from default-app)
  const newNotebook = Notebook({
    title: name,
    notes: selectedItems,
    isHidden: true,
  });
  allPieces.push(newNotebook);

  if (action === "move") {
    // For move: remove selected items from existing notebooks and this notebook
    const notebooksList = notebooks.get();

    // Remove from all existing notebooks
    for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
      const nbCell = notebooks.key(nbIdx);
      const nbNotesCell = nbCell.key("notes");
      const nbNotes = nbNotesCell.get() ?? [];
      const filtered = nbNotes.filter((n: any) => !shouldRemove(n));
      if (filtered.length !== nbNotes.length) {
        nbNotesCell.set(filtered);
      }
    }

    // Remove selected items from this notebook, then add new notebook
    const filtered = notesList.filter((n: any) => !shouldRemove(n));
    notes.set([...filtered, newNotebook]);
  } else {
    // For add: just add the new notebook as sibling
    notes.push(newNotebook);
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
    showNewNotebookPrompt: Writable<boolean>;
    newNotebookName: Writable<string>;
    pendingNotebookAction: Writable<"add" | "move" | "">;
    selectedAddNotebook: Writable<string>;
    selectedMoveNotebook: Writable<string>;
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
  { notes: Writable<NotePiece[]>; selectedNoteIndices: Writable<number[]> }
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

// Handler to toggle preview expansion for a note
const _togglePreviewExpansion = handler<
  Record<string, never>,
  { index: number; expandedPreviews: Writable<number[]> }
>((_, { index, expandedPreviews }) => {
  const current = expandedPreviews.get();
  if (current.includes(index)) {
    expandedPreviews.set(current.filter((i) => i !== index));
  } else {
    expandedPreviews.set([...current, index]);
  }
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

// LLM-callable handler: Create a single note in this notebook
const handleCreateNote = handler<
  { title: string; content: string },
  {
    notes: Writable<NotePiece[]>;
    allPieces: Writable<NotePiece[]>;
    self: any;
  }
>(({ title: noteTitle, content }, { notes, allPieces, self }) => {
  const newNote = Note({
    title: noteTitle,
    content,
    isHidden: true,
    noteId: generateId(),
    parentNotebook: self, // Set parent for back navigation
  });
  allPieces.push(newNote as any); // Required for persistence
  notes.push(newNote);
  return newNote;
});

// LLM-callable handler: Create multiple notes in bulk
const handleCreateNotes = handler<
  { notesData: Array<{ title: string; content: string }> },
  {
    notes: Writable<NotePiece[]>;
    allPieces: Writable<NotePiece[]>;
    self: any;
  }
>(({ notesData }, { notes, allPieces, self }) => {
  // Collect notes first, then batch push (reduces N reactive cycles to 1)
  const created: NotePiece[] = [];
  for (const data of notesData) {
    created.push(Note({
      title: data.title,
      content: data.content,
      isHidden: true,
      noteId: generateId(),
      parentNotebook: self, // Set parent for back navigation
    }));
  }
  allPieces.push(...created); // Required for persistence
  notes.push(...created);
  return created;
});

// LLM-callable handler: Rename the notebook
const handleSetTitle = handler<
  { newTitle: string },
  { title: Writable<string> }
>(({ newTitle }, { title }) => {
  title.set(newTitle);
  return newTitle;
});

// LLM-callable handler: Create a new notebook (optionally with notes)
// Note: If no notesData provided, notebook is created empty; a default note is created lazily when opened
const handleCreateNotebook = handler<
  { title: string; notesData?: Array<{ title: string; content: string }> },
  { allPieces: Writable<NotePiece[]> }
>(({ title: nbTitle, notesData }, { allPieces }) => {
  // Create notes with isHidden: true so they don't appear in DefaultPieceList
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

  // Create the notebook with the notes (empty if no notesData)
  const newNotebook = Notebook({
    title: nbTitle,
    notes: notesToAdd,
  });

  allPieces.push(newNotebook);
  return newNotebook;
});

const Notebook = pattern<Input, Output>(
  ({ title, notes, isNotebook, isHidden, parentNotebook, [SELF]: self }) => {
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

    // State for expanded note previews (tracks which note indices have full content shown)
    const _expandedPreviews = Writable.of<number[]>([]);

    // ===== Actions (close over notes, allPieces, self) =====

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

    // Filter to find all notebooks by checking if [NAME] contains "Notebook" or starts with notebook emoji
    // Pieces from wish({ query: "#default" }) only expose [NAME] at top level, not other properties
    const notebooks = computed(() =>
      allPieces.get().filter((piece: any) => {
        const name = piece?.[NAME];
        if (typeof name !== "string") return false;
        // Check for notebook emoji (first char code > 127 and contains "Notebook" pattern)
        // The emoji check via startsWith can have unicode issues, so check both
        return name.includes("Notebook") || name.includes("Child") ||
          name.charCodeAt(0) > 127;
      })
    );

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

    // Check if "All Notes" piece exists in the space
    const allNotesPiece = computed(() =>
      allPieces.get().find((piece: any) => {
        const name = piece?.[NAME];
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
                    display: computed(() => {
                      // Read from output's parentNotebook cell for reactive updates after drag
                      const p = (self as any).parentNotebook;
                      return p ? "flex" : "none";
                    }),
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
                      return p?.[NAME] ?? p?.title ?? "Parent";
                    })}
                    interactive
                    onct-click={goToParent({ self })}
                  />
                </ct-hstack>
                {/* Spacer when no parent */}
                <div
                  style={{
                    display: computed(() => {
                      const p = (self as any).parentNotebook;
                      return p ? "none" : "block";
                    }),
                  }}
                />

                <ct-button
                  variant="ghost"
                  onClick={goToAllNotes({ allPieces })}
                  style={{
                    padding: "8px 16px",
                    fontSize: "16px",
                    borderRadius: "8px",
                    display: computed(() => allNotesPiece ? "flex" : "none"),
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
                          onClick={showNewNoteModal({ showNewNotePrompt })}
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
                        <ct-button
                          size="sm"
                          variant="ghost"
                          title="New Notebook"
                          onClick={showNewNotebookModal({
                            showNewNestedNotebookPrompt,
                          })}
                          style={{
                            padding: "6px 12px",
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
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
                      display: computed(() => hasNotes ? "none" : "flex"),
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "48px 24px",
                      cursor: "pointer",
                      borderRadius: "8px",
                      border: "2px dashed var(--ct-color-border, #e5e5e7)",
                      background: "var(--ct-color-bg-secondary, #f9f9f9)",
                    }}
                    onClick={showNewNoteModal({ showNewNotePrompt })}
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
                      display: computed(() => hasNotes ? "flex" : "none"),
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
                        display: computed(() =>
                          notes.get().length > 1 ? "flex" : "none"
                        ),
                        alignItems: "center",
                        padding: "4px 0",
                        fontSize: "13px",
                        color: "var(--ct-color-text-secondary, #6e6e73)",
                      }}
                    >
                      {/* Checkbox column (32px + 4px padding) */}
                      <div style={{ width: "32px", padding: "0 4px" }}>
                        <ct-checkbox
                          checked={computed(() =>
                            notes.get().length > 0 &&
                            selectedNoteIndices.get().length ===
                              notes.get().length
                          )}
                          onct-change={computed(() =>
                            selectedNoteIndices.get().length ===
                                notes.get().length
                              ? deselectAllNotes({ selectedNoteIndices })
                              : selectAllNotes({ notes, selectedNoteIndices })
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

              {
                /* ================================================================
                  SIBLINGS FEATURE DISABLED FOR PERFORMANCE
                  See notebookRelationships computed for re-enabling instructions
                  ================================================================
              <ct-vstack
                gap="2"
                style={{
                  display: computed(() =>
                    _notebookRelationships.hasSiblings ? "flex" : "none"
                  ),
                  marginTop: "16px",
                  paddingTop: "16px",
                  borderTop: "1px solid var(--ct-color-border, #e5e5e7)",
                }}
              >
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "var(--ct-color-text-secondary, #6e6e73)",
                  }}
                >
                  Other notebooks:
                </span>
                <ct-vstack gap="1">
                  {_notebookRelationships.siblings.map((notebook) => (
                    <ct-drop-zone
                      accept="note,notebook"
                      onct-drop={handleDropOntoNotebook({
                        targetNotebook: notebook as any,
                        currentNotes: notes,
                        selectedNoteIndices,
                        notebooks,
                      })}
                    >
                      <ct-drag-source $cell={notebook} type="sibling">
                        <div
                          style={{ cursor: "pointer" }}
                          onClick={navigateToChild({ child: notebook, self })}
                        >
                          <ct-cell-context $cell={notebook}>
                            <ct-chip
                              label={notebook?.[NAME] ?? notebook?.title ?? "Untitled"}
                              interactive
                            />
                          </ct-cell-context>
                        </div>
                      </ct-drag-source>
                    </ct-drop-zone>
                  ))}
                </ct-vstack>
              </ct-vstack>
              */
              }
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
                onClick={cancelNewNotePrompt({
                  showNewNotePrompt,
                  newNoteTitle,
                  usedCreateAnotherNote,
                })}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="ghost"
                onClick={createNoteAndContinue({
                  newNoteTitle,
                  notes,
                  allPieces,
                  usedCreateAnotherNote,
                  self,
                })}
              >
                Create Another
              </ct-button>
              <ct-button
                variant="primary"
                onClick={createNoteAndOpen({
                  newNoteTitle,
                  showNewNotePrompt,
                  notes,
                  allPieces,
                  usedCreateAnotherNote,
                  self,
                })}
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
                onClick={cancelNewNestedNotebookPrompt({
                  showNewNestedNotebookPrompt,
                  newNestedNotebookTitle,
                  usedCreateAnotherNotebook,
                })}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="ghost"
                onClick={createNestedNotebookAndContinue({
                  newNestedNotebookTitle,
                  notes,
                  allPieces,
                  usedCreateAnotherNotebook,
                })}
              >
                Create Another
              </ct-button>
              <ct-button
                variant="primary"
                onClick={createNestedNotebookAndOpen({
                  newNestedNotebookTitle,
                  showNewNestedNotebookPrompt,
                  notes,
                  allPieces,
                  usedCreateAnotherNotebook,
                  self,
                })}
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
              display: computed(() =>
                backlinks.get().length > 0 ? "flex" : "none"
              ),
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
      parentNotebook,
      backlinks,
      // Make notes discoverable via [[ autocomplete system-wide
      mentionable: notes,
      // LLM-callable streams for omnibot integration
      createNote: handleCreateNote({ notes, allPieces, self }),
      createNotes: handleCreateNotes({ notes, allPieces, self }),
      setTitle: handleSetTitle({ title }),
      createNotebook: handleCreateNotebook({ allPieces }),
    };
  },
);

export default Notebook;
