/**
 * The value view: one cell rendered as structured JSON, scrollable, and live
 * for as long as it is open.
 *
 * It answers to the motions and the way out of the key table `views.md` gives
 * a view, and to nothing else yet; the rest of that table arrives with the
 * slice that adds it (`docs/plans/shuttle/build-sequence.md`). What the frame
 * offers along its bottom edge is what it answers to, so the two cannot part.
 *
 * It is a lens rather than a move (`docs/plans/shuttle/views.md`): opening one
 * changes no place, and `q` returns to the prompt exactly where it stood. What
 * it is a lens *onto* is a watch, and the two have different lifetimes — this
 * subscription is cancelled when the lens closes, and the watch's own goes on
 * firing (`watch.ts`).
 *
 * Everything here is a value and a decision about a value. The frame comes
 * back as lines and the keys arrive decoded, so a case drives the whole of it —
 * the scrolling, the rendering, and what each key does — with no terminal.
 * Where the lines land is the prompt's decision (`prompt.ts`), which is what
 * owns the keyboard while a lens is open.
 */

import { unicodeWidth } from "@std/cli/unicode-width";

import type { Key } from "../view/keys.ts";
import { marker, wrapped } from "./page.ts";
import { renderValue } from "./value.ts";
import { type Change, changesBetween, transitionFor } from "./watch.ts";

/** What the frame shows before the cell it watches has settled once. */
const NOT_SETTLED = marker("nothing has settled yet");

/**
 * What the bottom edge offers, which is every key this lens takes: the two
 * motions and the way out. The rest of the table `views.md` gives a view
 * arrives with the slice that adds it
 * (`docs/plans/shuttle/build-sequence.md`), and the edge grows with it — a
 * reader is offered what the frame answers to and nothing else.
 */
const KEYS = "q back (the watch stays armed) · j/k scroll · g/G ends";

/** The narrowest frame that has a column of its own to write in. */
const NARROWEST = 5;

/**
 * A lens onto one cell: what it shows, where it is scrolled to, and whether it
 * is still open.
 */
export class ValueLens {
  #label: string;
  #shown: readonly string[] = [NOT_SETTLED];
  #settled = false;
  #value: unknown;
  #changes: readonly Change[] | undefined;
  #top = 0;
  #repaint: (() => void) | undefined;
  #cancel: (() => void) | undefined;
  #closed = false;

  /**
   * Constructs an instance titled `label`, which is the cell it is a lens
   * onto written the way the prompt writes a place.
   */
  constructor(label: string) {
    this.#label = label;
  }

  /** Whether it is still open, which `q` and the end of the keys change. */
  get open(): boolean {
    return !this.#closed;
  }

  /** What the frame is titled: the cell this is a lens onto. */
  get label(): string {
    return this.#label;
  }

  /**
   * Draws through `repaint` from now until the lens closes, and draws once
   * immediately so that the frame is on screen before anything changes.
   */
  drawnThrough(repaint: () => void): void {
    this.#repaint = repaint;
    repaint();
  }

  /**
   * Takes `cancel` as what stops this lens's own subscription, and stops it at
   * once where the lens closed while it was being taken.
   *
   * The subscription is this lens's and no watch's, which is the whole of what
   * {@link ValueLens.close} promises: a lens closed leaves every armed watch
   * firing and stops exactly the sink that was drawing this frame.
   */
  holding(cancel: () => void): void {
    if (this.#closed) {
      cancel();
      return;
    }
    this.#cancel = cancel;
  }

  /**
   * Shows `value` as what the cell has settled at, and draws the frame again.
   *
   * One call per quiet runtime is the subscription's promise rather than this
   * one's (`sinkCellValue`, `lib/piece.ts`), so what this owes is that a call
   * costs one repaint: several intermediate values do not reach here to be
   * drawn, and each that does is drawn once.
   *
   * Where the scroll sits is kept across a change, so a value that grew while
   * a reader was partway down it leaves them where they were reading rather
   * than at the top.
   *
   * What changed is kept beside the value, so the frame shows the transition
   * rather than only what the value landed on — which is what makes a change
   * something a reader sees rather than infers. It says what the last change
   * was and stands until another replaces it: nothing here takes a row away on
   * a clock, so what a reader comes back to is the last thing that happened.
   *
   * The first settle is the value the cell already held, so it names no
   * change; neither does one that landed on the value already shown.
   */
  showing(value: unknown): void {
    if (this.#closed) return;
    const before = this.#value;
    const first = !this.#settled;
    this.#settled = true;
    this.#value = value;
    this.#shown = renderValue(value).split("\n");
    if (!first) {
      const changes = changesBetween(before, value);
      if (changes.length > 0) this.#changes = changes;
    }
    this.#repaint?.();
  }

  /**
   * Acts on `key`, drawing the frame again where it changed anything.
   *
   * The keys are the motions and the way out of views.md's table: `q` back,
   * `j`/`k` and the arrows one line, `g` and `G` the two ends. `ctrl-c` closes
   * as `q` does, because a full screen a person cannot get out of by the key
   * every terminal program answers is worse than one key too many.
   *
   * Everything else does nothing, and does nothing silently. That covers two
   * different keys and the silence suits both: one a view takes that this lens
   * has yet to grow — `enter`, `/`, `e`, `:` and the rest of that table, which
   * arrive with the slice that adds them
   * (`docs/plans/shuttle/build-sequence.md`) — and one nothing takes at all. A
   * frame offering only what it answers to is what tells a reader which is
   * which.
   */
  reads(key: Key): void {
    if (this.#closed) return;
    const name = key.name;
    if (name === "q" || name === "ctrl-c") {
      this.close();
      return;
    }
    const moved = this.#scrolled(name);
    if (moved) this.#repaint?.();
  }

  /**
   * Closes the lens: its own subscription is cancelled, and every armed watch
   * is left firing.
   *
   * Closing twice cancels once, so a lens closed by a key and then again by
   * the run ending needs no test in front of it.
   */
  close(): void {
    this.#closed = true;
    const cancel = this.#cancel;
    this.#cancel = undefined;
    cancel?.();
  }

  /**
   * The frame this draws on a terminal `rows` tall and `columns` wide: the top
   * edge naming the cell, the value under it, and the bottom edge saying which
   * keys it takes and how much of the value is on screen.
   *
   * The value is broken at the frame's own inner width rather than the
   * terminal's, so a line of it never runs past the right edge and every row
   * of the frame is the same width. That is also what makes the scroll
   * position a row of the screen rather than a line of the rendering, which is
   * what a reader moving by one expects.
   *
   * The row above the value says what the last change was, where there has
   * been one. It is not part of what scrolls — it is a fact about the cell
   * rather than a line of its value — so it stands wherever a reader has
   * scrolled to and costs the body one row.
   *
   * The frame is as tall as the terminal whatever the value is, its rows
   * filled out where the value does not reach the bottom: it is the screen
   * rather than a box on it, so the bottom edge stands where the screen ends
   * and a value that shrank leaves no rows of the one before it behind. A
   * frame with no room for a body is written all the same, as its two edges —
   * a terminal too short for a value is one a reader can still read the title
   * and the keys off.
   */
  frame(rows: number, columns: number): readonly string[] {
    const width = Math.max(columns, NARROWEST);
    const inner = width - 4;
    // What the two edges leave, which the transition row and the value share.
    const inside = Math.max(rows - 2, 0);
    // The transition is dropped where the edges leave no room rather than
    // added beyond it: a frame drawn taller than the screen scrolls its own
    // top row away, and that row is the one naming the cell being watched.
    // The two columns the marker's own brackets take come off the width the
    // transition is fitted to, so what stands in for a value too large to
    // write is decided against the room the row actually has.
    const moved = this.#changes === undefined || inside === 0
      ? []
      : [marker(transitionFor(this.#changes, Math.max(inner - 2, 1)))];
    const body = wrapped(this.#shown, inner);
    const room = inside - moved.length;
    const top = this.#clamped(body.length, room);
    const page = body.slice(top, top + room);
    const filled = [...moved, ...page, ...Array(room - page.length).fill("")];
    return [
      edge("┌", "┐", this.#label, width),
      ...filled.map((line) => `│ ${padded(fit(line, inner), inner)} │`),
      edge("└", "┘", KEYS, width, counted(top, page.length, body.length)),
    ];
  }

  /**
   * Helper for {@link ValueLens.reads}, which moves the scroll as `name` says
   * and is whether it named a motion.
   *
   * The bound is applied when the frame is drawn rather than here, because
   * only the frame knows how many rows the value takes: the same value is more
   * lines on a narrow terminal than on a wide one, and the position this holds
   * is the row a reader last moved to.
   */
  #scrolled(name: string): boolean {
    switch (name) {
      case "j":
      case "down":
        this.#top++;
        return true;
      case "k":
      case "up":
        this.#top = Math.max(this.#top - 1, 0);
        return true;
      case "g":
        this.#top = 0;
        return true;
      case "G":
        this.#top = Number.MAX_SAFE_INTEGER;
        return true;
      default:
        return false;
    }
  }

  /**
   * Helper for {@link ValueLens.frame}, which is the row the body starts at
   * where it holds `lines` and `room` of them fit.
   *
   * It is clamped rather than refused, so `G` on a value that then shrank
   * shows the end of what is there rather than an empty frame, and the
   * clamping is recorded so that a `k` after it moves from where the reader
   * is looking rather than from where they had scrolled to.
   */
  #clamped(lines: number, room: number): number {
    const last = Math.max(lines - room, 0);
    this.#top = Math.min(Math.max(this.#top, 0), last);
    return this.#top;
  }
}

/**
 * Helper for {@link ValueLens.frame}, which is an edge of the frame `columns`
 * wide: the corners, `left` beside the opening one, `right` beside the closing
 * one where there is one, and the rule that fills between them.
 *
 * Each text is cut to what is left rather than allowed to widen the frame,
 * because every row of a frame is the same width and a title that pushed one
 * out would leave the frame's right edge in two columns.
 *
 * The right-hand text is fitted first, so what a narrow terminal cuts is the
 * left: the right of an edge carries what the frame is doing now — how much of
 * a value is on screen — and the left carries a reminder of the keys, which is
 * the half a reader can do without.
 */
function edge(
  opening: string,
  closing: string,
  left: string,
  columns: number,
  right = "",
): string {
  const tail = fit(right, columns - 6);
  const framing = tail === "" ? 4 : 6;
  const room = Math.max(columns - framing - unicodeWidth(tail), 0);
  const shown = fit(left, room);
  const rule = "─".repeat(Math.max(room - unicodeWidth(shown), 0));
  return tail === ""
    ? `${opening} ${shown} ${rule}${closing}`
    : `${opening} ${shown} ${rule} ${tail} ${closing}`;
}

/**
 * Helper for {@link ValueLens.frame} and {@link edge}, which is as much of
 * `text` as `room` columns hold, and nothing where they hold none.
 *
 * The cut is by display width and at a character boundary, which is
 * {@link wrapped}'s (`page.ts`) — the one traversal every width in shuttle is
 * measured by, so a double-width character costs an edge what it costs a row.
 */
function fit(text: string, room: number): string {
  return room <= 0 || text === "" ? "" : wrapped([text], room)[0] ?? "";
}

/**
 * Helper for {@link ValueLens.frame}, which is `line` filled out to `inner`
 * columns, so that the frame's right edge stands in one column on every row.
 */
function padded(line: string, inner: number): string {
  return line + " ".repeat(Math.max(inner - unicodeWidth(line), 0));
}

/**
 * Helper for {@link ValueLens.frame}, which says which rows of the value are
 * on screen where they are not all of it, and says nothing where they are.
 *
 * Numbered from one, as a listing's handles are and for the same reason: this
 * is read off a screen by a person rather than indexed by a program.
 */
function counted(top: number, shown: number, lines: number): string {
  if (shown >= lines) return "";
  // A screen with no room between the edges shows no row at all, and a range
  // from the first to the one before it reads as a span running backwards.
  // What is left to say there is how much of the value is out of sight.
  if (shown === 0) return `0 of ${lines}`;
  return `${top + 1}-${top + shown} of ${lines}`;
}
