/**
 * What a terminal has to be sent to show the line being typed, and to end it.
 *
 * A line being edited is redrawn where it stands, so a terminal is told where
 * the last drawing put the cursor as well as what to draw. That bookkeeping is
 * arithmetic over two numbers and a width, and it is here rather than beside
 * the writing so that a case can read the escape sequences back without a
 * terminal to send them to.
 *
 * The cursor is put back with the terminal's own save and restore
 * (`ESC 7`/`ESC 8`) rather than by counting where the text left it, because
 * where a line exactly fills a row leaves the cursor is a thing terminals
 * disagree about. What the save costs is the case where drawing scrolls the
 * screen: the saved position is the line's first row, and a line taller than
 * the terminal scrolls that row away.
 *
 * A code point is a column here, as it is in the buffer these numbers come
 * from, so a character a terminal draws double-wide is one column to both.
 *
 * A line carries the width it was drawn at rather than taking the current one,
 * because a window resized between two drawings leaves the old line occupying
 * the rows the old width gave it. What that does not survive is the terminal
 * reflowing what is already on screen, which a resize also does: after one,
 * neither width describes what is there, and the drawn width is merely the one
 * that put it there.
 */

import { CSI, ESC } from "../view/ansi.ts";

/** A line as it was last drawn: what it said, where its cursor sat, how wide. */
export interface PaintedLine {
  /** The whole line, prompt included. */
  readonly text: string;

  /** How many code points into it the cursor sat. */
  readonly column: number;

  /** How wide the terminal was when it was drawn. */
  readonly columns: number;
}

/**
 * The empty line a terminal is on before anything is drawn on it. Its width is
 * the one width that divides nothing into no rows whatever it is, so which one
 * it carries decides nothing.
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
  const back = Math.floor(from.column / from.columns);
  return [
    back > 0 ? `${CSI}${back}A` : "",
    "\r",
    `${ESC}7`,
    `${CSI}0J`,
    to.text,
    `${ESC}8`,
    down(Math.floor(to.column / to.columns)),
    right(to.column % to.columns),
  ].join("");
}

/**
 * Returns what to send to end `painted` and write `text` under it, at the
 * width `painted` was drawn at.
 *
 * The line stays where it was drawn, so what a run leaves behind is each line
 * with what it produced under it. A terminal in raw mode moves the cursor down
 * on a line break without returning it to the left, so every break in `text`
 * is sent with the return that a terminal not in raw mode would have supplied.
 */
export function finish(painted: PaintedLine, text: string): string {
  const cursorRow = Math.floor(painted.column / painted.columns);
  const lastRow = Math.floor(
    Math.max(width(painted.text) - 1, 0) / painted.columns,
  );
  return [
    down(lastRow - cursorRow),
    up(cursorRow - lastRow),
    "\r\n",
    text === "" ? "" : `${text.replaceAll("\n", "\r\n")}\r\n`,
  ].join("");
}

/** Helper for the two above, which moves the cursor down `rows`, or nowhere. */
function down(rows: number): string {
  return rows > 0 ? `${CSI}${rows}B` : "";
}

/** Helper for {@link finish}, which moves the cursor up `rows`, or nowhere. */
function up(rows: number): string {
  return rows > 0 ? `${CSI}${rows}A` : "";
}

/** Helper for {@link repaint}, which moves the cursor right `count` columns. */
function right(count: number): string {
  return count > 0 ? `${CSI}${count}C` : "";
}

/** Helper for {@link finish}, which is how many columns `text` occupies. */
function width(text: string): number {
  return [...text].length;
}
