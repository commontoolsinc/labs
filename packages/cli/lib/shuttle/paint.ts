/**
 * What a terminal has to be sent to show the line being typed, to end it, and
 * to put a line above it.
 *
 * A line being edited is redrawn where it stands, so a terminal is told where
 * the last drawing put the cursor as well as what to draw. That bookkeeping is
 * a line, a cursor and a width laid out into rows, and it is here rather than
 * beside the writing so that a case can read the escape sequences back without
 * a terminal to send them to.
 *
 * The cursor is put back with the terminal's own save and restore
 * (`ESC 7`/`ESC 8`) rather than by counting where the text left it, because
 * where a line exactly fills a row leaves the cursor is a thing terminals
 * disagree about. What the save costs is the case where drawing scrolls the
 * screen: the saved position is the line's first row, and a line taller than
 * the terminal scrolls that row away.
 *
 * A cursor arrives as a code-point index into the line, which is the unit the
 * buffer it comes from moves in, and where that lands on the screen is worked
 * out here at the columns a terminal gives each character. The two are not the
 * same count: a character drawn double-wide is one code point and two columns,
 * so a cursor moved by the index would sit left of where the typing appears,
 * and by one column more for every such character in front of it.
 *
 * A line carries the width it was drawn at rather than taking the current one,
 * because a window resized between two drawings leaves the old line occupying
 * the rows the old width gave it. What that does not survive is the terminal
 * reflowing what is already on screen, which a resize also does: after one,
 * neither width describes what is there, and the drawn width is merely the one
 * that put it there.
 */

import { unicodeWidth } from "@std/cli/unicode-width";

import { CSI, ESC } from "../view/ansi.ts";
import { wrapped } from "./page.ts";
import { escapeControlCharacters } from "./place.ts";

/** A line as it was last drawn: what it said, where its cursor sat, how wide. */
export interface PaintedLine {
  /** The whole line, prompt included. */
  readonly text: string;

  /**
   * How many code points into the text the cursor sat, which is an index into
   * it rather than a place on the screen. What a terminal draws each of those
   * code points as is what turns the one into the other, and this module is
   * where that conversion happens.
   */
  readonly column: number;

  /** How wide the terminal was when it was drawn. */
  readonly columns: number;
}

/**
 * The empty line a terminal is on before anything is drawn on it. No width
 * lays nothing out over more than the row it starts on, so which one it
 * carries decides nothing.
 */
export const NOTHING_PAINTED: PaintedLine = { text: "", column: 0, columns: 1 };

/**
 * Returns what to send to replace `from` with `to`, each at the width it is
 * drawn at.
 *
 * The old line is cleared to the end of the screen rather than to the end of
 * its row, so a line that wrapped and then shortened leaves nothing of itself
 * behind on the rows below.
 */
export function repaint(from: PaintedLine, to: PaintedLine): string {
  const cursor = cursorOf(to);
  return [
    up(cursorOf(from).row),
    "\r",
    `${ESC}7`,
    `${CSI}0J`,
    to.text,
    `${ESC}8`,
    down(cursor.row),
    right(cursor.column),
  ].join("");
}

/**
 * Returns what to send to end `painted`, at the width it was drawn at.
 *
 * The line stays where it was drawn, so what a run leaves behind is each line
 * with whatever was written under it. Ending it is all this does: what a line
 * produced lands through {@link above}, because between the two the person may
 * have gone on typing and a terminal writes where its cursor is.
 *
 * The move is to the row the text ends on and not to the row the cursor is on,
 * which are different rows for a line filling its last one exactly: ending
 * where the cursor sits would leave a blank row above whatever is written next.
 */
export function finish(painted: PaintedLine): string {
  const cursor = cursorOf(painted).row;
  const last = lastRowOf(painted);
  return [down(last - cursor), up(cursor - last), "\r\n"].join("");
}

/**
 * Returns what to send to put `text` above `painted` and draw `painted` again
 * beneath it, at the width it was drawn at.
 *
 * This is the third write, and what comes through it is not what comes through
 * the other two. A drawn line is what a person typed, held to the class a
 * terminal acts on as each key arrives (`prompt.ts`); a line ending carries no
 * text at all. This one carries what a pattern wrote to its console and what
 * the runtime warned about — strings a user program authored, which passed no
 * door of shuttle's and were never held to anything. So the holding is here,
 * at the door itself, where no producer can be the one that forgot:
 * {@link escapeControlCharacters} shows every character a terminal acts on as
 * the glyph naming it, which is the treatment a message gets everywhere else
 * in the shell (`place.ts`).
 *
 * The line feed is the one character of that class this lets through, and it
 * lets it through as a row rather than as content: what arrives here is
 * already laid out in lines by whoever composed it, and a terminal in raw mode
 * moves the cursor down on a break without returning it to the left, so every
 * break is sent with the return a terminal not in raw mode would have
 * supplied. Every other character of the class is a picture of itself, the
 * carriage return and the escape among them, so nothing that arrives here can
 * move the cursor off the row it was given or start a sequence.
 */
export function above(painted: PaintedLine, text: string): string {
  return [
    up(cursorOf(painted).row),
    "\r",
    `${CSI}0J`,
    inert(text),
    "\r\n",
    repaint(NOTHING_PAINTED, painted),
  ].join("");
}

/**
 * Helper for {@link above}, which is `text` with nothing left in it that a
 * terminal acts on, and its breaks written as a terminal in raw mode needs
 * them.
 *
 * The class is walked a line at a time so that the glyphing is
 * {@link escapeControlCharacters} exactly — one question with one answer —
 * rather than a second predicate standing beside it that would have to be kept
 * in step.
 */
function inert(text: string): string {
  return text.split("\n").map(escapeControlCharacters).join("\r\n");
}

/** Helper for the writes above, which moves the cursor down `rows`, or nowhere. */
function down(rows: number): string {
  return rows > 0 ? `${CSI}${rows}B` : "";
}

/** Helper for the writes above, which moves the cursor up `rows`, or nowhere. */
function up(rows: number): string {
  return rows > 0 ? `${CSI}${rows}A` : "";
}

/** Helper for {@link repaint}, which moves the cursor right `count` columns. */
function right(count: number): string {
  return count > 0 ? `${CSI}${count}C` : "";
}

/** Where a drawn line left the cursor, counted from the line's own start. */
interface Cursor {
  /** How many rows below the line's first row it sat. */
  readonly row: number;

  /** How many columns across that row it sat. */
  readonly column: number;
}

/**
 * Helper for the writes above, which is where `painted` left the cursor.
 *
 * The count a line carries is an index and the answer is a place on the
 * screen, so the text in front of the cursor is broken into rows the way the
 * terminal breaks it — {@link wrapped} (`page.ts`), the one traversal this
 * and a page both measure by. Two things follow from it being the terminal's
 * traversal rather than a division. A character counts the columns it is drawn
 * in, so a double-wide one moves the cursor two. And a row with one column
 * left and a double-wide character to place is left that column blank, the
 * character starting the row below, so the row a division names can be a row
 * short and the column across it can be a column short of that.
 *
 * Text filling its last row exactly leaves the cursor at the start of the next
 * row rather than at the end of the filled one. Every write here counts rows
 * by this function, so whichever of those a terminal would have done, a
 * drawing climbs back over exactly the rows the drawing before it came down.
 * {@link finish} is the one caller wanting the other reading, and it asks for
 * the row the text ends on separately.
 */
function cursorOf({ text, column, columns }: PaintedLine): Cursor {
  const width = Math.max(columns, 1);
  const rows = wrapped([[...text].slice(0, column).join("")], width);
  const filled = unicodeWidth(rows[rows.length - 1]!);
  return filled >= width
    ? { row: rows.length, column: 0 }
    : { row: rows.length - 1, column: filled };
}

/**
 * Helper for {@link finish}, which is how many rows below its first row the
 * last row of `painted` is.
 *
 * It measures the whole text where {@link cursorOf} measures what is in front
 * of the cursor, and by the same traversal, so the two answers are rows of one
 * layout and the difference between them is a distance to move.
 */
function lastRowOf({ text, columns }: PaintedLine): number {
  return wrapped([text], columns).length - 1;
}
