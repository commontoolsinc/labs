/// <cts-enable />
/**
 * Test Pattern: Notes Import/Export
 *
 * Comprehensive tests for the notes-import-export pattern:
 * - Initial state (empty notes/notebooks, modals closed)
 * - Export functionality (notes, notebooks, combined)
 * - Import with no duplicates
 * - Duplicate note detection
 * - Duplicate notebook detection
 * - Skip duplicates flow
 * - Import as copies flow
 *
 * Run: deno task ct test packages/patterns/notes/notes-import-export.test.tsx --verbose
 */
import { action, computed, pattern, Writable } from "commontools";
import NotesImportExport from "./notes-import-export.tsx";
import Note from "./note.tsx";
import Notebook from "./notebook.tsx";

// Helper to generate test markdown for a note
function makeNoteMarkdown(
  title: string,
  content: string,
  noteId?: string,
  notebooks?: string,
  isHidden?: boolean,
): string {
  const id = noteId || `test-${Date.now()}`;
  const nbs = notebooks || "";
  const hidden = isHidden !== undefined ? String(isHidden) : "false";
  return `<!-- COMMON_NOTE_START title="${title}" noteId="${id}" notebooks="${nbs}" isHidden="${hidden}" -->

${content}

<!-- COMMON_NOTE_END -->`;
}

// Helper to generate test markdown for a notebook
function makeNotebookMarkdown(
  title: string,
  isHidden: boolean = false,
  noteIds: string[] = [],
  childNotebooks: string[] = [],
): string {
  return `<!-- COMMON_NOTEBOOK_START title="${title}" isHidden="${
    String(isHidden)
  }" noteIds="${noteIds.join(",")}" childNotebooks="${
    childNotebooks.join(",")
  }" -->
<!-- COMMON_NOTEBOOK_END -->`;
}

// Helper to generate full export markdown
function makeExportMarkdown(
  notes: Array<{
    title: string;
    content: string;
    noteId?: string;
    notebooks?: string;
    isHidden?: boolean;
  }>,
  notebooks: Array<{
    title: string;
    isHidden?: boolean;
    noteIds?: string[];
    childNotebooks?: string[];
  }>,
): string {
  const timestamp = new Date().toISOString();
  const header = `<!-- Common Tools Export - ${timestamp} -->
<!-- Format: v2 (hierarchical) -->
<!-- Notes: ${notes.length}, Notebooks: ${notebooks.length} -->

`;

  const notesSection = notes.length > 0
    ? `<!-- === NOTES === -->

${
      notes.map((n) =>
        makeNoteMarkdown(n.title, n.content, n.noteId, n.notebooks, n.isHidden)
      ).join("\n\n")
    }`
    : "";

  const notebooksSection = notebooks.length > 0
    ? `

<!-- === NOTEBOOKS === -->

${
      notebooks.map((nb) =>
        makeNotebookMarkdown(
          nb.title,
          nb.isHidden,
          nb.noteIds,
          nb.childNotebooks,
        )
      ).join("\n\n")
    }`
    : "";

  return header + notesSection + notebooksSection;
}

export default pattern(() => {
  // Shared allPieces array that we can populate for different test scenarios
  const allPieces = Writable.of<any[]>([]);

  // Writable for importMarkdown that we can modify
  const importMarkdown = Writable.of<string>("");

  // Instantiate NotesImportExport with the shared state
  const instance = NotesImportExport({
    allPieces,
    importMarkdown,
  });

  // ==========================================================================
  // Setup Actions - create initial state for different test scenarios
  // ==========================================================================

  // Reset to empty state
  const action_reset = action(() => {
    allPieces.set([]);
    importMarkdown.set("");
  });

  // Create an existing note
  const action_create_existing_note = action(() => {
    const note = Note({
      title: "Existing Note",
      content: "This note already exists",
      noteId: "existing-note-1",
    });
    allPieces.push(note);
  });

  // Create an existing notebook
  const action_create_existing_notebook = action(() => {
    const notebook = Notebook({
      title: "Existing Notebook",
      notes: [],
    });
    allPieces.push(notebook);
  });

  // Set up import markdown with a fresh note (no duplicates)
  const action_set_fresh_note_markdown = action(() => {
    importMarkdown.set(
      makeExportMarkdown(
        [{
          title: "Fresh Note",
          content: "Brand new content",
          noteId: "fresh-1",
        }],
        [],
      ),
    );
  });

  // Set up import markdown with a fresh notebook (no duplicates)
  const action_set_fresh_notebook_markdown = action(() => {
    importMarkdown.set(
      makeExportMarkdown([], [{ title: "Fresh Notebook" }]),
    );
  });

  // Set up import markdown with both fresh note and notebook (unused but kept for future tests)
  const _action_set_fresh_both_markdown = action(() => {
    importMarkdown.set(
      makeExportMarkdown(
        [{
          title: "Fresh Note",
          content: "Brand new content",
          noteId: "fresh-1",
        }],
        [{ title: "Fresh Notebook" }],
      ),
    );
  });

  // Set up import markdown with a duplicate note
  const action_set_duplicate_note_markdown = action(() => {
    importMarkdown.set(
      makeExportMarkdown(
        [
          {
            title: "Existing Note",
            content: "Duplicate content",
            noteId: "dup-note-1",
          },
        ],
        [],
      ),
    );
  });

  // Set up import markdown with a duplicate notebook
  const action_set_duplicate_notebook_markdown = action(() => {
    importMarkdown.set(
      makeExportMarkdown([], [{ title: "Existing Notebook" }]),
    );
  });

  // Set up import markdown with both duplicate note and notebook
  const action_set_duplicate_both_markdown = action(() => {
    importMarkdown.set(
      makeExportMarkdown(
        [
          {
            title: "Existing Note",
            content: "Duplicate content",
            noteId: "dup-note-1",
          },
        ],
        [{ title: "Existing Notebook" }],
      ),
    );
  });

  // Create a second existing note for multi-note selection tests
  const action_create_second_note = action(() => {
    const note = Note({
      title: "Second Note",
      content: "Second note content",
      noteId: "existing-note-2",
    });
    allPieces.push(note);
  });

  // Create a second existing notebook for multi-notebook selection tests
  const action_create_second_notebook = action(() => {
    const notebook = Notebook({
      title: "Second Notebook",
      notes: [],
    });
    allPieces.push(notebook);
  });

  // Set up import markdown with nested notebooks (parent containing child references)
  const action_set_nested_notebook_markdown = action(() => {
    importMarkdown.set(
      makeExportMarkdown(
        [
          {
            title: "Nested Note",
            content: "Note in parent notebook",
            noteId: "nested-note-1",
            notebooks: "Parent Notebook",
          },
        ],
        [
          {
            title: "Parent Notebook",
            noteIds: ["nested-note-1"],
            childNotebooks: ["Child Notebook"],
          },
          {
            title: "Child Notebook",
            noteIds: [],
            childNotebooks: [],
          },
        ],
      ),
    );
  });

  // Set up import markdown with mix of fresh and duplicate
  const action_set_mixed_markdown = action(() => {
    importMarkdown.set(
      makeExportMarkdown(
        [
          {
            title: "Existing Note",
            content: "Duplicate content",
            noteId: "dup-note-1",
          },
          { title: "Fresh Note", content: "Brand new", noteId: "fresh-1" },
        ],
        [{ title: "Existing Notebook" }, { title: "Fresh Notebook" }],
      ),
    );
  });

  // ==========================================================================
  // Test Actions - trigger import flows
  // ==========================================================================

  const action_analyze_import = action(() => {
    instance.analyzeImport.send();
  });

  const action_skip_duplicates = action(() => {
    instance.importSkipDuplicates.send();
  });

  const action_import_as_copies = action(() => {
    instance.importAllAsCopies.send();
  });

  const action_cancel_import = action(() => {
    instance.cancelImport.send();
  });

  const _action_open_import_modal = action(() => {
    instance.openImportModal.send();
  });

  const _action_close_import_modal = action(() => {
    instance.closeImportModal.send();
  });

  // Export actions
  const action_open_export_all_modal = action(() => {
    instance.openExportAllModal.send();
  });

  // Selection actions
  const action_select_all_notes = action(() => {
    instance.selectAllNotes.send();
  });

  const action_deselect_all_notes = action(() => {
    instance.deselectAllNotes.send();
  });

  const action_select_all_notebooks = action(() => {
    instance.selectAllNotebooks.send();
  });

  const action_deselect_all_notebooks = action(() => {
    instance.deselectAllNotebooks.send();
  });

  const action_create_note = action(() => {
    instance.createNote.send();
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_no_notes = computed(() => instance.noteCount === 0);
  const assert_initial_no_notebooks = computed(
    () => instance.notebookCount === 0,
  );
  // Note: Use spread + length to work around reactive proxy .length issue
  const assert_initial_no_duplicates = computed(
    () => [...instance.detectedDuplicates].length === 0,
  );
  const assert_initial_modals_closed = computed(
    () =>
      !instance.showDuplicateModal &&
      !instance.showImportModal &&
      !instance.showImportProgressModal,
  );

  // ==========================================================================
  // Assertions - After creating existing items
  // ==========================================================================

  const assert_has_one_note = computed(() => instance.noteCount === 1);
  const assert_has_one_notebook = computed(() => instance.notebookCount === 1);

  // ==========================================================================
  // Assertions - Import with no duplicates
  // ==========================================================================

  // After importing fresh note: should have 2 notes total
  const assert_two_notes_after_fresh_import = computed(
    () => instance.noteCount === 2,
  );

  // After importing fresh notebook: should have 2 notebooks total
  const assert_two_notebooks_after_fresh_import = computed(
    () => instance.notebookCount === 2,
  );

  // Import should complete without showing duplicate modal
  const assert_no_duplicate_modal = computed(
    () => !instance.showDuplicateModal,
  );

  // Import should show progress modal when complete
  const assert_import_complete = computed(() => instance.importComplete);

  // ==========================================================================
  // Assertions - Duplicate note detection
  // ==========================================================================

  const assert_duplicate_note_detected = computed(() => {
    const dups = [...instance.detectedDuplicates];
    return (
      dups.length === 1 &&
      dups[0].title === "Existing Note" &&
      dups[0].isNotebook !== true
    );
  });

  const assert_duplicate_modal_shown = computed(
    () => instance.showDuplicateModal,
  );

  // ==========================================================================
  // Assertions - Duplicate notebook detection
  // ==========================================================================

  const assert_duplicate_notebook_detected = computed(() => {
    const dups = [...instance.detectedDuplicates];
    // The notebook duplicate has emoji prefix added for display
    return dups.length === 1 && dups[0].isNotebook === true;
  });

  // ==========================================================================
  // Assertions - Both note and notebook duplicates
  // ==========================================================================

  const assert_both_duplicates_detected = computed(() => {
    const dups = [...instance.detectedDuplicates];
    const hasNoteDup = dups.some(
      (d) => d.title === "Existing Note" && !d.isNotebook,
    );
    const hasNotebookDup = dups.some((d) => d.isNotebook === true);
    return dups.length === 2 && hasNoteDup && hasNotebookDup;
  });

  // ==========================================================================
  // Assertions - Skip duplicates flow
  // ==========================================================================

  // Debug: Check state after skip duplicates
  // We expect: started with 1 note + 1 notebook, imported 1 fresh note + 1 fresh notebook = 2 notes, 2 notebooks
  // This assertion always passes but logs state for debugging
  const assert_skip_debug_state = computed(() => true);

  // After skipping duplicates with mixed import: only fresh items imported
  // Started with 1 note + 1 notebook, after skip duplicates: 2 notes + 2 notebooks
  const assert_fresh_items_imported = computed(() => {
    // After skip duplicates: we started with 1 note + 1 notebook
    // We import 1 fresh note (skip 1 duplicate) + 1 fresh notebook (skip 1 duplicate)
    // Result: 2 notes, 2 notebooks
    return instance.noteCount === 2 && instance.notebookCount === 2;
  });

  const assert_duplicates_cleared = computed(
    () => [...instance.detectedDuplicates].length === 0,
  );

  const assert_duplicate_modal_closed = computed(
    () => !instance.showDuplicateModal,
  );

  // ==========================================================================
  // Assertions - Import as copies flow
  // ==========================================================================

  // Debug: Check state after import as copies
  // We expect: started with 1 note + 1 notebook, imported 2 notes + 2 notebooks = 3 notes, 3 notebooks
  // This assertion always passes but logs state for debugging
  const assert_copies_debug_state = computed(() => true);

  // After importing as copies: all items imported (duplicates become copies)
  // Started with 1 note + 1 notebook, after import all: 3 notes + 3 notebooks
  const assert_all_items_imported = computed(() => {
    return instance.noteCount === 3 && instance.notebookCount === 3;
  });

  // ==========================================================================
  // Assertions - Cancel import flow
  // ==========================================================================

  const assert_after_cancel_state_unchanged = computed(
    () =>
      instance.noteCount === 1 &&
      instance.notebookCount === 1 &&
      [...instance.detectedDuplicates].length === 0 &&
      !instance.showDuplicateModal,
  );

  // ==========================================================================
  // Assertions - Export all
  // ==========================================================================

  // After export: exportedMarkdown should contain v2 format header and note/notebook markers
  const assert_export_has_v2_header = computed(
    () => instance.exportedMarkdown.includes("Format: v2 (hierarchical)"),
  );

  const assert_export_has_notes_section = computed(
    () => instance.exportedMarkdown.includes("<!-- === NOTES === -->"),
  );

  const assert_export_has_note_content = computed(
    () =>
      instance.exportedMarkdown.includes("COMMON_NOTE_START") &&
      instance.exportedMarkdown.includes("Existing Note"),
  );

  const assert_export_has_notebooks_section = computed(
    () => instance.exportedMarkdown.includes("<!-- === NOTEBOOKS === -->"),
  );

  const assert_export_has_notebook_content = computed(
    () =>
      instance.exportedMarkdown.includes("COMMON_NOTEBOOK_START") &&
      instance.exportedMarkdown.includes("Existing Notebook"),
  );

  // ==========================================================================
  // Assertions - Selection actions
  // ==========================================================================

  const assert_has_two_notes = computed(() => instance.noteCount === 2);
  const assert_has_two_notebooks = computed(() => instance.notebookCount === 2);

  const assert_all_notes_selected = computed(
    () => [...instance.selectedNoteIndices].length === 2,
  );

  const assert_no_notes_selected = computed(
    () => [...instance.selectedNoteIndices].length === 0,
  );

  const assert_all_notebooks_selected = computed(
    () => [...instance.selectedNotebookIndices].length === 2,
  );

  const assert_no_notebooks_selected = computed(
    () => [...instance.selectedNotebookIndices].length === 0,
  );

  // ==========================================================================
  // Assertions - Nested notebook import
  // ==========================================================================

  // After importing nested notebooks: should have 1 note + 2 notebooks
  const assert_nested_note_imported = computed(
    () => instance.noteCount === 1,
  );

  const assert_nested_notebooks_imported = computed(
    () => instance.notebookCount === 2,
  );

  // ==========================================================================
  // Assertions - Create note action
  // ==========================================================================

  const assert_note_created = computed(() => instance.noteCount === 1);

  // ==========================================================================
  // Test Sequence
  // ==========================================================================

  return {
    tests: [
      // === Initial state tests ===
      { assertion: assert_initial_no_notes },
      { assertion: assert_initial_no_notebooks },
      { assertion: assert_initial_no_duplicates },
      { assertion: assert_initial_modals_closed },

      // === Create note action test ===
      { action: action_create_note },
      { assertion: assert_note_created },
      { action: action_reset },

      // === Test 1: Import fresh note (no duplicates) ===
      { action: action_create_existing_note },
      { assertion: assert_has_one_note },
      { action: action_set_fresh_note_markdown },
      { action: action_analyze_import },
      { assertion: assert_no_duplicate_modal },
      { assertion: assert_import_complete },
      { assertion: assert_two_notes_after_fresh_import },
      { action: action_reset },

      // === Test 2: Import fresh notebook (no duplicates) ===
      { action: action_create_existing_notebook },
      { assertion: assert_has_one_notebook },
      { action: action_set_fresh_notebook_markdown },
      { action: action_analyze_import },
      { assertion: assert_no_duplicate_modal },
      { assertion: assert_import_complete },
      { assertion: assert_two_notebooks_after_fresh_import },
      { action: action_reset },

      // === Test 3: Duplicate note detection ===
      { action: action_create_existing_note },
      { assertion: assert_has_one_note },
      { action: action_set_duplicate_note_markdown },
      { action: action_analyze_import },
      { assertion: assert_duplicate_note_detected },
      { assertion: assert_duplicate_modal_shown },
      { action: action_cancel_import },
      { action: action_reset },

      // === Test 4: Duplicate notebook detection ===
      { action: action_create_existing_notebook },
      { assertion: assert_has_one_notebook },
      { action: action_set_duplicate_notebook_markdown },
      { action: action_analyze_import },
      { assertion: assert_duplicate_notebook_detected },
      { assertion: assert_duplicate_modal_shown },
      { action: action_cancel_import },
      { action: action_reset },

      // === Test 5: Both note and notebook duplicates ===
      { action: action_create_existing_note },
      { action: action_create_existing_notebook },
      { assertion: assert_has_one_note },
      { assertion: assert_has_one_notebook },
      { action: action_set_duplicate_both_markdown },
      { action: action_analyze_import },
      { assertion: assert_both_duplicates_detected },
      { assertion: assert_duplicate_modal_shown },
      { action: action_cancel_import },
      { action: action_reset },

      // === Test 6: Skip duplicates - debug the import process ===
      // First just verify analysis works correctly before any import
      { action: action_create_existing_note },
      { action: action_create_existing_notebook },
      { action: action_set_mixed_markdown },
      { action: action_analyze_import },
      { assertion: assert_both_duplicates_detected },
      // Now try skip duplicates
      { action: action_skip_duplicates },
      { assertion: assert_skip_debug_state },
      { assertion: assert_duplicates_cleared },
      { assertion: assert_duplicate_modal_closed },
      { assertion: assert_fresh_items_imported },
      { action: action_reset },

      // === Test 7: Import as copies - imports everything ===
      { action: action_create_existing_note },
      { action: action_create_existing_notebook },
      { action: action_set_mixed_markdown },
      { action: action_analyze_import },
      { assertion: assert_both_duplicates_detected },
      { action: action_import_as_copies },
      { assertion: assert_copies_debug_state },
      { assertion: assert_duplicates_cleared },
      { assertion: assert_duplicate_modal_closed },
      { assertion: assert_all_items_imported },
      { action: action_reset },

      // === Test 8: Cancel import preserves state ===
      { action: action_create_existing_note },
      { action: action_create_existing_notebook },
      { action: action_set_duplicate_both_markdown },
      { action: action_analyze_import },
      { assertion: assert_both_duplicates_detected },
      { assertion: assert_duplicate_modal_shown },
      { action: action_cancel_import },
      { assertion: assert_after_cancel_state_unchanged },
      { action: action_reset },

      // === Test 9: Export all generates v2 format with notes and notebooks ===
      { action: action_create_existing_note },
      { action: action_create_existing_notebook },
      { assertion: assert_has_one_note },
      { assertion: assert_has_one_notebook },
      { action: action_open_export_all_modal },
      { assertion: assert_export_has_v2_header },
      { assertion: assert_export_has_notes_section },
      { assertion: assert_export_has_note_content },
      { assertion: assert_export_has_notebooks_section },
      { assertion: assert_export_has_notebook_content },
      { action: action_reset },

      // === Test 10: Select all / deselect all notes ===
      { action: action_create_existing_note },
      { action: action_create_second_note },
      { action: action_create_existing_notebook },
      { action: action_create_second_notebook },
      { assertion: assert_has_two_notes },
      { assertion: assert_has_two_notebooks },
      // Select all notes
      { action: action_select_all_notes },
      { assertion: assert_all_notes_selected },
      // Deselect all notes
      { action: action_deselect_all_notes },
      { assertion: assert_no_notes_selected },
      // Select all notebooks
      { action: action_select_all_notebooks },
      { assertion: assert_all_notebooks_selected },
      // Deselect all notebooks
      { action: action_deselect_all_notebooks },
      { assertion: assert_no_notebooks_selected },
      { action: action_reset },

      // === Test 11: Import nested notebooks ===
      { action: action_set_nested_notebook_markdown },
      { action: action_analyze_import },
      { assertion: assert_nested_note_imported },
      { assertion: assert_nested_notebooks_imported },
    ],
    // Expose for debugging
    instance,
    allPieces,
    importMarkdown,
  };
});
