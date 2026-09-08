/**
 * A watch: a subscription on one cell that outlives the view that opened it,
 * and the line each of its settled changes writes above the prompt.
 *
 * Two things live here and they are the same thing seen from either end. What
 * a watch *is* is a session object (decision 28,
 * `docs/plans/shuttle/README.md`) — armed by `watch`, listed by `watches`,
 * disarmed by `unwatch`, and unaffected by the lens that opened it closing.
 * What a watch *does* is turn each settled change into one line: the cell it
 * watches, where inside it the change landed, and the transition, so that a
 * reader sees the change rather than infers it from a new value.
 *
 * Nothing here subscribes. The subscription is `sinkCellValue`
 * (`lib/piece.ts`), which is where the guard-plus-`idle()` settling lives, and
 * a watch is handed the cancel it hands back. So every case drives the whole
 * of this with no connection: a settle is a call, and what a change writes is
 * a value.
 */

import { deepEqual, encodeJsonPointer } from "@commonfabric/runner";
import { unicodeWidth } from "@std/cli/unicode-width";

import type { Announce } from "./announce.ts";
import { oneLine } from "./listing.ts";
import { marker } from "./page.ts";
import {
  labelForPlace,
  type PathSegment,
  type PiecePlace,
  referenceForPlace,
} from "./place.ts";
import type { RecordEntry } from "./record.ts";

/** How many changes an event line writes out before it counts the rest. */
const NAMED_CHANGES = 3;

/** The cell a watch is armed on. */
export interface WatchTarget {
  /** Where the reference resolved, which is the cell itself. */
  readonly place: PiecePlace;

  /**
   * The piece's arguments cell rather than its result, which `#argument`
   * selects on the operand that armed the watch.
   */
  readonly input: boolean;
}

/**
 * One leaf that differs between two settled values: where it sits inside the
 * watched cell, and what it held either side of the change.
 */
export interface Change {
  /** The path inside the watched cell, empty for the cell itself. */
  readonly at: readonly PathSegment[];

  /** What the leaf held at the settle before this one. */
  readonly from: unknown;

  /** What it holds now. */
  readonly to: unknown;
}

/**
 * A watch armed on one cell.
 *
 * It holds what the cell last settled at, so that a change is reported as the
 * transition it is. That value is this object's and not the sink's: the sink
 * fires once on registration with what the cell already holds, and that first
 * settle is the baseline rather than a change — a watch that reported it
 * would announce a change nobody made every time one was armed.
 */
export class ArmedWatch {
  #target: WatchTarget;
  #label: string;
  #report: Announce;
  #columns: () => number;
  #cancel: (() => void) | undefined;
  #disarmed = false;
  #settled = false;
  #value: unknown;

  /**
   * Constructs an instance watching `target`, writing its changes through
   * `report` and fitting each line to what `columns` says the screen is.
   *
   * The width is a function rather than a number for the reason every other
   * screen measurement in shuttle is one: a change arrives long after the line
   * that armed the watch, and the window may have been resized in between.
   */
  constructor(
    target: WatchTarget,
    report: Announce,
    columns: () => number,
  ) {
    this.#target = target;
    this.#label = labelForPlace(target.place);
    this.#report = report;
    this.#columns = columns;
  }

  /**
   * What names this watch to a reader: the cell it watches, written the short
   * way the prompt writes the place it stands at.
   */
  get label(): string {
    return this.#label;
  }

  /**
   * What names this watch to shuttle: the complete reference of the cell it
   * watches, and which of the piece's two cells that is.
   *
   * It is the cell rather than the operand that armed the watch, so two
   * spellings of one cell are one watch and a second `watch` on either is
   * refused rather than doubling every line the first one writes.
   */
  get key(): string {
    return `${referenceForPlace(this.#target.place)}${
      this.#target.input ? "#argument" : ""
    }`;
  }

  /** The cell it watches, which is what a lens onto it subscribes to. */
  get target(): WatchTarget {
    return this.#target;
  }

  /** Whether it is still armed. */
  get armed(): boolean {
    return !this.#disarmed;
  }

  /**
   * Takes `cancel` as what stops the subscription, and stops it at once where
   * the watch was disarmed while it was being armed.
   *
   * The two-step is what the subscription's own shape asks for: arming is a
   * read, so the cancel exists only once that read has come back, and a line
   * cancelled in between is a line whose watch must not go on firing.
   */
  holding(cancel: () => void): void {
    if (this.#disarmed) {
      cancel();
      return;
    }
    this.#cancel = cancel;
  }

  /**
   * Records that the cell settled at `value`, writing the line that says what
   * changed where anything did.
   *
   * The first settle writes nothing and is the baseline. Every settle after it
   * is compared against the one before, so a settle the runtime made for
   * reasons of its own — a recomputation landing on the same value — writes
   * nothing either: what a reader is shown is a change, and a line saying `14
   * → 14` says none was made.
   */
  settled(value: unknown): void {
    if (this.#disarmed) return;
    const before = this.#value;
    const first = !this.#settled;
    this.#settled = true;
    this.#value = value;
    if (first) return;
    const changes = changesBetween(before, value);
    if (changes.length === 0) return;
    this.#report(eventLine(this.#label, changes, this.#columns()));
  }

  /**
   * Stops the subscription, after which nothing this watch is told is
   * reported.
   *
   * Disarming twice cancels once and is otherwise the same as disarming once,
   * so a watch disarmed by hand and then again by a run ending needs no test
   * in front of it.
   */
  disarm(): void {
    this.#disarmed = true;
    const cancel = this.#cancel;
    this.#cancel = undefined;
    cancel?.();
  }
}

/**
 * The watches dimension of the ambient record, as `where` prints it
 * (`record.ts`): what each armed watch is armed on, and the word for none.
 *
 * It names them rather than counting them, because what a person asks `where`
 * is what this process is doing and a count says only how much of it. The
 * names are the same short form the prompt carries, so a watch reads the same
 * way here, in the `watches` listing, and on every line it writes.
 */
export function watchEntries(
  armed: readonly ArmedWatch[],
): readonly RecordEntry[] {
  return [{
    label: "watches",
    value: armed.length === 0
      ? "none"
      : armed.map((watch) => oneLine(watch.label)).join(", "),
  }];
}

/**
 * The leaves at which `before` and `after` differ, each with the transition it
 * made.
 *
 * A walk rather than a comparison of the two values, because what a reader
 * wants to see is where the change landed: a piece whose result is twenty
 * fields writes one line naming the one that moved, not two renderings of the
 * whole result. The walk descends wherever both sides are the same kind of
 * container and stops everywhere else, so a value that became an object is one
 * change rather than a change per key it gained.
 *
 * A key one side holds and the other does not is a change to or from
 * `undefined`, which is what a cell reads as at a key it does not hold.
 */
export function changesBetween(
  before: unknown,
  after: unknown,
): readonly Change[] {
  const found: Change[] = [];
  walk([], before, after, found);
  return found;
}

/**
 * Helper for {@link changesBetween}, which collects into `found` the leaves
 * below `at` at which `before` and `after` differ.
 */
function walk(
  at: readonly PathSegment[],
  before: unknown,
  after: unknown,
  found: Change[],
): void {
  if (deepEqual(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    for (
      let index = 0;
      index < Math.max(before.length, after.length);
      index++
    ) {
      walk([...at, index], before[index], after[index], found);
    }
    return;
  }
  if (isKeyed(before) && isKeyed(after)) {
    for (
      const key of new Set([...Object.keys(before), ...Object.keys(after)])
    ) {
      walk([...at, key], before[key], after[key], found);
    }
    return;
  }
  found.push({ at, from: before, to: after });
}

/**
 * Helper for {@link walk}, which is whether `value` is a thing with keys to
 * descend through.
 *
 * An array is ruled out here as well as answered by the arm above it, and the
 * two are not the same claim. The arm above pairs two arrays and walks their
 * indices; this is what stops an array being paired with an object, which
 * would walk one against the other's keys and report every member of it as a
 * change under a name it does not have. An array that became an object is one
 * change, which is what a reader is owed.
 */
function isKeyed(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The line a watch called `label` writes for `changes`, fitted to a terminal
 * `columns` wide.
 *
 * One line per settled change, whatever the change turns out to be, because a
 * settle is what a reader is being told about: several leaves that moved
 * together moved in one commit, and two lines would read as two.
 *
 * Every change on the line carries its transition, which is what a reader is
 * being shown: a line naming where something moved and not what it moved to
 * says less than the value it replaced would have. Where several moved, the
 * first few are written and the rest counted, so the line's length follows the
 * shape of the data rather than the size of the commit.
 *
 * The fitting is a fallback rather than a truncation, and it has two rungs
 * because two different things can make a line too wide. A value the fabric
 * holds is as large as the fabric lets it be, so where the values do not fit
 * each is stood in for by what it is; and where the changes still do not fit,
 * a line naming several of them gives their count instead, which is the one
 * thing that stays short however many there are. A single change never reaches
 * that rung: what the count replaces is the list, and a list of one has
 * nothing to gain from being counted.
 */
export function eventLine(
  label: string,
  changes: readonly Change[],
  columns: number,
): string {
  return fitted(`watch ${oneLine(label)}:`, changes, columns);
}

/**
 * What `changes` say on their own, fitted to `columns`, which is what a lens
 * writes above the value it is showing.
 *
 * It is {@link eventLine} without the watch that wrote it, because the frame
 * around it already names the cell: a lens onto one cell saying that cell's
 * name over every change would be saying it twice.
 */
export function transitionFor(
  changes: readonly Change[],
  columns: number,
): string {
  return fitted("", changes, columns);
}

/** How much of a value a transition on the line writes out. */
type Detail =
  /** The value itself, as JSON. */
  | "value"
  /** What the value is, for a line the value itself will not fit on. */
  | "kind";

/**
 * Helper for the two above, which is `changes` written after `opening` at the
 * most a line `columns` wide has room for.
 *
 * The rungs are tried in order and the first that fits is the answer, so a
 * line is as full as the screen allows rather than as short as the widest case
 * would need.
 */
function fitted(
  opening: string,
  changes: readonly Change[],
  columns: number,
): string {
  const values = written(opening, changes, "value");
  if (unicodeWidth(values) <= columns) return values;
  const kinds = written(opening, changes, "kind");
  if (unicodeWidth(kinds) <= columns || changes.length === 1) return kinds;
  return `${after(opening)}${changes.length} changes`;
}

/**
 * Helper for {@link fitted}, which writes `changes` after `opening` with each
 * value written at `detail`, the first {@link NAMED_CHANGES} of them written
 * out and the rest counted.
 */
function written(
  opening: string,
  changes: readonly Change[],
  detail: Detail,
): string {
  const alone = changes.length === 1;
  const named = changes.slice(0, NAMED_CHANGES).map((change) =>
    transition(change, detail, alone)
  );
  const left = changes.length - named.length;
  return `${after(opening)}${named.join("; ")}${
    left === 0 ? "" : `; and ${left} more`
  }`;
}

/**
 * Helper for {@link fitted} and {@link written}, which is `opening` with the
 * space that separates it from what follows, and nothing where there is no
 * opening.
 */
function after(opening: string): string {
  return opening === "" ? "" : `${opening} `;
}

/**
 * Helper for {@link written}, which is one change written as where it landed
 * and the transition it made, `alone` saying it is the only one on the line.
 *
 * A change at the watched cell itself has no path to name. Alone on a line it
 * is written without one, the frame or the watch's own name having said which
 * cell it is; beside others it is named by what it is, since a line listing it
 * next to two that have paths would otherwise leave a gap where a name should
 * be.
 */
function transition(
  change: Change,
  detail: Detail,
  alone: boolean,
): string {
  const path = pathOf(change.at);
  const where = path !== ""
    ? `${oneLine(path)} `
    : alone
    ? ""
    : `${marker("the cell itself")} `;
  return `${where}${shown(change.from, detail)} → ${shown(change.to, detail)}`;
}

/**
 * Helper for {@link transition}, which is `at` written as a path inside the
 * watched cell, and the empty string for the cell itself.
 *
 * The separator is escaped in every segment, as it is everywhere else shuttle
 * writes a path, so a key holding one is one segment here too.
 */
function pathOf(at: readonly PathSegment[]): string {
  return encodeJsonPointer(at.map(String));
}

/**
 * Helper for {@link transition}, which is `value` written on a line: as JSON
 * at the `value` detail, and as what it is at the `kind` one.
 *
 * `undefined` is stood in for either way, JSON having no form for it and the
 * word for what a cell holds nothing at being what a reader needs — the same
 * division `renderValue` (`value.ts`) makes for the same value. So is anything
 * else the writer declines or throws on, a `bigint` among them: this line is
 * prose about a change rather than the value itself, and `get` is what reads
 * one out.
 */
function shown(value: unknown, detail: Detail): string {
  if (detail === "kind" || value === undefined) {
    return marker(describeValue(value));
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? marker(describeValue(value)) : oneLine(json);
  } catch {
    return marker(describeValue(value));
  }
}

/**
 * Helper for {@link shown}, which is what `value` is, for a line that is not
 * writing it out.
 *
 * It names the kind and the size where the size is what a reader is deciding
 * on — how long a string is, how many members an array has — because what the
 * `kind` detail is for is a value too large to write, and its size is the fact
 * that put it there.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === "object") return "an object";
  if (typeof value === "string") {
    return `a string of ${[...value].length} characters`;
  }
  return `a ${typeof value}`;
}
