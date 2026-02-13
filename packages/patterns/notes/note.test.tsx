/// <cts-enable />
/**
 * Test Pattern: Note
 *
 * Tests for the note pattern:
 * - Initial state with provided values
 * - Edit content via editContent stream
 * - NAME computed from title
 * - Menu toggle behavior
 * - Title editing behavior
 *
 * Run: deno task ct test packages/patterns/notes/note.test.tsx --verbose
 */
import { action, computed, NAME, pattern } from "commontools";
import Note from "./note.tsx";
import Notebook from "./notebook.tsx";

export default pattern(() => {
  const note = Note({
    title: "Test Note",
    content: "Line one\nLine two\nLine three",
    noteId: "test-note-123",
    isHidden: false,
  });

  // Create notebooks for parentNotebook testing
  const notebookA = Notebook({
    title: "Notebook A",
    notes: [],
  });

  const notebookB = Notebook({
    title: "Notebook B",
    notes: [],
  });

  // Note created with a parent notebook
  const noteWithParent = Note({
    title: "Child Note",
    content: "I belong to a notebook",
    noteId: "child-note-1",
    isHidden: true,
    parentNotebook: notebookA,
  });

  // Note created with a different parent notebook
  const noteInNotebookB = Note({
    title: "Note in B",
    content: "I belong to notebook B",
    noteId: "child-note-2",
    isHidden: true,
    parentNotebook: notebookB,
  });

  // Note explicitly created with no parent (same as `note` above but explicit)
  const noteNoParent = Note({
    title: "Orphan Note",
    content: "I have no notebook",
    noteId: "orphan-note-1",
    isHidden: false,
  });

  // ==========================================================================
  // Actions - Content Editing
  // ==========================================================================

  const action_edit_content = action(() => {
    note.editContent.send({ detail: { value: "Updated content here" } });
  });

  const action_edit_content_multiline = action(() => {
    note.editContent.send({
      detail: { value: "First line\nSecond line\nThird line" },
    });
  });

  const action_clear_content = action(() => {
    note.editContent.send({ detail: { value: "" } });
  });

  // ==========================================================================
  // Actions - Menu Toggle
  // ==========================================================================

  const action_toggle_menu = action(() => {
    note.toggleMenu.send();
  });

  const action_toggle_menu_again = action(() => {
    note.toggleMenu.send();
  });

  const action_toggle_menu_for_close = action(() => {
    note.toggleMenu.send();
  });

  const action_close_menu = action(() => {
    note.closeMenu.send();
  });

  // ==========================================================================
  // Actions - Title Editing
  // ==========================================================================

  const action_start_editing = action(() => {
    note.startEditingTitle.send();
  });

  const action_stop_editing = action(() => {
    note.stopEditingTitle.send();
  });

  // ==========================================================================
  // Actions - Create New Note (wish + SELF machinery)
  // ==========================================================================

  const action_create_new_note = action(() => {
    note.createNewNote.send();
  });

  const action_create_from_parented = action(() => {
    noteWithParent.createNewNote.send();
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_name = computed(
    () => note[NAME] === "📝 Test Note",
  );
  const assert_initial_title = computed(() => note.title === "Test Note");
  const assert_initial_content = computed(
    () => note.content === "Line one\nLine two\nLine three",
  );
  const assert_initial_note_id = computed(
    () => note.noteId === "test-note-123",
  );
  const assert_initial_not_hidden = computed(() => note.isHidden === false);
  const assert_initial_no_parent = computed(
    () => !note.parentNotebook,
  );
  const assert_initial_empty_backlinks = computed(
    () => note.backlinks.length === 0,
  );
  const assert_initial_empty_mentioned = computed(
    () => note.mentioned.length === 0,
  );

  // ==========================================================================
  // Assertions - Parent Notebook
  // ==========================================================================

  // Note created with parent A should have it set
  const assert_has_parent = computed(
    () => !!noteWithParent.parentNotebook,
  );

  const assert_parent_is_notebook_a = computed(
    () => noteWithParent.parentNotebook?.title === "Notebook A",
  );

  // Note created with parent B should point to B
  const assert_note_b_has_parent = computed(
    () => !!noteInNotebookB.parentNotebook,
  );

  const assert_parent_is_notebook_b = computed(
    () => noteInNotebookB.parentNotebook?.title === "Notebook B",
  );

  // Different notes have different parents
  const assert_different_parents = computed(
    () =>
      noteWithParent.parentNotebook?.title !== noteInNotebookB.parentNotebook
        ?.title,
  );

  // Note created without parent should have no parent
  const assert_orphan_no_parent = computed(
    () => !noteNoParent.parentNotebook,
  );

  // Child notes should be hidden (set at creation)
  const assert_child_a_hidden = computed(
    () => noteWithParent.isHidden === true,
  );

  const assert_child_b_hidden = computed(
    () => noteInNotebookB.isHidden === true,
  );

  // Orphan note should not be hidden
  const assert_orphan_not_hidden = computed(
    () => noteNoParent.isHidden === false,
  );

  // ==========================================================================
  // Assertions - After Content Edit
  // ==========================================================================

  const assert_content_updated = computed(
    () => note.content === "Updated content here",
  );
  const assert_content_multiline = computed(
    () => note.content === "First line\nSecond line\nThird line",
  );
  const assert_content_cleared = computed(() => note.content === "");

  // ==========================================================================
  // Assertions - Menu Toggle
  // ==========================================================================

  const assert_initial_menu_closed = computed(
    () => note.menuOpen === false,
  );

  const assert_menu_open = computed(
    () => note.menuOpen === true,
  );

  const assert_menu_closed_after_toggle = computed(
    () => note.menuOpen === false,
  );

  const assert_menu_closed_via_close = computed(
    () => note.menuOpen === false,
  );

  // ==========================================================================
  // Assertions - Title Editing
  // ==========================================================================

  const assert_initial_not_editing = computed(
    () => note.isEditingTitle === false,
  );

  const assert_editing_title = computed(
    () => note.isEditingTitle === true,
  );

  const assert_stopped_editing = computed(
    () => note.isEditingTitle === false,
  );

  // ==========================================================================
  // Assertions - Create New Note (wish + SELF machinery)
  // ==========================================================================

  // After creating new note, original note should be unchanged
  const assert_note_unchanged_after_create = computed(
    () => note.title === "Test Note" && note.noteId === "test-note-123",
  );

  // After creating new note from parented note, original should be unchanged
  const assert_parented_note_unchanged = computed(
    () =>
      noteWithParent.title === "Child Note" &&
      noteWithParent.noteId === "child-note-1",
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Initial state ===
      { assertion: assert_name },
      { assertion: assert_initial_title },
      { assertion: assert_initial_content },
      { assertion: assert_initial_note_id },
      { assertion: assert_initial_not_hidden },
      { assertion: assert_initial_no_parent },
      { assertion: assert_initial_empty_backlinks },
      { assertion: assert_initial_empty_mentioned },

      // === Parent notebook - note in notebook A ===
      { assertion: assert_has_parent },
      { assertion: assert_parent_is_notebook_a },
      { assertion: assert_child_a_hidden },

      // === Parent notebook - note in notebook B ===
      { assertion: assert_note_b_has_parent },
      { assertion: assert_parent_is_notebook_b },
      { assertion: assert_child_b_hidden },

      // === Different parents are distinct ===
      { assertion: assert_different_parents },

      // === Orphan note has no parent ===
      { assertion: assert_orphan_no_parent },
      { assertion: assert_orphan_not_hidden },

      // === Edit content ===
      { action: action_edit_content },
      { assertion: assert_content_updated },

      { action: action_edit_content_multiline },
      { assertion: assert_content_multiline },

      { action: action_clear_content },
      { assertion: assert_content_cleared },

      // === Menu toggle behavior ===
      { assertion: assert_initial_menu_closed },
      { action: action_toggle_menu },
      { assertion: assert_menu_open },
      { action: action_toggle_menu_again },
      { assertion: assert_menu_closed_after_toggle },
      { action: action_toggle_menu_for_close },
      { action: action_close_menu },
      { assertion: assert_menu_closed_via_close },

      // === Title editing behavior ===
      { assertion: assert_initial_not_editing },
      { action: action_start_editing },
      { assertion: assert_editing_title },
      { action: action_stop_editing },
      { assertion: assert_stopped_editing },

      // === Create new note (wish + SELF machinery) ===
      { action: action_create_new_note },
      { assertion: assert_note_unchanged_after_create },
      { action: action_create_from_parented },
      { assertion: assert_parented_note_unchanged },
    ],
    note,
    noteWithParent,
    noteInNotebookB,
    noteNoParent,
  };
});
