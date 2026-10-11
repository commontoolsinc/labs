/**
 * Tests WordSearchPlay: a word is found by tapping its two ends, in either
 * order; taps that are not a word's two ends find nothing; tapping the
 * waiting letter again lets it go; finding every word solves the puzzle;
 * starting over forgets this puzzle's finds; and a reshuffled puzzle, with
 * the same words elsewhere, starts unsolved.
 *
 * Run: deno task cf test packages/patterns/wordsearch/play.test.tsx
 */
import {
  action,
  assert,
  computed,
  handler,
  pattern,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { textContent } from "../test/vnode-helpers.ts";
import {
  generateWordSearch,
  type Placement,
  placementCells,
  type WordSearch as Puzzle,
} from "./generator.ts";
import WordSearchPlay from "./play.tsx";

/** The first and last cell of the placement at `n` (in placement order). */
const ends = (
  puzzle: { readonly cols: number; readonly placements: readonly Placement[] },
  n: number,
): [number, number] => {
  const cells = placementCells(puzzle.placements[n], puzzle.cols);
  return [cells[0], cells[cells.length - 1]];
};

/** Tap the two ends of the placement at `n`, last end first when `reversed`. */
const tapEnds = handler<
  void,
  {
    puzzle: Puzzle;
    tap: Stream<{ index: number }>;
    n: number;
    reversed: boolean;
  }
>((_, { puzzle, tap, n, reversed }) => {
  const [first, last] = ends(puzzle, n);
  tap.send({ index: reversed ? last : first });
  tap.send({ index: reversed ? first : last });
});

export default pattern(() => {
  const seed = new Writable(1);
  const puzzle = computed(() =>
    generateWordSearch({
      words: ["apple", "kiwi", "plum"],
      rows: 8,
      cols: 8,
      diagonals: true,
      backwards: true,
      seed: seed.get(),
    })
  );
  const found = new Writable<string[]>([]);
  const anchor = new Writable(-1);
  const play = WordSearchPlay({ puzzle, found, anchor });

  const tap = play.tap;

  return {
    [TESTS]: [
      { assertion: assert(() => play.foundCount === 0 && !play.solved) },

      // A word's first letter, then its last: found.
      { action: tapEnds({ puzzle, tap, n: 0, reversed: false }) },
      { assertion: assert(() => play.foundCount === 1) },
      { assertion: assert(() => anchor.get() === -1) },

      // Its last letter, then its first: found too.
      { action: tapEnds({ puzzle, tap, n: 1, reversed: true }) },
      { assertion: assert(() => play.foundCount === 2) },

      // Two letters that are not a word's two ends find nothing, and the
      // second tap is the start of a new selection.
      {
        action: action(() => {
          const cells = placementCells(puzzle.placements[2], puzzle.cols);
          play.tap.send({ index: cells[0] });
          play.tap.send({ index: cells[1] });
        }),
      },
      { assertion: assert(() => play.foundCount === 2) },
      {
        assertion: assert(() =>
          anchor.get() === placementCells(puzzle.placements[2], puzzle.cols)[1]
        ),
      },

      // Tapping the waiting letter again lets it go.
      {
        action: action(() => play.tap.send({ index: anchor.get() })),
      },
      { assertion: assert(() => anchor.get() === -1) },

      // The last word solves the puzzle.
      { action: tapEnds({ puzzle, tap, n: 2, reversed: false }) },
      { assertion: assert(() => play.foundCount === 3 && play.solved) },
      {
        assertion: assert(() => textContent(play[UI]).includes("All 3 found")),
      },

      // Finding a word twice counts it once.
      { action: tapEnds({ puzzle, tap, n: 0, reversed: true }) },
      { assertion: assert(() => found.get().length === 3) },

      // Starting over forgets this puzzle's finds.
      { action: action(() => play.restart.send()) },
      { assertion: assert(() => play.foundCount === 0 && !play.solved) },

      // A reshuffle hides the same words elsewhere: last arrangement's finds
      // do not count for it.
      { action: tapEnds({ puzzle, tap, n: 0, reversed: false }) },
      { assertion: assert(() => play.foundCount === 1) },
      { action: action(() => seed.set(2)) },
      { assertion: assert(() => play.foundCount === 0) },
    ],
  };
});
