/**
 * Where the editor's changes come from and go back to. A view is editable only
 * when it has an underlying file (or set of files, for a diff); a pipe of
 * transformed output, or a diff that does not match any file on disk, is not.
 *
 * For a plain file the editable text IS the document text, so re-highlighting is
 * a re-parse and saving is a write. The diff source (in `diffedit.ts`) maps the
 * single editable text back onto the files it touches.
 */
import type { Document, Line } from "./model.ts";
import {
  createHighlighter,
  highlightDocument,
  type Highlighter,
  parseDocument,
} from "./parse.ts";
import { createMarkdownHighlighter, isMarkdownPath } from "./markdown.ts";

/** How much a revert restores: the cursor's hunk, the cursor's file, the commit
 * message the cursor is in, or all. */
export type RevertScope = "chunk" | "file" | "message" | "all";

/** The outcome of revealing more context (a diff only): the grown diff and its
 * matching grown baseline, where the cursor moves, and — so the pager can hold
 * its viewport and selection steady across the change — what moved where.
 *
 * `inserted` lines went in at `insertedAt`, a line of the pre-expansion text.
 * `up` tells which edge of the hunk they went in at: its top when they came from
 * above the hunk, its bottom when they came from below.
 *
 * `removedAt` is the `@@` header a join took out, also a line of the
 * pre-expansion text, or null when nothing joined. Revealing the last file line
 * between two hunks leaves them touching, and a header between lines that are
 * neighbours in the file describes nothing: the two become one hunk.
 *
 * So a line `n` of the pre-expansion text is afterwards at
 * `n + (n >= insertedAt ? inserted : 0) - (removedAt !== null && n > removedAt ?
 * 1 : 0)`, and the line at `removedAt` is gone. */
export interface ExpandResult {
  text: string;
  baseline: string;
  cursorLine: number;
  insertedAt: number;
  inserted: number;
  up: boolean;
  removedAt: number | null;
  /** Which lines of the workspace file the reveal showed, as the file numbers
   * them and counting from one: `from` to `to`, both ends included. */
  revealed: { from: number; to: number };
}

/** How much context a hunk can still reveal each way, and what stops it where it
 * cannot: `atFileTop` / `atFileBottom` say the hunk's range reaches the file's
 * first or last line, so a zero there is the file running out. A zero without
 * one is the neighbouring hunk butting against it, with nothing in between. */
export interface HunkRoom {
  up: number;
  down: number;
  atFileTop: boolean;
  atFileBottom: boolean;
}

export interface EditableSource {
  /** A short label for the editable target (the filename), or null. */
  readonly label: string | null;
  /** True for a diff view (whether or not it is editable), so the pager offers
   * file folding. Absent/false for a plain file or a non-diff pipe. */
  readonly isDiff?: boolean;
  /** False when there is no underlying file to edit. `reason` is shown when a
   * cursor move is attempted on a non-editable view. */
  readonly editable: boolean;
  readonly reason?: string;
  /** Re-parse edited text into a Document — lines, structure and definitions. */
  parse(text: string): Document;
  /** Re-highlight the edited text into rendered lines only (no structure tree),
   * for live highlighting on every keystroke. A fraction of a full {@link
   * parse}; the structure is refreshed separately when typing pauses. When
   * absent, the session falls back to a full parse. */
  highlight?(text: string): readonly Line[];
  /** Build an incremental highlighter seeded with `text`, for live highlighting
   * whose cost tracks the size of each edit rather than the whole document. The
   * session re-baselines it on the deferred re-parse. When present it is used in
   * preference to {@link highlight}. `seedLines` is the already-rendered colour
   * of `text` (the current document's lines): a source that cannot recompute a
   * line's colour cheaply on its own — a diff, whose colouring needs the
   * workspace files — reuses it for the unchanged lines so only edited lines are
   * recoloured. */
  createHighlighter?(
    text: string,
    seedLines?: readonly Line[],
  ): Highlighter;
  /** Persist the edited text. Returns a status message. Throws on I/O failure. */
  save(text: string): string;
  /** The labels (filenames) of the targets that differ between `original` and
   * `current` — what a save would actually write. A plain file is its one label
   * when changed; a diff reports just the files whose lines an edit touched, so
   * the quit prompt names them instead of every file the diff spans. Absent →
   * the caller falls back to the single {@link label}. */
  dirtyLabels?(original: string, current: string): string[];
  /** Restore part of the text to its `original` form: the hunk or file the
   * cursor (`cursorLine`) is in, or everything. Returns the new full text and
   * where to place the cursor, or null when there is nothing to revert at that
   * scope. A plain file reverts wholesale at any scope. */
  revert?(
    original: string,
    current: string,
    cursorLine: number,
    scope: RevertScope,
  ): { text: string; cursorLine: number } | null;
  /** Reveal more of the underlying file around the hunk `cursorLine` sits in (a
   * diff only). Returns the grown diff text, the matching grown baseline (so
   * revealing context is not itself an edit), and where the cursor moves — or
   * null when there is nothing to expand. `up` names the edge to grow, and the
   * call fails rather than growing the other one when that edge has run out;
   * without it the boundary nearest `cursorLine` grows, falling back to the
   * other. */
  expandContext?(
    current: string,
    baseline: string,
    cursorLine: number,
    up?: boolean,
  ): ExpandResult | null;
  /** How much context each hunk of `current` could still reveal, keyed by the
   * line its header sits on. The pager offers Ctrl-L only where the edge the
   * user is looking at has room, and says what stopped it where it has not. */
  expandRoom?(current: string): ReadonlyMap<number, HunkRoom>;
  /** Constrains where editing may happen. Present only for a diff, whose lines
   * map to fixed file lines: edits stay within a line, past the diff marker. A
   * plain file has no policy and is edited freely. */
  readonly policy?: EditPolicy;
  /** When an edited commit message (in `git show` output) differs from its
   * original and belongs to the HEAD commit, the commit whose message a save
   * would amend — for the confirmation prompt. Null when no such change is
   * pending. Absent on sources that never edit a commit message. */
  pendingAmend?(
    baseline: string,
    current: string,
  ): { sha: string; subject: string } | null;
  /** Amend the HEAD commit's message from the edited text, returning a status
   * line. Called only after the save has been confirmed. */
  amendCommit?(baseline: string, current: string): string;
  /** The path of the backing file, when there is a single one. The file picker
   * opens in its directory. */
  readonly path?: string;
}

/**
 * The editing constraints of a diff view. A line is editable past its marker
 * only when it is a context or added line inside a hunk whose new side matched
 * a file on disk — the change it would make can then be written back. Removed
 * lines, hunk/file headers, and any text that is not part of a savable hunk (a
 * commit-message preamble, an unverified hunk) are refused. Editability is
 * decided from the whole diff and the line's position, so it survives lines
 * being added or removed above it.
 */
export interface EditPolicy {
  /** The first editable column on the line at `row` (just past the diff marker,
   * or past a commit message's indent), or null when the line is not editable.
   * Takes the whole set of lines because editability depends on the row's
   * region. */
  editStart(lines: readonly string[], row: number): number | null;
  /** What the row at `row` belongs to: a diff hunk's new side (edited as a
   * removed/added pair), an editable commit message (edited as plain indented
   * text), or neither. Drives how the editor treats an edit there. */
  regionKind(lines: readonly string[], row: number): "hunk" | "message" | null;
  /** The marker a newly inserted line is given inside a hunk (a diff adds an
   * added line, so `"+"`), keeping the diff well-formed as the user adds lines.
   * A commit message uses its own indent instead. */
  readonly insertPrefix: string;
  /** The indent a new commit-message line is given (git's four spaces). */
  readonly messageIndent: string;
}

/** An on-disk file: the document text is the file, edits write straight back. */
export function fileSource(path: string): EditableSource {
  return {
    label: shortName(path),
    editable: true,
    path,
    parse: (text) => parseDocument(text, path),
    highlight: (text) => highlightDocument(text, path),
    createHighlighter: (text) =>
      isMarkdownPath(path)
        ? createMarkdownHighlighter(text)
        : createHighlighter(text, path),
    dirtyLabels: (original, current) =>
      original === current ? [] : [shortName(path)],
    // A plain file has no hunks, so any scope reverts the whole file.
    revert: (original, current, cursorLine) =>
      original === current ? null : {
        text: original,
        cursorLine: Math.min(cursorLine, original.split("\n").length - 1),
      },
    save: (text) => {
      Deno.writeTextFileSync(path, text);
      return `Saved ${shortName(path)}`;
    },
  };
}

/** A non-file view (a pipe / a diff matching nothing): readable, not editable. */
export function readonlySource(reason: string): EditableSource {
  return {
    label: null,
    editable: false,
    reason,
    parse: (text) => parseDocument(text),
    save: () => reason,
  };
}

export function shortName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
