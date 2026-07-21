/**
 * Regression test for array.length access inside computed().
 *
 * This mimics the pattern from default-app.tsx where:
 * - allPieces comes from wish<{ allPieces: MentionablePiece[] }>
 * - computed(() => allPieces.length) accesses .length on an array from wish
 *
 * The fix ensures the schema is { type: "array", items: { not: true } }
 * rather than { type: "object", properties: { length: { type: "number" } } }
 */
import { computed, NAME, pattern, resultOf, UI, wish } from "commonfabric";

interface Piece {
  id: string;
  name: string;
}

// FIXTURE: computed-array-length
// Verifies: computed(() => expr) with .length access on a Reactive<T[]> is closure-extracted
//   computed(() => allPieces.length) → lift(({ allPieces }) => allPieces.length)({ allPieces: { length: allPieces.length } })
//   allPieces.map(fn) → allPieces.mapWithPattern(pattern(fn, ...schemas), {})
// Context: Regression test ensuring array .length produces the correct schema
//   shape rather than an object schema with a length property.
export default pattern(() => {
  const piecesWish = wish<{ allPieces: Piece[] }>({ query: "/" });
  const { allPieces } = resultOf(piecesWish.result);

  return {
    [NAME]: computed(() => `Pieces (${allPieces.length})`),
    [UI]: (
      <div>
        <span>Count: {computed(() => allPieces.length)}</span>
        <ul>
          {allPieces.map((piece) => (
            <li>{piece.name}</li>
          ))}
        </ul>
      </div>
    ),
  };
});
