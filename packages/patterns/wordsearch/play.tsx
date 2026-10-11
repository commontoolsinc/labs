/**
 * Play a word search: tap a hidden word's first letter, then its last, and
 * the word is marked found. The found words are each player's own and
 * follow them across tabs; the letter waiting for its partner is this tab's
 * alone.
 *
 * A found word is recorded by where it runs as well as what it is, so a
 * reshuffled puzzle, which hides the same words elsewhere, starts unsolved.
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  type PerSession,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import {
  placementBetween,
  placementCells,
  placementKey,
  type WordSearch as Puzzle,
} from "./generator.ts";

const EMPTY_PUZZLE: Puzzle = {
  rows: 0,
  cols: 0,
  grid: [],
  placements: [],
  skipped: [],
};

export interface WordSearchPlayInput {
  /** The puzzle to play, as `WordSearch` or `generateWordSearch` makes it. */
  puzzle?: Puzzle | Default<typeof EMPTY_PUZZLE>;

  /** Each player's found words, by `placementKey`. */
  found?: PerUser<Writable<string[] | Default<[]>>>;

  /** The cell tapped first, waiting for a word's other end; -1 for none. */
  anchor?: PerSession<Writable<number | Default<-1>>>;
}

export interface WordSearchPlayOutput {
  [NAME]: string;
  [UI]: VNode;
  /** How many of the puzzle's hidden words this player has found. */
  foundCount: number;
  /** Whether every hidden word is found. */
  solved: boolean;
  /** Tap the cell at `index` (row * cols + col). */
  tap: Stream<{ index: number }>;
  /** Forget this player's found words for this puzzle. */
  restart: Stream<void>;
}

export const WordSearchPlay = pattern<
  WordSearchPlayInput,
  WordSearchPlayOutput
>(
  ({ puzzle, found, anchor }) => {
    const keys = computed(() => puzzle.placements.map(placementKey));
    // Found words of this puzzle: a key from another arrangement is not one.
    const foundHere = computed(() =>
      found.get().filter((key) => keys.includes(key))
    );
    const foundCount = computed(() => foundHere.length);
    const solved = computed(() =>
      puzzle.placements.length > 0 &&
      foundHere.length === puzzle.placements.length
    );

    const tap = action<{ index: number }>(({ index }) => {
      const first = anchor.get();
      if (first < 0) {
        anchor.set(index);
        return;
      }
      if (first === index) {
        anchor.set(-1);
        return;
      }
      const hit = placementBetween(puzzle, first, index);
      if (hit === undefined) {
        // Not a word's two ends: this tap starts a new selection.
        anchor.set(index);
        return;
      }
      anchor.set(-1);
      const key = placementKey(hit);
      const current = found.get().filter((k) => keys.includes(k));
      if (!current.includes(key)) found.set([...current, key]);
    });

    const restart = action(() => {
      found.set(found.get().filter((key) => !keys.includes(key)));
      anchor.set(-1);
    });

    const gridStyle = computed(() =>
      `display: grid; grid-template-columns: repeat(${puzzle.cols}, 1fr); ` +
      `gap: 2px; width: min(100%, ${puzzle.cols * 2.25}rem);`
    );

    // One entry per cell, row by row: its letter, a label for assistive
    // technology, and how it is drawn (part of a found word, the waiting
    // first tap, or plain).
    const cells = computed(() => {
      const inFound = new Set(
        puzzle.placements
          .filter((p) => foundHere.includes(placementKey(p)))
          .flatMap((p) => placementCells(p, puzzle.cols)),
      );
      const waiting = anchor.get();
      return puzzle.grid.join("").split("").map((letter, index) => ({
        index,
        letter,
        label: `${letter}, row ${Math.floor(index / puzzle.cols) + 1}, ` +
          `column ${(index % puzzle.cols) + 1}`,
        pressed: index === waiting,
        style: "aspect-ratio: 1; display: flex; align-items: center; " +
          "justify-content: center; border-radius: 999px; padding: 0; " +
          "font: inherit; font-family: var(--cf-theme-mono-font-family, " +
          "monospace); font-weight: 600; cursor: pointer; " +
          (inFound.has(index)
            ? "background: var(--cf-theme-color-primary); " +
              "color: var(--cf-theme-color-primary-foreground); border: none;"
            : "background: transparent; color: var(--cf-theme-color-text); " +
              "border: none;") +
          (index === waiting
            ? " outline: 2px solid var(--cf-theme-color-primary); " +
              "outline-offset: -2px;"
            : ""),
      }));
    });

    const words = computed(() =>
      [...puzzle.placements]
        .sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
        .map((p) => ({
          label: p.label,
          style: foundHere.includes(placementKey(p))
            ? "text-decoration: line-through; " +
              "color: var(--cf-theme-color-text-muted);"
            : "",
        }))
    );
    const progress = computed(() =>
      solved
        ? `All ${puzzle.placements.length} found`
        : `${foundHere.length} of ${puzzle.placements.length} found`
    );
    const isEmpty = computed(() => puzzle.placements.length === 0);

    return {
      [NAME]: computed(() => solved ? "Word search, solved" : "Word search"),
      [UI]: (
        <cf-vstack gap="3">
          {isEmpty
            ? <cf-text tone="muted">Nothing to find yet.</cf-text>
            : (
              <cf-vstack gap="3">
                <cf-hstack gap="2" align="center" justify="between" wrap>
                  <cf-text>{progress}</cf-text>
                  <cf-button variant="ghost" size="sm" onClick={restart}>
                    Start over
                  </cf-button>
                </cf-hstack>
                <cf-text tone="muted">
                  Tap a word's first letter, then its last.
                </cf-text>
                <div style={gridStyle}>
                  {cells.map((cell) => (
                    <button
                      type="button"
                      style={cell.style}
                      aria-label={cell.label}
                      aria-pressed={cell.pressed}
                      onClick={() => tap.send({ index: cell.index })}
                    >
                      {cell.letter}
                    </button>
                  ))}
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; font-weight: 600; letter-spacing: 0.05em;">
                  {words.map((word) => (
                    <span style={word.style}>{word.label}</span>
                  ))}
                </div>
              </cf-vstack>
            )}
        </cf-vstack>
      ),
      foundCount,
      solved,
      tap,
      restart,
    };
  },
);

export default WordSearchPlay;
