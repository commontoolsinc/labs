/// <cts-enable />
/**
 * Test Pattern: Todo List (fs-sync)
 *
 * Tests the handler logic:
 * - Initial state (empty todos, no edits)
 * - Creating todos (optimistic add + edit enqueued)
 * - Toggling a todo (optimistic done flip + edit enqueued)
 * - Deleting a todo (optimistic remove + edit enqueued)
 *
 * Run: deno task ct test packages/fs-sync-example/src/pattern.test.tsx --verbose
 */
import { action, computed, pattern, type Stream } from "commontools";
import TodoList from "./pattern.tsx";

// Helper: the reactive .map() erases handler types to unknown.
// At runtime they are Streams, so we cast for .send() access.
function asStream(ref: unknown): Stream<void> {
  return ref as Stream<void>;
}

export default pattern(() => {
  const list = TodoList({
    todos: [],
    edits: [],
    appliedEdits: [],
    failedEdits: [],
  });

  // ========================================================================
  // Actions
  // ========================================================================

  const action_create_first = action(() => {
    list.create.send({ detail: { message: "Buy groceries" } });
  });

  const action_create_second = action(() => {
    list.create.send({ detail: { message: "Write docs" } });
  });

  const action_toggle_first = action(() => {
    asStream(list.toggles[0]).send();
  });

  const action_toggle_first_again = action(() => {
    asStream(list.toggles[0]).send();
  });

  const action_delete_second = action(() => {
    asStream(list.deletes[1]).send();
  });

  const action_delete_remaining = action(() => {
    asStream(list.deletes[0]).send();
  });

  // ========================================================================
  // Assertions
  // ========================================================================

  // Initial state
  const assert_starts_empty = computed(() => list.todos.length === 0);
  const assert_no_edits = computed(() => list.edits.length === 0);

  // After first create
  const assert_one_todo = computed(() => list.todos.length === 1);
  const assert_first_description = computed(() =>
    list.todos[0]?.description === "Buy groceries"
  );
  const assert_first_not_done = computed(() =>
    list.todos[0]?.done === false
  );
  const assert_one_edit = computed(() => list.edits.length === 1);
  const assert_edit_is_create = computed(() =>
    list.edits[0]?.type === "create"
  );

  // After second create
  const assert_two_todos = computed(() => list.todos.length === 2);
  const assert_second_description = computed(() =>
    list.todos[1]?.description === "Write docs"
  );
  const assert_two_edits = computed(() => list.edits.length === 2);

  // After toggling first
  const assert_first_done = computed(() => list.todos[0]?.done === true);
  const assert_three_edits = computed(() => list.edits.length === 3);
  const assert_toggle_edit = computed(() =>
    list.edits[2]?.type === "toggle"
  );

  // After toggling first again (back to not done)
  const assert_first_undone = computed(() => list.todos[0]?.done === false);
  const assert_four_edits = computed(() => list.edits.length === 4);

  // After deleting second
  const assert_one_todo_left = computed(() => list.todos.length === 1);
  const assert_remaining_is_groceries = computed(() =>
    list.todos[0]?.description === "Buy groceries"
  );
  const assert_five_edits = computed(() => list.edits.length === 5);
  const assert_delete_edit = computed(() =>
    list.edits[4]?.type === "delete"
  );

  // After deleting remaining
  const assert_empty_again = computed(() => list.todos.length === 0);
  const assert_six_edits = computed(() => list.edits.length === 6);

  // ========================================================================
  // Test Sequence
  // ========================================================================

  return {
    tests: [
      // Initial state
      { assertion: assert_starts_empty },
      { assertion: assert_no_edits },

      // Create first todo
      { action: action_create_first },
      { assertion: assert_one_todo },
      { assertion: assert_first_description },
      { assertion: assert_first_not_done },
      { assertion: assert_one_edit },
      { assertion: assert_edit_is_create },

      // Create second todo
      { action: action_create_second },
      { assertion: assert_two_todos },
      { assertion: assert_second_description },
      { assertion: assert_two_edits },

      // Toggle first todo (done)
      { action: action_toggle_first },
      { assertion: assert_first_done },
      { assertion: assert_three_edits },
      { assertion: assert_toggle_edit },

      // Toggle first todo again (undone)
      { action: action_toggle_first_again },
      { assertion: assert_first_undone },
      { assertion: assert_four_edits },

      // Delete second todo
      { action: action_delete_second },
      { assertion: assert_one_todo_left },
      { assertion: assert_remaining_is_groceries },
      { assertion: assert_five_edits },
      { assertion: assert_delete_edit },

      // Delete remaining todo
      { action: action_delete_remaining },
      { assertion: assert_empty_again },
      { assertion: assert_six_edits },
    ],
    list,
  };
});
