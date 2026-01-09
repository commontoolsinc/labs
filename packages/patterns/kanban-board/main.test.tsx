/// <cts-enable />
/**
 * Test Pattern: KanbanBoard Cross-Pattern Stream Invocation
 *
 * This test demonstrates calling .send() on Streams exported by a nested pattern.
 * It validates that cross-pattern Stream invocation works correctly.
 *
 * Two approaches are tested:
 * 1. Passing Stream as handler state parameter
 * 2. Accessing Stream via closure (using action())
 *
 * Run: deno task ct test packages/patterns/kanban-board/main.test.tsx --verbose
 */
import { action, Cell, computed, handler, pattern } from "commontools";
import KanbanBoard, { type Column } from "./main.tsx";

export default pattern(() => {
  // Initialize columns Cell
  const columnsCell = Cell.of<Column[]>([
    { id: "todo", title: "To Do", cards: [] },
    { id: "in-progress", title: "In Progress", cards: [] },
    { id: "done", title: "Done", cards: [] },
  ]);

  // Instantiate the kanban board pattern
  const board = KanbanBoard({ columns: columnsCell });

  // Approach 1: Pass Stream as handler state parameter
  const action_via_state = handler<void, { stream: typeof board.addCard }>(
    (_event, { stream }) => {
      stream.send({
        columnId: "todo",
        title: "Test Card (via state)",
        description: "Stream passed as handler state parameter",
      });
    },
  )({ stream: board.addCard });

  // Approach 2: Access Stream via closure (using action())
  const action_via_closure = action(() => {
    board.addCard.send({
      columnId: "todo",
      title: "Test Card (via closure)",
      description: "Stream accessed via closure",
    });
  });

  // Assertions
  const assert_initial_zero_cards = computed(() => board.totalCards === 0);
  const assert_one_card = computed(() => board.totalCards === 1);
  const assert_two_cards = computed(() => board.totalCards === 2);

  // Test sequence: verify both approaches work
  return {
    tests: [
      assert_initial_zero_cards,

      // Test action() closure approach
      action_via_closure,
      assert_one_card,

      // Test handler state approach
      action_via_state,
      assert_two_cards,
    ],
    board,
    columnsCell,
  };
});
