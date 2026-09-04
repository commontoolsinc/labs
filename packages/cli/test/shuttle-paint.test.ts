/**
 * Unit tests for what a terminal is sent to show the line being typed, and to
 * end it.
 *
 * The expectations are the escape sequences themselves, written out. That is
 * the whole point of the module being separate from the writing: what a
 * terminal does with them is untestable here, and what is sent to it is
 * exactly a string.
 *
 * A narrow width stands in for a real terminal throughout, so a case about
 * wrapping fits on a line of its own.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  finish,
  NOTHING_PAINTED,
  type PaintedLine,
  repaint,
} from "../lib/shuttle/paint.ts";

/** The width every case below draws at, unless it says otherwise. */
const WIDTH = 10;

/** Helper for the cases below, which is a line drawn `columns` wide. */
function line(text: string, column: number, columns = WIDTH): PaintedLine {
  return { text, column, columns };
}

describe("paint", () => {
  describe("repaint()", () => {
    it("returns the line, between a saved cursor and the restore of it", () => {
      expect(repaint(NOTHING_PAINTED, line("abc", 3)))
        .toBe("\r\x1b7\x1b[0Jabc\x1b8\x1b[3C");
    });

    it("clears to the end of the screen rather than to the end of the row", () => {
      expect(repaint(NOTHING_PAINTED, line("a", 1))).toContain("\x1b[0J");
    });

    it("moves the cursor up to the row the last drawing started on", () => {
      expect(repaint(line("a".repeat(25), 25), line("b", 1)))
        .toBe("\x1b[2A\r\x1b7\x1b[0Jb\x1b8\x1b[1C");
    });

    it("moves the cursor down to the row of the column it is drawn at", () => {
      expect(repaint(NOTHING_PAINTED, line("a".repeat(25), 23)))
        .toBe(`\r\x1b7\x1b[0J${"a".repeat(25)}\x1b8\x1b[2B\x1b[3C`);
    });

    it("moves the cursor nowhere for a line drawn with the cursor at its start", () => {
      expect(repaint(NOTHING_PAINTED, line("abc", 0)))
        .toBe("\r\x1b7\x1b[0Jabc\x1b8");
    });

    it("counts back over the old line at the width it was drawn at", () => {
      // A window resized between two drawings leaves the old line occupying
      // the rows the old width gave it, so counting back over it at the new
      // width lands on some other row. Twenty-five columns wrapped to three
      // rows at ten and to two at twenty, and it is the three that have to be
      // climbed.

      expect(repaint(line("a".repeat(25), 25), line("b", 1, 20)))
        .toBe("\x1b[2A\r\x1b7\x1b[0Jb\x1b8\x1b[1C");
    });

    it("counts down over the new line at the width it is drawn at", () => {
      expect(repaint(NOTHING_PAINTED, line("a".repeat(25), 25, 20)))
        .toBe(`\r\x1b7\x1b[0J${"a".repeat(25)}\x1b8\x1b[1B\x1b[5C`);
    });

    it("counts a code point as a column, whatever a terminal draws it as", () => {
      // The buffer the columns come from counts in code points, so this counts
      // the same way rather than measuring what the glyphs occupy. A character
      // a terminal draws double-wide therefore moves the cursor one column
      // where it drew two.

      expect(repaint(NOTHING_PAINTED, line("\u{1F9F5}", 1)))
        .toBe("\r\x1b7\x1b[0J\u{1F9F5}\x1b8\x1b[1C");
    });
  });

  describe("finish()", () => {
    it("returns the line ending alone where the line produced nothing", () => {
      expect(finish(line("abc", 3), "")).toBe("\r\n");
    });

    it("returns what the line produced under it, with an ending of its own", () => {
      expect(finish(line("abc", 3), "gone")).toBe("\r\ngone\r\n");
    });

    it("returns each break in what it writes with the return raw mode needs", () => {
      expect(finish(NOTHING_PAINTED, "one\ntwo")).toBe("\r\none\r\ntwo\r\n");
    });

    it("moves down to the last row of a wrapped line before ending it", () => {
      expect(finish(line("a".repeat(25), 3), "")).toBe("\x1b[2B\r\n");
    });

    it("moves up where the cursor sits past the last row a wrap filled", () => {
      // A line whose length is a whole number of rows leaves its cursor, at
      // the end, on a row holding none of it. Ending there would leave that
      // row blank above what the line produced.

      expect(finish(line("a".repeat(20), 20), "")).toBe("\x1b[1A\r\n");
    });

    it("ends a wrapped line at the width it was drawn at", () => {
      expect(finish(line("a".repeat(25), 3, 20), "")).toBe("\x1b[1B\r\n");
    });
  });
});
