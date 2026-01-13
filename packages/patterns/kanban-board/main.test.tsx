/// <cts-enable />
/**
 * MINIMAL REPRO: Cross-Pattern .send() Issue
 *
 * This test demonstrates the cross-pattern .send() issue where a test pattern
 * instantiates KanbanBoard and tries to call .send() on the board's exported
 * Stream handlers.
 *
 * EXPECTED: board.addCard.send({ ... }) adds a card to the kanban board
 * ACTUAL: Fails - Streams lose their .send() method when accessed cross-pattern
 *
 * ============================================================================
 * ERROR: "stream.send is not a function" / "board.addCard.send is not a function"
 * ============================================================================
 *
 * Both approaches fail with the same error:
 *
 * APPROACH 1: Passing Stream as handler state parameter
 *   handler<void, { stream: typeof board.addCard }>((_event, { stream }) => {
 *     stream.send({ ... });  // TypeError: stream.send is not a function
 *   })({ stream: board.addCard });
 *
 * APPROACH 2: Accessing Stream via closure (using action())
 *   action(() => {
 *     board.addCard.send({ ... });  // TypeError: board.addCard.send is not a function
 *   });
 *
 * What the Stream actually is at runtime (verified via debugging):
 *   {
 *     "typeofStream": "object",
 *     "streamValue": "[object Object]",
 *     "streamKeys": [],           // <-- EMPTY! No properties at all
 *     "hasSend": false,
 *     "constructorName": "Object" // <-- Plain object, not Stream/Cell
 *   }
 *
 * ROOT CAUSE: When a Stream is accessed from a nested pattern's return value,
 * it gets dereferenced/serialized to an empty `{}` object. The Stream's
 * methods (.send()) and internal state are completely lost.
 *
 * ============================================================================
 * RUN THIS TEST
 * ============================================================================
 * deno task ct test packages/patterns/kanban-board/main.test.tsx --verbose
 */
import { action, Cell, computed, handler, pattern, Stream } from "commontools";
import KanbanBoard, { type Column } from "./main.tsx";

// Handler moved to module scope with explicit type parameters
// This is the correct pattern for handlers that need to be used in tests
const action_via_state_handler = handler<
  void,
  { stream: Stream<{ columnId: string; title: string; description?: string }> }
>((_event, { stream }) => {
  stream.send({
    columnId: "todo",
    title: "Test Card (via state)",
    description: "Stream passed as handler state parameter",
  });
});

export default pattern(() => {
  // Initialize columns Cell
  const columnsCell = Cell.of<Column[]>([
    { id: "todo", title: "To Do", cards: [] },
    { id: "in-progress", title: "In Progress", cards: [] },
    { id: "done", title: "Done", cards: [] },
  ]);

  // Instantiate the kanban board pattern
  const board = KanbanBoard({ columns: columnsCell });

  // ============ APPROACH 1: Pass Stream as handler state ============
  // Expected: stream.send() adds a card
  // Actual: TypeError: stream.send is not a function
  // Reason: stream becomes {} (empty object) when passed through handler state
  // NOTE: Handler moved to module scope with explicit type parameters
  const action_via_state = action_via_state_handler({ stream: board.addCard });

  // ============ APPROACH 2: Access Stream via closure (using action) ============
  // Expected: board.addCard.send() adds a card
  // Actual: Error: Transaction required for .set()
  // Reason: Stream's Cell has no tx context from definition time
  // Note: action() closes over all data, no binding step needed
  const action_via_closure = action(() => {
    board.addCard.send({
      columnId: "todo",
      title: "Test Card (via closure)",
      description: "Stream accessed via closure",
    });
  });

  // ============ ASSERTIONS ============
  const assert_initial_zero_cards = computed(() => board.totalCards === 0);
  const assert_one_card = computed(() => board.totalCards === 1);
  const assert_two_cards = computed(() => board.totalCards === 2);

  // ============ TEST SEQUENCE ============
  return {
    tests: [
      { assertion: assert_initial_zero_cards },
      { action: action_via_closure },
      { assertion: assert_one_card },
      { action: action_via_state },
      { assertion: assert_two_cards },
    ],
    board,
    columnsCell,
  };
});
