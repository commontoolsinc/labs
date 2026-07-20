/**
 * Pure renderer: maps a {@link Document} plus the current {@link ViewState} to
 * an array of terminal rows (ANSI strings). Holds no terminal state and writes
 * nothing — the pager owns I/O — which keeps every frame snapshot testable.
 *
 * Composition is cell-based: each visible content row is built as an array of
 * (char, style) cells so overlays layer with a clear precedence
 * (search match > node selection > schema/closure region tint > token colour),
 * then run-length encoded into ANSI. Horizontal scrolling, the line-number
 * gutter and the structure guide bar are all column maths over that grid.
 */
import { cpLen, paint, RESET, type Style } from "./ansi.ts";
import type { Document, Line, StructureNode } from "./model.ts";
import {
  type DisplayCell,
  displayLine,
  type DisplayMode,
  glyphFor,
} from "./display.ts";
import { overlaySpanStyle, spanStyle } from "./highlight.ts";
import { lineBg, ui } from "./theme.ts";
import {
  buildWrapPlan,
  fitWrapChrome,
  type WrappedRow,
  wrappedRowAt,
  type WrapPlan,
} from "./wrap.ts";

/** A key suggestion for the status line: the key (already capitalised for
 * display, e.g. `Q`, `^X^S`, `WASD`) and what it does. Drawn Turbo-Pascal style,
 * the key highlighted and the label plain. */
export interface KeyHint {
  readonly key: string;
  readonly label: string;
}

export interface ViewState {
  top: number;
  left: number;
  width: number;
  height: number;
  color: boolean;
  showLineNumbers: boolean;
  /** Whether long logical lines continue on later screen rows. */
  wrapLines: boolean;
  /** A precomputed wrapping layout for `doc`, when the session has one. */
  wrapPlan?: WrapPlan | null;
  /** The number to show in the gutter on each display row, or null there for a
   * blank gutter. Absent → the legacy 1-based display-row number. Only consulted
   * when `showLineNumbers` is set. */
  lineNumbers?: readonly (number | null)[] | null;
  /** How the non-printable characters in the content are shown. */
  displayMode: DisplayMode;
  /** The selected structure node (WASD navigation), or null. */
  selected: StructureNode | null;
  /** All search matches, document-ordered; null when no active search. */
  matches: readonly Match[] | null;
  /** Index into `matches` of the focused match. */
  currentMatch: number;
  /** Transient status text (e.g. "Pattern not found"). */
  message: string;
  /** Command/search input line, e.g. "/token"; null in normal mode. */
  inputLine: string | null;
  overlay: OverlayState | null;
  /** A modal prompt drawn as a centred Turbo Vision dialog (the save, revert and
   * amend confirmations). Covers the content like an overlay; the two never
   * coexist. */
  dialog?: DialogState | null;
  /** The text cursor, in document coordinates (line + display column), when
   * edit mode has it visible. The pager positions the real terminal cursor. */
  cursor?: { line: number; col: number } | null;
  /** Edit-mode key hints, shown on the status line in place of the navigation
   * help while the text cursor is active. */
  editHint?: readonly KeyHint[] | null;
  /** Whether Ctrl-L can reveal more context here (a diff), so the navigation
   * help advertises it. */
  canExpand?: boolean;
  /** Whether the view is editable, so the navigation help advertises `e`. */
  canEdit?: boolean;
  /** Whether the content holds non-printable characters, so the navigation help
   * advertises the display-mode key `C`. */
  hasNonPrintables?: boolean;
  /** Lines shown just above the status/prompt bar (e.g. the list of files an
   * edited diff would save), overwriting the bottom content rows. */
  notice?: readonly string[] | null;
  /** The file currently in view — the diff file or source under the viewport, or
   * the file being edited — shown on the right of the status bar. Null when
   * there is none (a bare pipe). */
  currentFile?: string | null;
}

/** The line-number gutter width: 0 when off, else wide enough for the largest
 * number it shows (in "file" mode a diff line's file number can exceed the
 * number of lines the diff spans). */
function gutterWidth(doc: Document, view: ViewState): number {
  if (!view.showLineNumbers) return 0;
  const max = view.lineNumbers
    ? view.lineNumbers.reduce<number>((m, n) => n !== null && n > m ? n : m, 0)
    : doc.lines.length;
  return Math.max(4, String(Math.max(1, max)).length + 1);
}

/** Layout widths the content area is laid out with, for cursor placement. */
function layout(
  doc: Document,
  view: ViewState,
): { gutterWidth: number; guideWidth: number } {
  const requested = {
    gutterWidth: gutterWidth(doc, view),
    guideWidth: view.selected ? 1 : 0,
  };
  return view.wrapLines
    ? fitWrapChrome(view.width, requested.gutterWidth, requested.guideWidth)
    : requested;
}

/**
 * 1-based terminal (row, col) for the text cursor, or null when there is no
 * cursor, it is scrolled off screen, or an overlay or dialog covers the content.
 * Mirrors the layout `renderFrame` uses, including a wrapped continuation's
 * screen row and display-column offset.
 */
export function cursorScreenPos(
  doc: Document,
  view: ViewState,
): { row: number; col: number } | null {
  if (!view.cursor || view.overlay || view.dialog) return null;
  const { line, col } = view.cursor;
  if (line < 0 || line >= doc.lines.length) return null;
  const { gutterWidth, guideWidth } = layout(doc, view);
  const contentWidth = Math.max(1, view.width - gutterWidth - guideWidth);
  let screenLine = line;
  let contentCol = col - view.left;
  if (view.wrapLines) {
    const plan = view.wrapPlan ??
      buildWrapPlan(doc.lines, view.displayMode, contentWidth);
    const first = plan.firstRow[line];
    const last = plan.lastRow[line];
    screenLine = Math.min(first + Math.floor(col / plan.rowStride), last);
    const rowOffset = (screenLine - first) * plan.rowStride;
    contentCol = col - rowOffset;
  }
  const contentHeight = view.height - 1;
  const r = screenLine - view.top;
  if (r < 0 || r >= contentHeight) return null;
  if (contentCol < 0 || contentCol >= contentWidth) return null;
  return { row: r + 1, col: gutterWidth + guideWidth + contentCol + 1 };
}

export interface Match {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

export interface OverlayState {
  readonly title: string;
  readonly lines: readonly Line[];
  readonly scroll: number;
  readonly footer: string;
  /** Index into `lines` of the selected (highlighted) reference, if any. */
  readonly selectedLine?: number;
  /** The overlay shows source code, so it is drawn as a blue editor window
   * rather than a grey dialog. */
  readonly sourceView?: boolean;
}

/** A push-button in a modal dialog. Its {@link kind} sets where the Tab focus
 * starts ("default") and which button Esc activates ("cancel"); its first letter
 * matching {@link hotkey} is drawn highlighted and activates it directly. */
export interface DialogButton {
  readonly label: string;
  readonly hotkey: string;
  readonly kind?: "default" | "cancel" | "normal";
}

/** A centred modal prompt: a title, one or more body lines, and a button row. */
export interface DialogState {
  readonly title: string;
  readonly body: readonly string[];
  readonly buttons: readonly DialogButton[];
  /** Index of the focused button — the one Space and Enter activate, drawn
   * highlighted. When absent, the default button (if any) is highlighted. */
  readonly focus?: number;
  /** Index of a button drawn mid-press: shifted one column right with its
   * shadow hidden, for the brief animation after it is activated. */
  readonly pushed?: number;
}

interface Cell {
  ch: string;
  style: Style;
}

const EMPTY_STYLE: Style = {};

interface LineMatches {
  readonly matches: readonly Match[];
  readonly from: number;
  readonly to: number;
  readonly currentIndex: number;
  blockPrefixMaxEnd?: Float64Array;
}

const MATCH_BLOCK_SIZE = 64;

/** The contiguous slice of document-ordered matches on one visible line. */
function matchesOnLine(
  view: ViewState,
  line: number,
): LineMatches | null {
  const matches = view.matches;
  if (!matches || matches.length === 0) return null;
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].line < line) lo = mid + 1;
    else hi = mid;
  }
  const from = lo;
  if (matches[from]?.line !== line) return null;
  hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].line <= line) lo = mid + 1;
    else hi = mid;
  }
  const to = lo;
  const currentIndex = view.currentMatch >= from && view.currentMatch < to
    ? view.currentMatch
    : -1;
  return { matches, from, to, currentIndex };
}

/** Render a complete frame: exactly `view.height` rows. */
export function renderFrame(doc: Document, view: ViewState): string[] {
  const rows: string[] = [];
  const contentHeight = view.height - 1;
  const { gutterWidth: gw, guideWidth } = layout(doc, view);
  const contentWidth = Math.max(1, view.width - gw - guideWidth);
  const wrapPlan = view.wrapLines
    ? view.wrapPlan ?? buildWrapPlan(doc.lines, view.displayMode, contentWidth)
    : null;
  const rowStride = wrapPlan?.rowStride ?? contentWidth;
  let displayedLine = -1;
  let displayedCells: readonly DisplayCell[] | undefined;
  let displayedSelection: SelectionSpan | null = null;
  let displayedMatches: LineMatches | null = null;

  for (let r = 0; r < contentHeight; r++) {
    const rowIdx = view.top + r;
    const wrappedRow: WrappedRow | undefined = wrapPlan
      ? wrappedRowAt(wrapPlan, rowIdx)
      : { line: rowIdx, offset: view.left, lastOffset: view.left };
    const firstOfLine = !wrapPlan || wrappedRow === undefined ||
      wrapPlan.firstRow[wrappedRow.line] === rowIdx;
    if (wrappedRow && wrappedRow.line !== displayedLine) {
      displayedLine = wrappedRow.line;
      const line = doc.lines[displayedLine];
      displayedCells = line ? displayLine(line, view.displayMode) : undefined;
      displayedSelection = selectionSpan(view, displayedLine, line);
      displayedMatches = view.color ? matchesOnLine(view, displayedLine) : null;
    } else if (!wrappedRow) {
      displayedCells = undefined;
      displayedSelection = null;
      displayedMatches = null;
    }
    rows.push(
      renderContentRow(
        doc,
        view,
        wrappedRow,
        displayedCells,
        displayedSelection,
        displayedMatches,
        firstOfLine,
        gw,
        guideWidth,
        contentWidth,
        rowStride,
      ),
    );
  }
  rows.push(renderStatus(doc, view, wrapPlan));

  if (view.notice && view.notice.length > 0) {
    const start = Math.max(0, contentHeight - view.notice.length);
    for (let i = 0; start + i < contentHeight; i++) {
      rows[start + i] = paintIf(
        padTo(view.notice[i] ?? "", view.width),
        ui.noticeBar,
        view.color,
      );
    }
  }

  if (view.overlay) applyOverlay(rows, view, view.overlay);
  if (view.dialog) applyDialog(rows, view, view.dialog);
  return rows;
}

function renderContentRow(
  doc: Document,
  view: ViewState,
  row: WrappedRow | undefined,
  display: readonly DisplayCell[] | undefined,
  selection: SelectionSpan | null,
  matches: LineMatches | null,
  firstOfLine: boolean,
  gutterWidth: number,
  guideWidth: number,
  contentWidth: number,
  rowStride: number,
): string {
  const lineIdx = row?.line ?? -1;
  const line: Line | undefined = doc.lines[lineIdx];
  const inSelRange = !!view.selected &&
    lineIdx >= view.selected.startLine && lineIdx <= view.selected.endLine;

  let gutter = "";
  if (gutterWidth > 0) {
    const num = !firstOfLine
      ? null
      : view.lineNumbers
      ? view.lineNumbers[lineIdx] ?? null
      : (line ? lineIdx + 1 : null);
    const label = num !== null ? String(num) : "";
    const style = inSelRange ? ui.lineNumberCurrent : ui.lineNumber;
    gutter = paintIf(label.padStart(gutterWidth - 1) + " ", style, view.color);
  }

  let guide = "";
  if (guideWidth > 0) {
    // guideWidth > 0 only when view.selected is set (see guideWidth above).
    guide = paintIf(
      view.wrapLines
        ? wrappedGuideChar(
          view.selected!,
          lineIdx,
          line,
          row?.offset ?? 0,
          rowStride,
          row?.lastOffset ?? 0,
          selection,
          display,
        )
        : guideChar(view.selected!, lineIdx),
      ui.guide,
      view.color,
    );
  }

  const content = composeContent(
    line,
    view,
    row?.offset ?? 0,
    contentWidth,
    selection,
    display,
    matches,
    row !== undefined && row.offset < row.lastOffset,
  );
  return gutter + guide + content;
}

function guideChar(
  selected: StructureNode,
  lineIdx: number,
): string {
  if (lineIdx < selected.startLine || lineIdx > selected.endLine) return " ";
  if (selected.startLine === selected.endLine) return "▶";
  if (lineIdx === selected.startLine) return "╭";
  if (lineIdx === selected.endLine) return "╰";
  return "│";
}

/** Guide character for a selected node on one wrapped continuation row. */
function wrappedGuideChar(
  selected: StructureNode,
  lineIdx: number,
  line: Line | undefined,
  offset: number,
  stride: number,
  lastOffset: number,
  span: SelectionSpan | null,
  display: readonly DisplayCell[] | undefined,
): string {
  if (lineIdx < selected.startLine || lineIdx > selected.endLine || !line) {
    return " ";
  }
  const bounds = selectionRowBounds(
    span,
    display ?? [],
    stride,
    lastOffset,
  );
  if (offset < bounds.first || offset > bounds.last) return " ";
  const first = lineIdx === selected.startLine && offset === bounds.first;
  const last = lineIdx === selected.endLine && offset === bounds.last;
  if (first && last) return "▶";
  if (first) return "╭";
  if (last) return "╰";
  return "│";
}

function selectionRowBounds(
  span: SelectionSpan | null,
  display: readonly DisplayCell[],
  stride: number,
  lastOffset: number,
): { first: number; last: number } {
  if (display.length === 0) return { first: 0, last: 0 };
  const lo = span ? displayIndexAtOrAfter(display, span.lo) : 0;
  const hi = span ? displayIndexAtOrAfter(display, span.hi) : display.length;
  const firstCell = Math.min(lo, display.length - 1);
  const lastCell = Math.max(firstCell, hi - 1);
  return {
    first: Math.min(Math.floor(firstCell / stride) * stride, lastOffset),
    last: Math.min(Math.floor(lastCell / stride) * stride, lastOffset),
  };
}

function displayIndexAtOrAfter(
  display: readonly DisplayCell[],
  sourceCol: number,
): number {
  let lo = 0;
  let hi = display.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (display[mid].col < sourceCol) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface SelectionSpan {
  lo: number;
  hi: number;
  bg: Style;
}

/**
 * Column range to tint for the selected node on `lineIdx`, or null. Covers only
 * the node's actual extent — its character span on this line, extended over
 * leading indentation and trailing whitespace but not the rest of the line.
 */
function selectionSpan(
  view: ViewState,
  lineIdx: number,
  line: Line | undefined,
): SelectionSpan | null {
  const sel = view.selected;
  if (!sel) return null;
  if (lineIdx < sel.startLine || lineIdx > sel.endLine) return null;
  const text = line ? line.text : "";
  const lineLen = cpLen(text);
  let lo = lineIdx === sel.startLine ? sel.startCol : 0;
  let hi = lineIdx === sel.endLine ? sel.endCol : lineLen;
  lo = Math.max(0, Math.min(lo, lineLen));
  hi = Math.max(0, Math.min(hi, lineLen));
  if (lo > 0 && codePointRangeIsWhitespace(text, 0, lo)) lo = 0;
  if (hi < lineLen && codePointRangeIsWhitespace(text, hi, lineLen)) {
    hi = lineLen;
  }
  if (hi <= lo) return null;
  const bg: Style = sel.kind === "schema"
    ? { bg: ui.schemaRegionBg }
    : sel.kind === "closure"
    ? { bg: ui.closureRegionBg }
    : { bg: ui.selectionBg };
  return { lo, hi, bg };
}

function codePointRangeIsWhitespace(
  text: string,
  from: number,
  to: number,
): boolean {
  let col = 0;
  for (const codePoint of text) {
    if (col >= to) break;
    if (col >= from && codePoint.trim() !== "") return false;
    col++;
  }
  return true;
}

function composeContent(
  line: Line | undefined,
  view: ViewState,
  offset: number,
  width: number,
  sel: SelectionSpan | null,
  display: readonly DisplayCell[] | undefined,
  lineMatches: LineMatches | null,
  continues: boolean,
): string {
  const { color } = view;
  // Every content cell sits on the blue editor background; a diff line carries a
  // full-row add/removed tint instead. Syntax colours paint on top, and the
  // selection background still wins inside its range.
  const rowBg: Style = color
    ? { bg: line?.bg ? lineBg(line.bg) : ui.editorBg }
    : EMPTY_STYLE;
  const cells: Cell[] = new Array(width);
  for (let i = 0; i < width; i++) cells[i] = { ch: " ", style: rowBg };
  const showWrapMarker = continues && width > 1;
  const sourceWidth = showWrapMarker ? width - 1 : width;

  if (line && display) {
    // The display list may hold fewer cells than the line has code points —
    // ANSI sequences are hidden and runs of control codes collapse — so cells
    // are placed by their position in this list, not by their source column.
    // Each cell still knows the source column it stands for, which is what the
    // selection and search ranges are stated in.
    const end = Math.min(display.length, offset + sourceWidth);
    for (let d = offset; d < end; d++) {
      const idx = d - offset;
      const dc = display[d];
      let style: Style;
      if (!color) {
        style = EMPTY_STYLE;
      } else {
        const hit = lineMatches ? matchStyle(lineMatches, dc.col) : null;
        if (hit) {
          style = hit;
        } else {
          const base = mergeBg(dc.ansi ?? dc.syntax, rowBg);
          const inSel = sel !== null && dc.col >= sel.lo && dc.col < sel.hi;
          style = inSel ? mergeBg(base, sel.bg) : base;
        }
      }
      cells[idx] = { ch: dc.ch, style };
    }
  }

  if (showWrapMarker) {
    cells[width - 1] = {
      ch: "\\",
      style: color ? mergeBg(ui.wrapMarker, rowBg) : EMPTY_STYLE,
    };
  }

  return cellsToAnsi(cells, color);
}

/** The search-match style for a cell at source column `col`, or null when the
 * column is in no match. The focused match wins over an ordinary one. */
function matchStyle(
  line: LineMatches,
  col: number,
): Style | null {
  const { matches, from, to, currentIndex } = line;
  const current = matches[currentIndex];
  if (current && col >= current.start && col < current.end) {
    return ui.searchCurrent;
  }
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].start <= col) lo = mid + 1;
    else hi = mid;
  }
  const candidate = lo - 1;
  if (candidate < from) return null;
  const relative = candidate - from;
  const block = Math.floor(relative / MATCH_BLOCK_SIZE);
  const blockStart = from + block * MATCH_BLOCK_SIZE;
  for (let i = candidate; i >= blockStart; i--) {
    if (col < matches[i].end) return ui.searchMatch;
  }
  if (block === 0) return null;
  const prefix = line.blockPrefixMaxEnd ??= matchBlockPrefix(line);
  return prefix[block - 1] > col ? ui.searchMatch : null;
}

/** Largest match end through each fixed-size block of one logical line. */
function matchBlockPrefix(line: LineMatches): Float64Array {
  const { matches, from, to } = line;
  const blocks = Math.ceil((to - from) / MATCH_BLOCK_SIZE);
  const prefix = new Float64Array(blocks);
  let maxEnd = -Infinity;
  for (let i = from; i < to; i++) {
    maxEnd = Math.max(maxEnd, matches[i].end);
    const relative = i - from;
    if (
      relative % MATCH_BLOCK_SIZE === MATCH_BLOCK_SIZE - 1 || i === to - 1
    ) {
      prefix[Math.floor(relative / MATCH_BLOCK_SIZE)] = maxEnd;
    }
  }
  return prefix;
}

function renderStatus(
  doc: Document,
  view: ViewState,
  wrapPlan: WrapPlan | null,
): string {
  if (view.inputLine !== null) {
    return view.color
      ? paint(padTo(view.inputLine, view.width), ui.statusBar)
      : padTo(view.inputLine, view.width);
  }
  const total = doc.lines.length;
  const rowCount = wrapPlan?.rowCount ?? total;
  const lastRow = Math.min(
    Math.max(0, rowCount - 1),
    view.top + view.height - 2,
  );
  const first = total === 0
    ? 0
    : wrapPlan
    ? (wrappedRowAt(wrapPlan, view.top)?.line ?? 0) + 1
    : Math.min(total, view.top + 1);
  const last = total === 0
    ? 0
    : wrapPlan
    ? (wrappedRowAt(wrapPlan, lastRow)?.line ?? 0) + 1
    : Math.min(total, lastRow + 1);
  const pct = rowCount <= 1
    ? 100
    : Math.round((view.top / (rowCount - 1)) * 100);
  const atEnd = view.top + view.height - 1 >= rowCount;

  // The left of the bar is either a message / selected-node label (plain text)
  // or a row of key hints (keys highlighted, Turbo Pascal style).
  let hints: readonly KeyHint[] | null = null;
  let text = "";
  if (view.dialog) {
    // A modal prompt owns every key, so the bar shows its buttons rather than
    // the navigation hints, which are inert while the dialog is up.
    hints = view.dialog.buttons.map((b) => ({
      key: b.hotkey.toUpperCase(),
      label: b.label,
    }));
  } else if (view.message) {
    text = view.message;
  } else if (view.editHint) {
    hints = view.editHint;
  } else if (view.selected) {
    text = `${kindGlyph(view.selected.kind)} ${view.selected.label}`;
  } else {
    hints = browseHints(view);
  }

  const pos = view.matches && view.matches.length > 0
    ? `match ${view.currentMatch + 1}/${view.matches.length}  ${
      lineInfo(first, last, total, pct, atEnd)
    }`
    : lineInfo(first, last, total, pct, atEnd);

  // The right of the bar carries the current file (bold) then the position; the
  // file is capped so it never crowds out the position or the left hints.
  const fileMax = Math.max(8, Math.floor(view.width / 2) - visibleLen(pos) - 2);
  const file = view.currentFile
    ? truncate(showControls(view.currentFile), fileMax, false)
    : "";
  const rightPlain = file ? `${file}  ${pos}` : pos;
  const rightW = visibleLen(rightPlain);

  // The left is truncated to whatever space the right leaves it.
  const leftBudget = Math.max(0, view.width - rightW - 2);
  const leftHints = hints ? fitHints(hints, leftBudget) : null;
  const leftPlain = leftHints
    ? hintsPlain(leftHints)
    : truncate(text, leftBudget, true);

  if (!view.color) {
    return padTo(`${leftPlain}  ${rightPlain}`, view.width);
  }
  const leftAnsi = leftHints
    ? hintsAnsi(leftHints)
    : paint(leftPlain, ui.statusBar);
  const rightAnsi =
    (file ? paint(file, ui.statusFile) + paint("  ", ui.statusBar) : "") +
    paint(pos, ui.statusBar);
  const leftW = visibleLen(leftPlain);
  const space = Math.max(1, view.width - leftW - rightW);
  const line = leftAnsi + paint(" ".repeat(space), ui.statusBar) + rightAnsi;
  const pad = view.width - (leftW + space + rightW);
  return pad > 0 ? line + paint(" ".repeat(pad), ui.statusBar) : line;
}

/** Keep the leading key hints that fit within `budget` visible columns. */
function fitHints(
  hints: readonly KeyHint[],
  budget: number,
): readonly KeyHint[] {
  const out: KeyHint[] = [];
  for (const h of hints) {
    if (visibleLen(hintsPlain([...out, h])) > budget) break;
    out.push(h);
  }
  return out;
}

/** Replace the control characters in `text` with their Control Pictures glyphs,
 * the same substitution the content rows use. This is applied to the strings
 * that reach the terminal outside `displayLine` — the status bar's file name and
 * the dialog body — which can carry a file name a user chose. One code point in
 * gives one code point out, so the callers' width arithmetic is unchanged. */
function showControls(text: string): string {
  let out = "";
  for (const cp of text) out += glyphFor(cp);
  return out;
}

/** Truncate `text` to `max` columns with an ellipsis. `dropTail` keeps the head
 * (a trailing `…`); otherwise it keeps the tail (a leading `…`, for a path whose
 * file name matters most). */
function truncate(text: string, max: number, dropTail: boolean): string {
  const cps = [...text];
  if (cps.length <= max) return text;
  if (max <= 1) return "…";
  return dropTail
    ? cps.slice(0, max - 1).join("") + "…"
    : "…" + cps.slice(cps.length - (max - 1)).join("");
}

/** The default browsing key hints, in priority order (most important first) so
 * that {@link fitHints} drops the least important when the bar runs short of
 * room. The conditional keys appear only where they would do something. */
function browseHints(view: ViewState): KeyHint[] {
  const hints: KeyHint[] = [
    { key: "?", label: "Help" },
    { key: "Q", label: "Quit" },
    { key: "/", label: "Search" },
    { key: "WASD", label: "Tree" },
  ];
  if (view.canExpand) hints.push({ key: "^L", label: "Expand" });
  if (view.canEdit) hints.push({ key: "e", label: "Edit" });
  if (view.hasNonPrintables) hints.push({ key: "C", label: "Chars" });
  hints.push({ key: "\\", label: view.wrapLines ? "Unwrap" : "Wrap" });
  hints.push({ key: "#", label: "Lines" });
  return hints;
}

/** `key label  key label …` as plain text, for the monochrome bar and widths. */
function hintsPlain(hints: readonly KeyHint[]): string {
  return hints.map((h) => `${h.key} ${h.label}`).join("  ");
}

/** The same, coloured: each key highlighted, the labels plain, on the bar bg. */
function hintsAnsi(hints: readonly KeyHint[]): string {
  let out = "";
  hints.forEach((h, i) => {
    out += paint(h.key, ui.statusKey);
    out += paint(
      ` ${h.label}${i < hints.length - 1 ? "  " : ""}`,
      ui.statusBar,
    );
  });
  return out;
}

function lineInfo(
  first: number,
  last: number,
  total: number,
  pct: number,
  atEnd: boolean,
): string {
  const where = atEnd ? "END" : `${pct}%`;
  return `${first}-${last}/${total}  ${where}`;
}

// --- Overlay (info card / definition peek) ----------------------------------

export interface OverlayBox {
  x: number;
  y: number;
  boxW: number;
  boxH: number;
  innerW: number;
  innerH: number;
}

/** Geometry of the centred overlay box for the given terminal size. The box is
 * clamped to fit inside the terminal, so on a terminal too small to hold the box
 * the dimensions collapse to the terminal size rather than going negative. Inner
 * dimensions never go below 0, which keeps {@link applyOverlay}'s repeat/slice
 * maths safe. A box narrower or shorter than the 2-cell border chrome cannot be
 * drawn; `applyOverlay` checks for that. */
export function overlayBox(width: number, height: number): OverlayBox {
  const boxW = Math.max(
    0,
    Math.min(width - 4, Math.max(40, Math.floor(width * 0.8))),
  );
  const boxH = Math.max(
    0,
    Math.min(height - 4, Math.max(6, Math.floor(height * 0.7))),
  );
  return {
    x: Math.max(0, Math.floor((width - boxW) / 2)),
    y: Math.max(0, Math.floor((height - boxH) / 2)),
    boxW,
    boxH,
    innerW: Math.max(0, boxW - 2),
    innerH: Math.max(0, boxH - 2),
  };
}

function applyOverlay(
  rows: string[],
  view: ViewState,
  overlay: OverlayState,
): void {
  const { x, y, boxW, boxH, innerW, innerH } = overlayBox(
    view.width,
    view.height,
  );
  // A terminal smaller than the 2-cell border chrome leaves no room to draw the
  // box; show the underlying content rather than indexing rows out of range.
  if (boxW < 2 || boxH < 2) return;

  // An overlay showing source code is a blue editor window; everything else is
  // a grey dialog. The border carries the same background as the body, so the
  // panel reads as one solid block rather than a frame over the content behind.
  const source = !!overlay.sourceView;
  const panelBg = source ? ui.editorBg : ui.overlayBg;
  const styler = source ? spanStyle : overlaySpanStyle;
  const border = view.color
    ? { ...(source ? ui.overlaySourceBorder : ui.overlayBorder), bg: panelBg }
    : EMPTY_STYLE;
  const bg: Style = { bg: panelBg };
  const selBg: Style = { bg: ui.overlayHighlightBg };

  // Double-line frame, after the Turbo Pascal window border.
  const top = `╔${truncCenter(` ${overlay.title} `, boxW - 2, "═")}╗`;
  const bottom = `╚${truncCenter(` ${overlay.footer} `, boxW - 2, "═")}╝`;
  rows[y] = overlayRow(rows[y], x, paintIf(top, border, view.color));
  rows[y + boxH - 1] = overlayRow(
    rows[y + boxH - 1],
    x,
    paintIf(bottom, border, view.color),
  );

  for (let i = 0; i < innerH; i++) {
    const lineIdx = overlay.scroll + i;
    const srcLine = overlay.lines[lineIdx];
    const rowBg = lineIdx === overlay.selectedLine ? selBg : bg;
    const cells: Cell[] = new Array(innerW);
    for (let c = 0; c < innerW; c++) cells[c] = { ch: " ", style: rowBg };
    if (srcLine) {
      const display = displayLine(srcLine, view.displayMode, styler);
      // One blank column of margin sits inside each border, so content is drawn
      // into cells[1 … innerW-2].
      for (let idx = 0; idx < display.length; idx++) {
        const col = idx + 1;
        if (col >= innerW - 1) break;
        const dc = display[idx];
        const style = view.color ? mergeBg(dc.ansi ?? dc.syntax, rowBg) : rowBg;
        cells[col] = { ch: dc.ch, style };
      }
    }
    const body = cellsToAnsi(cells, view.color);
    const rowText = paintIf("║", border, view.color) + body +
      paintIf("║", border, view.color);
    rows[y + 1 + i] = overlayRow(rows[y + 1 + i], x, rowText);
  }

  if (view.color) castShadow(rows, view, x, y, boxW, boxH);
}

/** The Turbo Pascal drop shadow: the content two columns to the right of the box
 * (from one row below its top) and one row below it (offset two columns in) is
 * repainted dark, so the dialog appears to float above the screen. */
function castShadow(
  rows: string[],
  view: ViewState,
  x: number,
  y: number,
  boxW: number,
  boxH: number,
): void {
  for (let r = y + 1; r <= y + boxH; r++) {
    darkenSpan(rows, view, r, x + boxW, 2);
  }
  darkenSpan(rows, view, y + boxH, x + 2, boxW);
}

/** Repaint `count` cells at visible column `from` of row `r` in the shadow
 * colour, keeping whatever characters were there. Clamped to the row and the
 * terminal width so the fixed row width is preserved. */
function darkenSpan(
  rows: string[],
  view: ViewState,
  r: number,
  from: number,
  count: number,
): void {
  if (r < 0 || r >= rows.length || from < 0) return;
  const n = Math.min(count, view.width - from);
  if (n <= 0) return;
  const chars = sliceVisible(rows[r], from, from + n).replace(ANSI, "")
    .padEnd(n, " ").slice(0, n);
  rows[r] = overlayRow(rows[r], from, paint(chars, ui.overlayShadow));
}

// --- Modal dialog (save / revert / amend prompt) ----------------------------

/** Blank columns between adjacent buttons in a dialog's button row. */
const BUTTON_GAP = 3;

/** Blank columns of margin inside each side border of a dialog, between the
 * border and the widest line of content. */
const DIALOG_HMARGIN = 2;

/** The drawn face of a button: its label with one space of padding each side. */
function faceText(b: DialogButton): string {
  return ` ${b.label} `;
}

function faceWidth(b: DialogButton): number {
  return cpLen(faceText(b));
}

/** The face plus the one column of right-hand shadow it casts. */
function slotWidth(b: DialogButton): number {
  return faceWidth(b) + 1;
}

/** Width of the whole button row: every button slot plus the gaps between. */
function buttonsWidth(buttons: readonly DialogButton[]): number {
  if (buttons.length === 0) return 0;
  return buttons.reduce((w, b) => w + slotWidth(b), 0) +
    BUTTON_GAP * (buttons.length - 1);
}

export interface DialogBox {
  x: number;
  y: number;
  boxW: number;
  boxH: number;
  innerW: number;
  innerH: number;
}

/** Geometry of the centred dialog box, sized to its content (title, body and
 * button row) and clamped to leave two cells for the drop shadow. */
export function dialogBox(view: ViewState, dialog: DialogState): DialogBox {
  const titleW = cpLen(dialog.title) + 4; // the padding spaces and some fill
  const bodyW = dialog.body.reduce((m, l) => Math.max(m, cpLen(l)), 0);
  const btnW = buttonsWidth(dialog.buttons);
  const contentW = Math.max(titleW, bodyW, btnW);
  // The margin columns each side, then the two borders.
  // Inner rows: a blank under the title, the body, a blank, the buttons, and the
  // buttons' shadow.
  const boxW = Math.max(
    0,
    Math.min(contentW + 2 * DIALOG_HMARGIN + 2, view.width - 2),
  );
  const boxH = Math.max(0, Math.min(dialog.body.length + 6, view.height - 1));
  return {
    x: Math.max(0, Math.floor((view.width - boxW) / 2)),
    y: Math.max(0, Math.floor((view.height - boxH) / 2)),
    boxW,
    boxH,
    innerW: Math.max(0, boxW - 2),
    innerH: Math.max(0, boxH - 2),
  };
}

/** The top border of a dialog: the title centred in the width and filled with
 * the double rule. */
function titleBar(title: string, width: number): string {
  if (width <= 0) return "";
  return truncCenter(` ${title} `, width, "═");
}

interface ButtonPos {
  b: DialogButton;
  start: number;
  faceW: number;
}

/** Left-to-right positions of the buttons, as a block centred in `innerW`. */
function layoutButtons(
  buttons: readonly DialogButton[],
  innerW: number,
): ButtonPos[] {
  let cx = Math.max(1, Math.floor((innerW - buttonsWidth(buttons)) / 2));
  const out: ButtonPos[] = [];
  for (const b of buttons) {
    const faceW = faceWidth(b);
    out.push({ b, start: cx, faceW });
    cx += faceW + 1 + BUTTON_GAP;
  }
  return out;
}

/** The face index of the highlighted shortcut letter, or -1 if the hotkey does
 * not appear in the label. Offset by one for the leading pad space. */
function hotkeyFaceIndex(b: DialogButton): number {
  const hk = b.hotkey.toLowerCase();
  const idx = [...b.label].findIndex((c) => c.toLowerCase() === hk);
  return idx < 0 ? -1 : idx + 1;
}

function applyDialog(
  rows: string[],
  view: ViewState,
  dialog: DialogState,
): void {
  const { x, y, boxW, boxH, innerW, innerH } = dialogBox(view, dialog);
  if (boxW < 2 || boxH < 2) return;

  const border = view.color
    ? { ...ui.overlayBorder, bg: ui.overlayBg }
    : EMPTY_STYLE;
  const panelBg: Style = { bg: ui.overlayBg };
  const textStyle = view.color ? mergeBg(ui.dialogText, panelBg) : panelBg;

  const top = `╔${titleBar(dialog.title, boxW - 2)}╗`;
  const bottom = `╚${"═".repeat(Math.max(0, boxW - 2))}╝`;
  rows[y] = overlayRow(rows[y], x, paintIf(top, border, view.color));
  rows[y + boxH - 1] = overlayRow(
    rows[y + boxH - 1],
    x,
    paintIf(bottom, border, view.color),
  );

  const layout = layoutButtons(dialog.buttons, innerW);
  const buttonRow = innerH - 2;
  const shadowRow = innerH - 1;
  // The focused button is drawn highlighted; without an explicit focus, the
  // default button is. A pushed button is drawn mid-press.
  const focusIdx = dialog.focus ??
    dialog.buttons.findIndex((b) => b.kind === "default");
  const pushedIdx = dialog.pushed ?? -1;
  for (let i = 0; i < innerH; i++) {
    const cells: Cell[] = new Array(innerW);
    for (let c = 0; c < innerW; c++) cells[c] = { ch: " ", style: panelBg };
    const bodyIdx = i - 1; // one blank row sits under the title
    if (bodyIdx >= 0 && bodyIdx < dialog.body.length) {
      placeCentered(cells, dialog.body[bodyIdx], textStyle);
    } else if (i === buttonRow) {
      placeButtonFaces(cells, layout, view.color, panelBg, focusIdx, pushedIdx);
    } else if (i === shadowRow && view.color) {
      placeButtonShadows(cells, layout, panelBg, pushedIdx);
    }
    const rowText = paintIf("║", border, view.color) +
      cellsToAnsi(cells, view.color) + paintIf("║", border, view.color);
    rows[y + 1 + i] = overlayRow(rows[y + 1 + i], x, rowText);
  }

  if (view.color) castShadow(rows, view, x, y, boxW, boxH);
}

/** Write `text` centred in `cells`, one blank margin column inside each edge. */
function placeCentered(cells: Cell[], text: string, style: Style): void {
  const innerW = cells.length;
  const chars = [...showControls(text)];
  const start = 1 + Math.max(0, Math.floor((innerW - 2 - chars.length) / 2));
  for (let j = 0; j < chars.length; j++) {
    const col = start + j;
    if (col >= 1 && col <= innerW - 2) cells[col] = { ch: chars[j], style };
  }
}

function placeButtonFaces(
  cells: Cell[],
  layout: ButtonPos[],
  color: boolean,
  panelBg: Style,
  focus: number,
  pushed: number,
): void {
  layout.forEach(({ b, start, faceW }, idx) => {
    const chars = [...faceText(b)];
    const face = !color
      ? panelBg
      : idx === focus
      ? ui.buttonDefault
      : ui.button;
    const keyStyle = color ? ui.buttonKey : panelBg;
    const hk = hotkeyFaceIndex(b);
    // A pressed button slides one column right, into the space its shadow held.
    const shift = idx === pushed ? 1 : 0;
    for (let j = 0; j < chars.length; j++) {
      const col = start + shift + j;
      if (col >= 0 && col < cells.length) {
        cells[col] = { ch: chars[j], style: j === hk ? keyStyle : face };
      }
    }
    const rightShadow = start + faceW;
    if (
      color && idx !== pushed && rightShadow >= 0 && rightShadow < cells.length
    ) {
      // A lower half-block in the column beside the face, matching the band
      // beneath, so the shadow reads as a thin edge along the bottom.
      cells[rightShadow] = {
        ch: "▄",
        style: mergeBg(ui.buttonShadow, panelBg),
      };
    }
  });
}

/** The buttons' drop shadow row: an upper half-block band under each face,
 * shifted one column right so it lines up with the right-hand shadow. */
function placeButtonShadows(
  cells: Cell[],
  layout: ButtonPos[],
  panelBg: Style,
  pushed: number,
): void {
  const style = mergeBg(ui.buttonShadow, panelBg);
  layout.forEach(({ start, faceW }, idx) => {
    if (idx === pushed) return; // a pressed button casts no shadow
    for (let k = 0; k < faceW; k++) {
      const col = start + 1 + k;
      if (col >= 0 && col < cells.length) {
        cells[col] = { ch: "▀", style };
      }
    }
  });
}

/** Splice `insert` into `base` starting at visible column `x`. */
function overlayRow(base: string, x: number, insert: string): string {
  const left = sliceVisible(base, 0, x);
  const insertW = visibleLen(insert);
  const right = sliceVisible(base, x + insertW, Number.MAX_SAFE_INTEGER);
  return left + RESET + insert + RESET + right;
}

// --- Cell / style helpers ----------------------------------------------------

function cellsToAnsi(cells: Cell[], color: boolean): string {
  if (!color) return cells.map((c) => c.ch).join("");
  let out = "";
  let curKey: string | null = null;
  let curOpen = "";
  for (const cell of cells) {
    const open = sgrInline(cell.style);
    if (open !== curKey) {
      if (curKey !== null) out += RESET;
      out += open;
      curKey = open;
      curOpen = open;
    }
    out += cell.ch;
  }
  if (curOpen !== "") out += RESET;
  return out;
}

function sgrInline(style: Style): string {
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.underline) codes.push(4);
  if (style.fg) codes.push(38, 2, style.fg[0], style.fg[1], style.fg[2]);
  if (style.bg) codes.push(48, 2, style.bg[0], style.bg[1], style.bg[2]);
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

function mergeBg(style: Style, bg: Style): Style {
  if (!bg.bg) return style;
  return { ...style, bg: bg.bg };
}

function paintIf(text: string, style: Style, color: boolean): string {
  return color ? paint(text, style) : text;
}

function kindGlyph(kind: string): string {
  switch (kind) {
    case "section":
      return "▸";
    case "pattern":
      return "◆";
    case "builder":
      return "◇";
    case "closure":
      return "λ";
    case "schema":
      return "▦";
    case "function":
    case "method":
      return "ƒ";
    case "interface":
    case "typeAlias":
    case "class":
      return "𝑻";
    case "return":
      return "⏎";
    case "control":
      return "⎇";
    case "hunk":
      return "±";
    case "comment":
      return "#";
    default:
      return "·";
  }
}

// --- Visible-width string ops (ANSI-aware) -----------------------------------

// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function visibleLen(text: string): number {
  return cpLen(text.replace(ANSI, ""));
}

function padTo(text: string, width: number): string {
  const len = visibleLen(text);
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

/** Slice by visible columns (code points), keeping ANSI escapes before kept
 * text. A non-BMP code point counts as one column. */
function sliceVisible(text: string, from: number, to: number): string {
  let out = "";
  let col = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      // deno-lint-ignore no-control-regex
      const m = text.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    if (col >= from && col < to) out += ch;
    col += 1;
    i += ch.length;
  }
  return out;
}

function truncCenter(text: string, width: number, fill: string): string {
  const len = cpLen(text);
  if (len >= width) {
    let out = "";
    let c = 0;
    for (const ch of text) {
      if (c >= width) break;
      out += ch;
      c += 1;
    }
    return out;
  }
  const total = width - len;
  const leftN = Math.floor(total / 2);
  return fill.repeat(leftN) + text + fill.repeat(total - leftN);
}

export const _internal = {
  sliceVisible,
  padTo,
  visibleLen,
  cellsToAnsi,
  mergeBg,
  darkenSpan,
};
