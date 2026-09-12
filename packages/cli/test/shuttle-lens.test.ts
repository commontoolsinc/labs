/**
 * Unit tests for the value view: the frame it draws, the keys it takes, and
 * what closing it cancels.
 *
 * The frame comes back as lines and the keys arrive decoded, so every case
 * drives the whole of it with no terminal. What a case can therefore assert is
 * the thing a terminal would have hidden: that every row of a frame is the
 * same width, that a repaint happens once per change rather than once per
 * value, and that `q` cancels this lens's own subscription and nothing else.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { unicodeWidth } from "@std/cli/unicode-width";

import { ValueLens } from "../lib/shuttle/lens.ts";
import type { Key } from "../lib/view/keys.ts";

/** How tall and wide a frame is where a case is not asking about the size. */
const ROWS = 8;
const COLUMNS = 40;

/** Helper for the cases below, which is the key named `name`. */
function key(name: string): Key {
  return { name };
}

/** What driving a lens produced: the lens, its repaints, and its cancels. */
interface Driven {
  /** The lens itself. */
  readonly lens: ValueLens;

  /** The frames it drew, in order. */
  readonly drawn: (readonly string[])[];

  /** How many times the subscription it holds has been cancelled. */
  cancels: () => number;
}

/**
 * Helper for the cases below, which is a lens already drawing and already
 * holding a subscription, recording both.
 */
function driving(
  label = "cell @space",
  rows = ROWS,
  columns = COLUMNS,
): Driven {
  const drawn: (readonly string[])[] = [];
  let cancelled = 0;
  const lens = new ValueLens(label);
  lens.holding(() => cancelled++);
  lens.drawnThrough(() => drawn.push(lens.frame(rows, columns)));
  return { lens, drawn, cancels: () => cancelled };
}

/** Helper for the cases below, which is the frame a lens last drew. */
function last(driven: Driven): readonly string[] {
  return driven.drawn[driven.drawn.length - 1] ?? [];
}

/** Helper for the cases below, which is the body rows of `frame`. */
function body(frame: readonly string[]): string[] {
  return frame.slice(1, -1).map((row) => row.slice(2, -2).trimEnd());
}

describe("lens", () => {
  describe("ValueLens", () => {
    describe("instance members", () => {
      describe("frame()", () => {
        it("returns as many rows as the terminal is tall", () => {
          expect(last(driving()).length).toBe(ROWS);
        });

        it("returns every row at the terminal's width", () => {
          // A row narrower or wider than the rest puts the frame's right edge
          // in two columns, which is what the padding and the fitting are for.

          const driven = driving();
          driven.lens.showing({ title: "verb contracts", replies: 14 });
          expect(last(driven).map((row) => unicodeWidth(row)))
            .toEqual(Array(ROWS).fill(COLUMNS));
        });

        it("returns no more rows than a two-row terminal has", () => {
          // The frame is drawn onto the whole screen, so a frame taller than
          // the screen scrolls its own top row away — and the top row is the
          // one naming the cell. Two rows is the size at which the two edges
          // are the whole of it, and a transition row is what does not fit.
          //
          // Kills: adding the transition row outside the room left for it,
          // which returns three rows for a screen with two.

          const driven = driving("cell @space", 2, COLUMNS);
          driven.lens.showing({ replies: 14 });
          driven.lens.showing({ replies: 15 });
          expect(last(driven).length).toBeLessThanOrEqual(2);
        });

        it("returns every row at one width on a five-column terminal", () => {
          // The narrowest a frame is drawn at. Both edges carry text that is
          // fitted to the room left after their own framing, and a row that
          // came back wider than the rest would put the right edge in two
          // columns at exactly the width where there is no room to spare.
          //
          // Kills: fitting either edge's text against the full width rather
          // than the width less its framing.

          const driven = driving("cell @space", ROWS, 5);
          driven.lens.showing({ a: 1, b: 2, c: 3 });
          expect(last(driven).map((row) => unicodeWidth(row)))
            .toEqual(Array(ROWS).fill(5));
        });

        it("counts no rows as none rather than as a backwards range", () => {
          // A screen with no room between the edges shows none of the value,
          // and a range counted from the first row to the one before it reads
          // as a span that runs backwards. What a reader is owed there is how
          // much they cannot see.
          //
          // Kills: composing the range from `top` and the row count without
          // asking whether any row was shown, which writes `1-0 of 3`.

          const driven = driving("cell @space", 2, COLUMNS);
          driven.lens.showing({ a: 1, b: 2, c: 3 });
          expect(last(driven)[1]).toContain("0 of ");
          expect(last(driven)[1]).not.toContain("1-0");
        });

        it("names the cell on the top edge", () => {
          expect(last(driving("first/label @space"))[0])
            .toBe("┌ first/label @space ──────────────────┐");
        });

        it("offers every key it takes on the bottom edge", () => {
          expect(last(driving("c", 4, 60))[3]).toBe(
            "└ q back (the watch stays armed) · j/k scroll · g/G ends ──┘",
          );
        });

        it("says the cell has not settled before it has", () => {
          // The subscription fires with what the cell already holds, but not
          // before the frame is first drawn, so a frame with nothing in it is
          // a state a reader reaches and one the frame says out loud.

          expect(body(last(driving())))
            .toEqual(["<nothing has settled yet>", "", "", "", "", ""]);
        });

        it("returns the value as the rendering `get` writes", () => {
          const driven = driving();
          driven.lens.showing({ replies: 14 });
          expect(body(last(driven)).slice(0, 3))
            .toEqual(["{", '  "replies": 14', "}"]);
        });

        it("says which rows are on screen where the value does not fit", () => {
          const driven = driving("c", 4, 80);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          expect(last(driven)[3]).toBe(
            "└ q back (the watch stays armed) · j/k scroll · g/G ends " +
              "──────────── 1-2 of 8 ┘",
          );
        });

        it("cuts the keys rather than the count where both will not fit", () => {
          // The right of an edge carries what the frame is doing now and the
          // left a reminder of the keys, which is the half a reader can do
          // without.

          const driven = driving("c", 4, 40);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          expect(last(driven)[3])
            .toBe("└ q back (the watch stays ar  1-2 of 8 ┘");
        });

        it("says nothing about rows where the whole value is on screen", () => {
          const driven = driving("c", 8, 60);
          driven.lens.showing(1);
          expect(last(driven)[7]).toBe(
            "└ q back (the watch stays armed) · j/k scroll · g/G ends ──┘",
          );
        });

        it("returns the two edges alone where nothing else fits", () => {
          // A terminal too short for a value is one a reader can still read
          // the title and the keys off.

          expect(driving("c", 2, 20).drawn[0]?.length).toBe(2);
        });

        it("breaks a line at the frame's inner width rather than the screen's", () => {
          // A line broken at the screen's width would run past the frame's
          // right edge by the four columns the edges take.

          const driven = driving("c", 8, 20);
          driven.lens.showing("x".repeat(30));
          expect(body(last(driven)).slice(0, 2))
            .toEqual([`"${"x".repeat(15)}`, `${"x".repeat(15)}"`]);
        });
      });

      describe("showing()", () => {
        it("draws once for one settled value", () => {
          // One call costs one repaint. That several intermediate values do
          // not reach here at all is the subscription's promise
          // (`sinkCellValue`, `lib/piece.ts`), and this is the half of it this
          // module owes.

          const driven = driving();
          driven.lens.showing(1);
          driven.lens.showing(2);
          // The first drawing is `drawnThrough`'s own.
          expect(driven.drawn.length).toBe(3);
        });

        it("keeps where the reader had scrolled to", () => {
          const driven = driving("c", 5, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          driven.lens.reads(key("j"));
          driven.lens.showing(["a", "b", "c", "d", "e", "g"]);
          expect(body(last(driven)).slice(1)).toEqual(['  "a",', '  "b",']);
        });

        it("says what the last change was, above the value", () => {
          // A change is seen rather than inferred: a value that repainted
          // says only where it landed, and the transition says what moved.

          const driven = driving("c", 5, 60);
          driven.lens.showing({ replies: 14 });
          driven.lens.showing({ replies: 15 });
          expect(body(last(driven))[0]).toBe("<replies 14 → 15>");
        });

        it("says nothing about a change for the first settled value", () => {
          // The first settle is what the cell already held, so a row naming a
          // change would name one nobody made.

          const driven = driving("c", 5, 60);
          driven.lens.showing({ replies: 14 });
          expect(body(last(driven))[0]).toBe("{");
        });

        it("says nothing about a change for a settle that moved nothing", () => {
          const driven = driving("c", 5, 60);
          driven.lens.showing({ replies: 14 });
          driven.lens.showing({ replies: 14 });
          expect(body(last(driven))[0]).toBe("{");
        });

        it("keeps the last change on screen until another replaces it", () => {
          // Nothing takes a row away on a clock, so what a reader comes back
          // to is the last thing that happened.

          const driven = driving("c", 5, 60);
          driven.lens.showing({ replies: 14 });
          driven.lens.showing({ replies: 15 });
          driven.lens.showing({ replies: 15 });
          const stood = body(last(driven))[0];
          driven.lens.showing({ replies: 16 });
          expect({ stood, then: body(last(driven))[0] })
            .toEqual({ stood: "<replies 14 → 15>", then: "<replies 15 → 16>" });
        });

        it("stands the change row wherever the reader has scrolled to", () => {
          // It is a fact about the cell rather than a line of its value, so
          // it is not part of what scrolls.

          const driven = driving("c", 5, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          driven.lens.showing(["a", "b", "c", "d", "e", "g"]);
          driven.lens.reads(key("G"));
          expect(body(last(driven))[0]).toBe('<5 "f" → "g">');
        });

        it("draws nothing once the lens is closed", () => {
          const driven = driving();
          driven.lens.close();
          driven.lens.showing(1);
          expect(driven.drawn.length).toBe(1);
        });
      });

      describe("reads()", () => {
        it("closes the lens on `q`", () => {
          const driven = driving();
          driven.lens.reads(key("q"));
          expect(driven.lens.open).toBe(false);
        });

        it("closes the lens on `ctrl-c`", () => {
          // A full screen a person cannot get out of by the key every terminal
          // program answers is worse than one key too many.

          const driven = driving();
          driven.lens.reads(key("ctrl-c"));
          expect(driven.lens.open).toBe(false);
        });

        it("cancels this lens's own subscription when it closes", () => {
          const driven = driving();
          driven.lens.reads(key("q"));
          expect(driven.cancels()).toBe(1);
        });

        it("scrolls one row down on `j` and back up on `k`", () => {
          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          driven.lens.reads(key("j"));
          const down = body(last(driven));
          driven.lens.reads(key("k"));
          expect({ down, up: body(last(driven)) })
            .toEqual({ down: ['  "a",', '  "b",'], up: ["[", '  "a",'] });
        });

        it("scrolls on the arrows as it does on `j` and `k`", () => {
          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          driven.lens.reads(key("down"));
          const down = body(last(driven));
          driven.lens.reads(key("up"));
          expect({ down, up: body(last(driven)) })
            .toEqual({ down: ['  "a",', '  "b",'], up: ["[", '  "a",'] });
        });

        it("goes to the two ends on `g` and `G`", () => {
          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          driven.lens.reads(key("G"));
          const end = body(last(driven));
          driven.lens.reads(key("g"));
          expect({ end, start: body(last(driven)) })
            .toEqual({ end: ['  "f"', "]"], start: ["[", '  "a",'] });
        });

        it("stops at the last row rather than scrolling past it", () => {
          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          for (let press = 0; press < 20; press++) {
            driven.lens.reads(key("j"));
          }
          expect(body(last(driven))).toEqual(['  "f"', "]"]);
        });

        it("moves one row back from the last after scrolling past it", () => {
          // The clamp is recorded rather than merely applied, so a `k` after a
          // run of `j`s moves from where the reader is looking rather than
          // from where they had scrolled to.

          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          for (let press = 0; press < 20; press++) {
            driven.lens.reads(key("j"));
          }
          driven.lens.reads(key("k"));
          expect(body(last(driven))).toEqual(['  "e",', '  "f"']);
        });

        it("draws nothing for a key it does not take", () => {
          const driven = driving();
          driven.lens.reads(key("x"));
          expect(driven.drawn.length).toBe(1);
        });

        it("does nothing once the lens is closed", () => {
          const driven = driving();
          driven.lens.close();
          driven.lens.reads(key("j"));
          expect(driven.drawn.length).toBe(1);
        });
      });

      describe("holding()", () => {
        it("cancels at once where the lens closed while it was subscribing", () => {
          const lens = new ValueLens("c");
          let cancelled = 0;
          lens.close();
          lens.holding(() => cancelled++);
          expect(cancelled).toBe(1);
        });
      });

      describe("close()", () => {
        it("cancels once however many times it is called", () => {
          const driven = driving();
          driven.lens.close();
          driven.lens.close();
          expect(driven.cancels()).toBe(1);
        });
      });

      describe("label", () => {
        it("returns the cell the lens was opened onto", () => {
          expect(driving("first/label @space").lens.label)
            .toBe("first/label @space");
        });
      });
    });
  });
});
