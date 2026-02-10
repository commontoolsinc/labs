/// <cts-enable />
/**
 * Test: wish("#default") in pattern test harness
 *
 * Verifies that the test runner sets up a defaultPattern with allPieces
 * so that patterns using wish({ query: "#default" }) can read/write allPieces.
 *
 * Run: deno task ct test packages/patterns/gideon-tests/wish-default.test.tsx --verbose
 */
import { action, computed, NAME, pattern, wish, Writable } from "commontools";

interface MinimalPiece {
  [NAME]?: string;
}

export default pattern(() => {
  // This is the core thing being tested: wish("#default") should resolve
  // and provide allPieces as a writable array
  const { allPieces } =
    wish<{ allPieces: Writable<MinimalPiece[]> }>({ query: "#default" }).result;

  // Track state for assertions
  const initialLength = computed(() => allPieces?.get?.()?.length ?? -1);

  // Push a piece to allPieces
  const action_push_piece = action(() => {
    allPieces.push({ [NAME]: "Test Piece 1" } as any);
  });

  const action_push_another = action(() => {
    allPieces.push({ [NAME]: "Test Piece 2" } as any);
  });

  // Assertions
  const assert_allPieces_exists = computed(() => !!allPieces);
  const assert_initial_empty = computed(() => initialLength === 0);
  const assert_after_push_one = computed(
    () => allPieces?.get?.()?.length === 1,
  );
  const assert_after_push_two = computed(
    () => allPieces?.get?.()?.length === 2,
  );

  return {
    tests: [
      // allPieces should be defined (wish resolved successfully)
      { assertion: assert_allPieces_exists },
      // allPieces should start empty
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
