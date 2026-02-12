/// <cts-enable />
/**
 * Test Pattern: Notebook
 *
 * Tests for the notebook pattern:
 * - Initial state with provided values
 * - noteCount computed from notes array
 * - setTitle stream for renaming
 * - createNote stream for adding notes
 * - createNotes stream for bulk adding
 *
 * The test harness sets up defaultPattern so wish("#default") resolves,
 * enabling tests for handlers that push to allPieces.
 *
 * Run: deno task ct test packages/patterns/notes/notebook.test.tsx --verbose
 */
import { action, computed, pattern } from "commontools";
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

  // ==========================================================================
  // Actions
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

  // KNOWN BUG: Multi-push times out at default 5s.
  // Run with --timeout 30000 to see it pass + timing data.
  const action_create_multiple_notes = action(() => {
    notebook.createNotes.send({
      notesData: [
        { title: "Bulk Note 1", content: "First bulk note" },
        { title: "Bulk Note 2", content: "Second bulk note" },
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

  // After createNotes with 2 notes, should have 5 total
  const assert_note_count_after_bulk = computed(() => notebook.noteCount === 5);

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
      // === Bulk create notes (times out at 5s, needs --timeout 30000) ===
      { action: action_create_multiple_notes },
      { assertion: assert_note_count_after_bulk },
    ],
    notebook,
    emptyNotebook,
  };
});
