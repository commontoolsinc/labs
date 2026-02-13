/// <cts-enable />
/**
 * Test Pattern: Notebook
 *
 * Comprehensive tests for the notebook pattern:
 * - Initial state with provided values
 * - noteCount computed from notes array
 * - setTitle stream for renaming
 * - createNote stream for adding notes
 * - createNotes stream for bulk adding (commented out due to multi-push bug)
 * - Selection system (selectAll, deselectAll)
 * - Modal state management (showNewNoteModal, cancelNewNote, etc.)
 * - Title editing (startEditTitle, stopEditTitle)
 * - Delete selected notes
 * - Duplicate selected notes
 * - NAME computed format
 * - createNotebook stream for nested notebooks
 * - SELF-dependent functionality: parentNotebook set correctly on created notes
 *
 * The test harness sets up defaultPattern so wish("#default") resolves,
 * enabling tests for handlers that push to allPieces.
 *
 * KNOWN ISSUE: Tests for SELF-dependent parentNotebook currently FAIL.
 * These failures demonstrate the bug where handlers using SELF don't properly
 * set the parentNotebook reference on created notes. See investigation notes.
 *
 * Run: deno task ct test packages/patterns/notes/notebook.test.tsx --verbose
 */
import { action, computed, NAME, pattern } from "commontools";
import Notebook from "./notebook.tsx";
import Note from "./note.tsx";
import { generateId } from "./schemas.tsx";

export default pattern(() => {
  // Create some initial notes for testing
  const note1 = Note({
    title: "First Note",
    content: "Content of first note",
    noteId: generateId(),
    isHidden: true,
  });

  const note2 = Note({
    title: "Second Note",
    content: "Content of second note",
    noteId: generateId(),
    isHidden: true,
  });

  const notebook = Notebook({
    title: "Test Notebook",
    notes: [note1, note2],
    isHidden: false,
  });

  // Create an empty notebook for empty state tests
  const emptyNotebook = Notebook({
    title: "Empty Notebook",
    notes: [],
    isHidden: false,
  });

  // Create a notebook for selection/deletion/duplication tests
  const selectionNotebook = Notebook({
    title: "Selection Test",
    notes: [
      Note({
        title: "Note A",
        content: "Content A",
        noteId: generateId(),
        isHidden: true,
      }),
      Note({
        title: "Note B",
        content: "Content B",
        noteId: generateId(),
        isHidden: true,
      }),
    ],
    isHidden: false,
  });

  // ==========================================================================
  // Actions - Initial State
  // ==========================================================================

  const action_rename_notebook = action(() => {
    notebook.setTitle.send({ newTitle: "Renamed Notebook" });
  });

  const action_rename_again = action(() => {
    notebook.setTitle.send({ newTitle: "Final Name" });
  });

  const action_create_note_via_stream = action(() => {
    notebook.createNote.send({
      title: "Stream Created Note",
      content: "Created via createNote stream",
    });
  });

  // KNOWN BUG: Multi-push times out due to stale commit promise backlog.
  // See docs/development/debugging/multi-push-action-timeout.md
  // Passes with --timeout 30000 but not the default 5s.
  const _action_create_multiple_notes = action(() => {
    notebook.createNotes.send({
      notesData: [
        { title: "Bulk Note 1", content: "First bulk note" },
        { title: "Bulk Note 2", content: "Second bulk note" },
      ],
    });
  });

  // ==========================================================================
  // Actions - Selection System
  // ==========================================================================

  const action_select_all = action(() => {
    selectionNotebook.selectAllNotes.send();
  });

  const action_deselect_all = action(() => {
    selectionNotebook.deselectAllNotes.send();
  });

  // ==========================================================================
  // Actions - Modal State Management
  // ==========================================================================

  const action_show_new_note_modal = action(() => {
    notebook.showNewNoteModal.send();
  });

  const action_cancel_new_note = action(() => {
    notebook.cancelNewNote.send();
  });

  const action_show_new_notebook_modal = action(() => {
    notebook.showNewNotebookModal.send();
  });

  const action_cancel_new_notebook = action(() => {
    notebook.cancelNewNestedNotebook.send();
  });

  // ==========================================================================
  // Actions - Title Editing
  // ==========================================================================

  const action_start_editing = action(() => {
    notebook.startEditTitle.send();
  });

  const action_stop_editing = action(() => {
    notebook.stopEditTitle.send();
  });

  // ==========================================================================
  // Actions - Delete Selected
  // ==========================================================================

  const action_delete_selected = action(() => {
    selectionNotebook.deleteSelected.send();
  });

  // ==========================================================================
  // Actions - Create Nested Notebook
  // ==========================================================================

  const action_create_notebook_via_stream = action(() => {
    notebook.createNotebook.send({
      title: "Nested Notebook",
      notesData: [
        { title: "Nested Note 1", content: "Content 1" },
      ],
    });
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_title = computed(() =>
    notebook.title === "Test Notebook"
  );
  const assert_initial_note_count = computed(() => notebook.noteCount === 2);
  const assert_is_notebook_flag = computed(() => notebook.isNotebook === true);
  const assert_initial_not_hidden = computed(() => notebook.isHidden === false);
  const assert_notes_array_length = computed(() => notebook.notes.length === 2);

  // Empty notebook assertions
  const assert_empty_notebook_count = computed(() =>
    emptyNotebook.noteCount === 0
  );
  const assert_empty_notebook_notes = computed(() =>
    emptyNotebook.notes.length === 0
  );

  // ==========================================================================
  // Assertions - After Rename
  // ==========================================================================

  const assert_title_renamed = computed(() =>
    notebook.title === "Renamed Notebook"
  );
  const assert_title_final = computed(() => notebook.title === "Final Name");

  // ==========================================================================
  // Assertions - After Creating Notes via Stream
  // ==========================================================================

  // After createNote, should have 3 notes
  const assert_note_count_after_create = computed(() =>
    notebook.noteCount === 3
  );

  // The third note (index 2) was created via stream - verify it has parentNotebook
  const assert_created_note_has_parent = computed(() => {
    const notesList = notebook.notes;
    if (notesList.length < 3) return false;
    const createdNote = notesList[2] as any; // Cast to any to access parentNotebook
    return !!createdNote?.parentNotebook;
  });

  const assert_created_note_parent_title = computed(() => {
    const notesList = notebook.notes;
    if (notesList.length < 3) return false;
    const createdNote = notesList[2] as any; // Cast to any to access parentNotebook
    return createdNote?.parentNotebook?.title === notebook.title;
  });

  // After createNotes with 2 notes, should have 5 total
  // KNOWN BUG: see multi-push-action-timeout.md
  const _assert_note_count_after_bulk = computed(() =>
    notebook.noteCount === 5
  );

  // ==========================================================================
  // Assertions - Selection System
  // ==========================================================================

  const assert_selection_initial = computed(() =>
    selectionNotebook.selectedNoteIndices.length === 0 &&
    selectionNotebook.hasSelection === false &&
    selectionNotebook.selectedCount === 0
  );

  const assert_all_selected = computed(() =>
    selectionNotebook.selectedNoteIndices.length === 2 &&
    selectionNotebook.hasSelection === true &&
    selectionNotebook.selectedCount === 2
  );

  const assert_none_selected = computed(() =>
    selectionNotebook.selectedNoteIndices.length === 0 &&
    selectionNotebook.hasSelection === false &&
    selectionNotebook.selectedCount === 0
  );

  // ==========================================================================
  // Assertions - Modal State Management
  // ==========================================================================

  const assert_initial_modal_state = computed(() =>
    notebook.showNewNotePrompt === false &&
    notebook.showNewNotebookPrompt === false &&
    notebook.showNewNestedNotebookPrompt === false
  );

  const assert_new_note_modal_shown = computed(() =>
    notebook.showNewNotePrompt === true
  );

  const assert_new_note_modal_hidden = computed(() =>
    notebook.showNewNotePrompt === false
  );

  const assert_new_notebook_modal_shown = computed(() =>
    notebook.showNewNestedNotebookPrompt === true
  );

  const assert_new_notebook_modal_hidden = computed(() =>
    notebook.showNewNestedNotebookPrompt === false
  );

  // ==========================================================================
  // Assertions - Title Editing
  // ==========================================================================

  const assert_not_editing_title = computed(() =>
    notebook.isEditingTitle === false
  );

  const assert_editing_title = computed(() => notebook.isEditingTitle === true);

  const assert_stopped_editing_title = computed(() =>
    notebook.isEditingTitle === false
  );

  // ==========================================================================
  // Assertions - Delete Selected
  // ==========================================================================

  const assert_notes_deleted = computed(() =>
    selectionNotebook.noteCount === 0 &&
    selectionNotebook.notes.length === 0 &&
    selectionNotebook.selectedNoteIndices.length === 0
  );

  // ==========================================================================
  // Assertions - Duplicate Selected (run on fresh notebook)
  // ==========================================================================

  // Create a fresh notebook for duplication test
  const dupNotebook = Notebook({
    title: "Dup Test",
    notes: [
      Note({
        title: "Original 1",
        content: "Content 1",
        noteId: generateId(),
        isHidden: true,
      }),
      Note({
        title: "Original 2",
        content: "Content 2",
        noteId: generateId(),
        isHidden: true,
      }),
    ],
    isHidden: false,
  });

  const action_select_all_dup = action(() => {
    dupNotebook.selectAllNotes.send();
  });

  const action_duplicate_dup = action(() => {
    dupNotebook.duplicateSelected.send();
  });

  const assert_dup_initial_count = computed(() => dupNotebook.noteCount === 2);

  const assert_dup_all_selected = computed(() =>
    dupNotebook.selectedNoteIndices.length === 2
  );

  const assert_duplicated = computed(() =>
    dupNotebook.noteCount === 4 &&
    dupNotebook.selectedNoteIndices.length === 0
  );

  // Verify duplicated notes have parent set
  const assert_dup_notes_have_parent = computed(() => {
    const notesList = dupNotebook.notes;
    if (notesList.length < 4) return false;
    // Notes at index 2 and 3 are the duplicates
    const dup1 = notesList[2] as any;
    const dup2 = notesList[3] as any;
    return !!dup1?.parentNotebook && !!dup2?.parentNotebook;
  });

  // ==========================================================================
  // Assertions - NAME Computed Format
  // ==========================================================================

  const assert_name_format = computed(() => {
    const name = notebook[NAME];
    return typeof name === "string" &&
      name.includes("📓") &&
      name.includes(notebook.title) &&
      name.includes(String(notebook.noteCount));
  });

  // ==========================================================================
  // Assertions - Create Nested Notebook
  // ==========================================================================

  const assert_notebook_created = computed(() => notebook.noteCount === 4 // 3 notes + 1 nested notebook
  );

  // The nested notebook should have the note inside it
  const assert_nested_notebook_has_note = computed(() => {
    const notesList = notebook.notes;
    // Find the last item, which should be the nested notebook
    const last = notesList[notesList.length - 1];
    // The nested notebook was created with notesData, so it should have 1 note
    return !!last && (last as any)?.notes?.length === 1;
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Initial state ===
      { assertion: assert_initial_title },
      { assertion: assert_initial_note_count },
      { assertion: assert_is_notebook_flag },
      { assertion: assert_initial_not_hidden },
      { assertion: assert_notes_array_length },

      // === Empty notebook ===
      { assertion: assert_empty_notebook_count },
      { assertion: assert_empty_notebook_notes },

      // === Rename via setTitle stream ===
      { action: action_rename_notebook },
      { assertion: assert_title_renamed },

      { action: action_rename_again },
      { assertion: assert_title_final },

      // === Create note via stream ===
      { action: action_create_note_via_stream },
      { assertion: assert_note_count_after_create },
      { assertion: assert_created_note_has_parent },
      { assertion: assert_created_note_parent_title },

      // === NAME computed format ===
      { assertion: assert_name_format },

      // === Selection system ===
      { assertion: assert_selection_initial },
      { action: action_select_all },
      { assertion: assert_all_selected },
      { action: action_deselect_all },
      { assertion: assert_none_selected },

      // === Modal state management ===
      { assertion: assert_initial_modal_state },
      { action: action_show_new_note_modal },
      { assertion: assert_new_note_modal_shown },
      { action: action_cancel_new_note },
      { assertion: assert_new_note_modal_hidden },
      { action: action_show_new_notebook_modal },
      { assertion: assert_new_notebook_modal_shown },
      { action: action_cancel_new_notebook },
      { assertion: assert_new_notebook_modal_hidden },

      // === Title editing ===
      { assertion: assert_not_editing_title },
      { action: action_start_editing },
      { assertion: assert_editing_title },
      { action: action_stop_editing },
      { assertion: assert_stopped_editing_title },

      // === Duplicate selected (on fresh notebook) ===
      { assertion: assert_dup_initial_count },
      { action: action_select_all_dup },
      { assertion: assert_dup_all_selected },
      { action: action_duplicate_dup },
      { assertion: assert_duplicated },
      { assertion: assert_dup_notes_have_parent },

      // === Delete selected (destructive, run last on selectionNotebook) ===
      { action: action_select_all },
      { action: action_delete_selected },
      { assertion: assert_notes_deleted },

      // === Create nested notebook ===
      { action: action_create_notebook_via_stream },
      { assertion: assert_notebook_created },
      { assertion: assert_nested_notebook_has_note },
      // === Bulk create notes ===
      // KNOWN BUG: commented out, see multi-push-action-timeout.md
      // { action: action_create_multiple_notes },
      // { assertion: assert_note_count_after_bulk },
    ],
    notebook,
    emptyNotebook,
    selectionNotebook,
    dupNotebook,
  };
});
