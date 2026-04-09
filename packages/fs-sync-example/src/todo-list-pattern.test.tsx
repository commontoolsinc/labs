/**
 * Test Pattern: Todo List (fs-sync)
 *
 * Tests the handler logic:
 * - Initial state (empty todos, no edits)
 * - Creating todos (via create stream with description payload)
 * - Toggling todos via actions[i].toggle
 * - Toggling back (restores done=false)
 * - Deleting todos via actions[i].delete
 * - Deleting remaining todo
 *
 * Per-item handlers are accessed via `list.actions[i].toggle` / `.delete`
 * which are handler streams wrapped in objects (safe from spurious invocation).
 *
 * Run: deno task cf test packages/fs-sync-example/src/todo-list-pattern.test.tsx --verbose
 */
import { action, computed, pattern } from "commonfabric";
import TodoList from "./todo-list-pattern.tsx";

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

  // Create first todo via event payload
  const action_create_first = action(() => {
    list.create.send({ detail: { message: "Buy groceries" } });
  });

  // Create second todo
  const action_create_second = action(() => {
    list.create.send({ detail: { message: "Write docs" } });
  });

  // Toggle first todo (mark done)
  const action_toggle_first = action(() => {
    list.actions[0].toggle.send({});
  });

  // Toggle first todo again (mark not done)
  const action_toggle_first_back = action(() => {
    list.actions[0].toggle.send({});
  });

  // Delete second todo
  const action_delete_second = action(() => {
    list.actions[1].delete.send({});
  });

  // Delete remaining (first) todo
  const action_delete_first = action(() => {
    list.actions[0].delete.send({});
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
  const assert_first_not_done = computed(() => list.todos[0]?.done === false);
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

  // After toggle first (done=true)
  const assert_first_done = computed(() => list.todos[0]?.done === true);
  const assert_three_edits = computed(() => list.edits.length === 3);
  const assert_toggle_edit = computed(() => list.edits[2]?.type === "toggle");

  // After toggle first back (done=false)
  const assert_first_not_done_again = computed(() =>
    list.todos[0]?.done === false
  );
  const assert_four_edits = computed(() => list.edits.length === 4);

  // After delete second
  const assert_back_to_one = computed(() => list.todos.length === 1);
  const assert_remaining_is_first = computed(() =>
    list.todos[0]?.description === "Buy groceries"
  );
  const assert_five_edits = computed(() => list.edits.length === 5);
  const assert_delete_edit = computed(() => list.edits[4]?.type === "delete");

  // After delete remaining
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

      // Toggle first todo (mark done)
      { action: action_toggle_first },
      { assertion: assert_first_done },
      { assertion: assert_three_edits },
      { assertion: assert_toggle_edit },

      // Toggle first todo back (mark not done)
      { action: action_toggle_first_back },
      { assertion: assert_first_not_done_again },
      { assertion: assert_four_edits },

      // Delete second todo
      { action: action_delete_second },
      { assertion: assert_back_to_one },
      { assertion: assert_remaining_is_first },
      { assertion: assert_five_edits },
      { assertion: assert_delete_edit },

      // Delete remaining todo
      { action: action_delete_first },
      { assertion: assert_empty_again },
      { assertion: assert_six_edits },
    ],
    list,
  };
});
