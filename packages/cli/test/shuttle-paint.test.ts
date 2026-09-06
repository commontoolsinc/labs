/**
 * Unit tests for what a terminal is sent to show the line being typed, to end
 * it, and to put a line above it.
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
  above,
  finish,
  NOTHING_PAINTED,
  type PaintedLine,
  repaint,
} from "../lib/shuttle/paint.ts";
import { glyphFor } from "../lib/view/display.ts";

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
    it("returns the line ending alone, whatever the line said", () => {
      expect(finish(line("abc", 3))).toBe("\r\n");
    });

    it("moves down to the last row of a wrapped line before ending it", () => {
      expect(finish(line("a".repeat(25), 3))).toBe("\x1b[2B\r\n");
    });

    it("moves up where the cursor sits past the last row a wrap filled", () => {
      // A line whose length is a whole number of rows leaves its cursor, at
      // the end, on a row holding none of it. Ending there would leave that
      // row blank above whatever is written next.

      expect(finish(line("a".repeat(20), 20))).toBe("\x1b[1A\r\n");
    });

    it("ends a wrapped line at the width it was drawn at", () => {
      expect(finish(line("a".repeat(25), 3, 20))).toBe("\x1b[1B\r\n");
    });
  });

  describe("above()", () => {
    it("clears the drawn line, writes the text, and draws the line again", () => {
      expect(above(line("abc", 3), "gone"))
        .toBe("\r\x1b[0Jgone\r\n\r\x1b7\x1b[0Jabc\x1b8\x1b[3C");
    });

    it("climbs to the row the drawn line started on before it clears", () => {
      // The text goes above the whole of the drawn line, so a line that
      // wrapped is climbed to its first row: written from where the cursor
      // sits, the text would land in the middle of it.

      expect(above(line("a".repeat(25), 25), "gone"))
        .toContain("\x1b[2A\r\x1b[0Jgone");
    });

    it("writes each break in the text with the return raw mode needs", () => {
      expect(above(NOTHING_PAINTED, "one\ntwo"))
        .toBe("\r\x1b[0Jone\r\ntwo\r\n\r\x1b7\x1b[0J\x1b8");
    });

    it("shows every character a terminal acts on as the glyph naming it", () => {
      // The contract names a class and exempts one character of it, which is
      // a claim about all sixty-five: C0, `DEL`, and C1. So the case drives
      // all sixty-five rather than the handful a person thinks of — a raw tab
      // let through would break the contract and fail no sampled case, and a
      // tab is the one of these a value plausibly holds.
      //
      // Two assertions per character and the first is the load-bearing one.
      // That the raw character is gone is the property a terminal cares about
      // and it names no glyph, so it holds whatever `glyphFor` draws; that
      // the glyph is there is what makes the character still readable, and it
      // asks `glyphFor` for the answer rather than restating it, the glyph
      // being that function's to decide (`view-display.test.ts` pins which).

      const acted = [
        ...Array.from({ length: 0x20 }, (_, code) => code),
        0x7f,
        ...Array.from({ length: 0x20 }, (_, code) => 0x80 + code),
      ];
      expect(acted.length).toBe(65);

      for (const code of acted) {
        const character = String.fromCodePoint(code);
        const sent = above(NOTHING_PAINTED, `a${character}b`);
        if (character === "\n") continue;
        expect({ code, raw: sent.includes(`a${character}b`) })
          .toEqual({ code, raw: false });
        expect({ code, shown: sent.includes(`a${glyphFor(character)}b`) })
          .toEqual({ code, shown: true });
      }
    });

    it("passes the line feed, which is the one of that class that is layout", () => {
      // The exemption the case above steps over, asserted where it can be
      // read: a break in the text arrived as a row from whoever composed the
      // line, and it is sent as the row it is rather than as a picture of a
      // character.

      const sent = above(NOTHING_PAINTED, "a\nb");
      expect(sent).toContain("a\r\nb");
      expect(sent).not.toContain(glyphFor("\n"));
    });

    it("leaves a text holding nothing of that class alone", () => {
      expect(above(NOTHING_PAINTED, "a b")).toContain("\r\x1b[0Ja b\r\n");
    });

    it("draws the line again at the width it was drawn at", () => {
      expect(above(line("a".repeat(25), 25, 20), "gone"))
        .toBe(
          `\x1b[1A\r\x1b[0Jgone\r\n\r\x1b7\x1b[0J${
            "a".repeat(25)
          }\x1b8\x1b[1B\x1b[5C`,
        );
    });
  });
});
