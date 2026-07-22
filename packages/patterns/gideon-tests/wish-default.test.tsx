/**
 * Test: writable #pieceRegistry wishes in the pattern test harness
 *
 * Verifies that the test runner sets up a defaultPattern with pieceRegistry
 * so semantic wishes can read and write it.
 *
 * Run: deno task cf test packages/patterns/gideon-tests/wish-default.test.tsx --verbose
 */
import { action, computed, NAME, pattern, wish, Writable } from "commonfabric";

interface MinimalPiece {
  [NAME]?: string;
}

export default pattern(() => {
  const pieceRegistry = wish<Writable<MinimalPiece[]>>({
    query: "#pieceRegistry",
  }).result!;

  // Track state for assertions
  const initialLength = computed(() => pieceRegistry?.get?.()?.length ?? -1);

  // Register a piece.
  const action_push_piece = action(() => {
    pieceRegistry.push({ [NAME]: "Test Piece 1" } as any);
  });

  const action_push_another = action(() => {
    pieceRegistry.push({ [NAME]: "Test Piece 2" } as any);
  });

  // Assertions
  const assert_piece_registry_exists = computed(() => !!pieceRegistry);
  const assert_initial_empty = computed(() => initialLength === 0);
  const assert_after_push_one = computed(
    () => pieceRegistry?.get?.()?.length === 1,
  );
  const assert_after_push_two = computed(
    () => pieceRegistry?.get?.()?.length === 2,
  );

  return {
    tests: [
      // pieceRegistry should be defined (wish resolved successfully)
      { assertion: assert_piece_registry_exists },
      // pieceRegistry should start empty
      { assertion: assert_initial_empty },
      // Push a piece
      { action: action_push_piece },
      { assertion: assert_after_push_one },
      // Push another
      { action: action_push_another },
      { assertion: assert_after_push_two },
    ],
  };
});
