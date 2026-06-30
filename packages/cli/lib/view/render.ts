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
import { spanStyle } from "./highlight.ts";
import { lineBg, ui } from "./theme.ts";

export interface ViewState {
  top: number;
  left: number;
  width: number;
  height: number;
  color: boolean;
  showLineNumbers: boolean;
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
  /** The text cursor, in document coordinates (line + display column), when
   * edit mode has it visible. The pager positions the real terminal cursor. */
  cursor?: { line: number; col: number } | null;
  /** Edit-mode key hints, shown on the status line in place of the navigation
   * help while the text cursor is active. */
  editHint?: string | null;
  /** Whether Ctrl-L can reveal more context here (a diff), so the navigation
   * help advertises it. */
  canExpand?: boolean;
  /** Lines shown just above the status/prompt bar (e.g. the list of files an
   * edited diff would save), overwriting the bottom content rows. */
  notice?: readonly string[] | null;
}

/** Layout widths the content area is laid out with, for cursor placement. */
function layout(
  doc: Document,
  view: ViewState,
): { gutterWidth: number; guideWidth: number } {
  return {
    gutterWidth: view.showLineNumbers
      ? Math.max(4, String(doc.lines.length).length + 1)
      : 0,
    guideWidth: view.selected ? 1 : 0,
  };
}

/**
 * 1-based terminal (row, col) for the text cursor, or null when there is no
 * cursor, it is scrolled off screen, or an overlay covers the content. Mirrors
 * the layout `renderFrame` uses (gutter + guide + horizontal scroll).
 */
export function cursorScreenPos(
  doc: Document,
  view: ViewState,
): { row: number; col: number } | null {
  if (!view.cursor || view.overlay) return null;
  const { line, col } = view.cursor;
  const contentHeight = view.height - 1;
  const r = line - view.top;
  if (r < 0 || r >= contentHeight) return null;
  const { gutterWidth, guideWidth } = layout(doc, view);
  const contentCol = col - view.left;
  const contentWidth = Math.max(1, view.width - gutterWidth - guideWidth);
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
}

interface Cell {
  ch: string;
  style: Style;
}

const EMPTY_STYLE: Style = {};

/** Render a complete frame: exactly `view.height` rows. */
export function renderFrame(doc: Document, view: ViewState): string[] {
  const rows: string[] = [];
  const contentHeight = view.height - 1;
  const gutterWidth = view.showLineNumbers
    ? Math.max(4, String(doc.lines.length).length + 1)
    : 0;
  const guideWidth = view.selected ? 1 : 0;
  const contentWidth = Math.max(1, view.width - gutterWidth - guideWidth);

  for (let r = 0; r < contentHeight; r++) {
    const lineIdx = view.top + r;
    rows.push(
      renderContentRow(
        doc,
        view,
        lineIdx,
        gutterWidth,
        guideWidth,
        contentWidth,
      ),
    );
  }
  rows.push(renderStatus(doc, view));

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
  return rows;
}

function renderContentRow(
  doc: Document,
  view: ViewState,
  lineIdx: number,
  gutterWidth: number,
  guideWidth: number,
  contentWidth: number,
): string {
  const line: Line | undefined = doc.lines[lineIdx];
  const sel = selectionSpan(view, lineIdx, line);
  const inSelRange = !!view.selected &&
    lineIdx >= view.selected.startLine && lineIdx <= view.selected.endLine;

  let gutter = "";
  if (gutterWidth > 0) {
    const label = line ? String(lineIdx + 1) : "";
    const style = inSelRange ? ui.lineNumberCurrent : ui.lineNumber;
    gutter = paintIf(label.padStart(gutterWidth - 1) + " ", style, view.color);
  }

  let guide = "";
  if (guideWidth > 0) {
    guide = paintIf(guideChar(view.selected, lineIdx), ui.guide, view.color);
  }

  const content = composeContent(line, view, lineIdx, contentWidth, sel);
  return gutter + guide + content;
}

function guideChar(selected: StructureNode | null, lineIdx: number): string {
  if (!selected) return " ";
  if (lineIdx < selected.startLine || lineIdx > selected.endLine) return " ";
  if (selected.startLine === selected.endLine) return "▶";
  if (lineIdx === selected.startLine) return "╭";
  if (lineIdx === selected.endLine) return "╰";
  return "│";
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
  const lineLen = text.length;
  let lo = lineIdx === sel.startLine ? sel.startCol : 0;
  let hi = lineIdx === sel.endLine ? sel.endCol : lineLen;
  lo = Math.max(0, Math.min(lo, lineLen));
  hi = Math.max(0, Math.min(hi, lineLen));
  if (lo > 0 && text.slice(0, lo).trim() === "") lo = 0; // leading indentation
  if (hi < lineLen && text.slice(hi).trim() === "") hi = lineLen; // trailing ws
  if (hi <= lo) return null;
  const bg: Style = sel.kind === "schema"
    ? { bg: ui.schemaRegionBg }
    : sel.kind === "closure"
    ? { bg: ui.closureRegionBg }
    : { bg: ui.selectionBg };
  return { lo, hi, bg };
}

function composeContent(
  line: Line | undefined,
  view: ViewState,
  lineIdx: number,
  width: number,
  sel: SelectionSpan | null,
): string {
  const { left, color } = view;
  // Diff lines carry a full-row background tint; syntax colours paint on top,
  // and the selection background still wins inside its range.
  const rowBg: Style = color && line?.bg
    ? { bg: lineBg(line.bg) }
    : EMPTY_STYLE;
  const cells: Cell[] = new Array(width);
  for (let i = 0; i < width; i++) cells[i] = { ch: " ", style: rowBg };

  if (line) {
    for (const span of line.spans) {
      const base = color ? mergeBg(spanStyle(span), rowBg) : EMPTY_STYLE;
      let col = span.col;
      for (const ch of span.text) { // iterate code points, one column each
        const idx = col - left;
        if (idx >= width) break;
        if (idx >= 0) {
          const inSel = sel !== null && col >= sel.lo && col < sel.hi;
          cells[idx] = {
            ch: displayChar(ch),
            style: inSel && color ? mergeBg(base, sel.bg) : base,
          };
        }
        col += 1;
      }
    }
  }

  if (view.matches && color) {
    const ms = view.matches;
    for (let m = 0; m < ms.length; m++) {
      const hit: Match = ms[m];
      if (hit.line !== lineIdx) continue;
      const style = m === view.currentMatch ? ui.searchCurrent : ui.searchMatch;
      for (let col = hit.start; col < hit.end; col++) {
        const idx = col - left;
        if (idx < 0 || idx >= width) continue;
        cells[idx] = { ch: cells[idx].ch, style };
      }
    }
  }

  return cellsToAnsi(cells, color);
}

function renderStatus(doc: Document, view: ViewState): string {
  if (view.inputLine !== null) {
    return padTo(view.inputLine, view.width);
  }
  const total = doc.lines.length;
  const lastVisible = Math.min(total, view.top + view.height - 1);
  const pct = total <= 1 ? 100 : Math.round((view.top / (total - 1)) * 100);
  const atEnd = lastVisible >= total;

  let left: string;
  if (view.message) {
    left = view.message;
  } else if (view.editHint) {
    left = view.editHint;
  } else if (view.selected) {
    left = `${kindGlyph(view.selected.kind)} ${view.selected.label}`;
  } else {
    left = "cf view — ? help · q quit · / search · wasd tree";
    if (view.canExpand) left += " · ^l expand";
  }

  const right = view.matches && view.matches.length > 0
    ? `match ${view.currentMatch + 1}/${view.matches.length}  ${
      lineInfo(view, total, pct, atEnd)
    }`
    : lineInfo(view, total, pct, atEnd);

  if (!view.color) {
    return padTo(`${left}  ${right}`, view.width);
  }
  const space = Math.max(1, view.width - visibleLen(left) - visibleLen(right));
  const text = left + " ".repeat(space) + right;
  return paint(padTo(text, view.width), ui.statusBar);
}

function lineInfo(
  view: ViewState,
  total: number,
  pct: number,
  atEnd: boolean,
): string {
  const first = Math.min(total, view.top + 1);
  const last = Math.min(total, view.top + view.height - 1);
  const where = atEnd && view.top + view.height - 1 >= total
    ? "END"
    : `${pct}%`;
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

  const border = view.color ? ui.overlayBorder : EMPTY_STYLE;
  const bg: Style = { bg: ui.overlayBg };
  const selBg: Style = { bg: ui.selectionBg };

  const top = `╭${truncCenter(` ${overlay.title} `, boxW - 2, "─")}╮`;
  const bottom = `╰${truncCenter(` ${overlay.footer} `, boxW - 2, "─")}╯`;
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
      for (const span of srcLine.spans) {
        const style = view.color ? mergeBg(spanStyle(span), rowBg) : rowBg;
        let idx = span.col;
        for (const ch of span.text) { // code points, one column each
          if (idx >= innerW) break;
          if (idx >= 0) cells[idx] = { ch: displayChar(ch), style };
          idx += 1;
        }
      }
    }
    const body = cellsToAnsi(cells, view.color);
    const rowText = paintIf("│", border, view.color) + body +
      paintIf("│", border, view.color);
    rows[y + 1 + i] = overlayRow(rows[y + 1 + i], x, rowText);
  }
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

function displayChar(ch: string): string {
  if (ch === "\t") return " ";
  const code = ch.codePointAt(0) ?? 32;
  if (code < 0x20) return " ";
  return ch;
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

export const _internal = { sliceVisible, padTo, visibleLen, cellsToAnsi };
