/**
 * Screen-row layout for wrapped pager content. A wrapped row identifies
 * the logical line it draws and the display-column offset where that row starts.
 */
import { type DisplayMode, displayWidth } from "./display.ts";
import type { Line } from "./model.ts";

export interface WrappedRow {
  /** Index of the logical line in the displayed document. */
  readonly line: number;
  /** Display-column offset where this screen row starts. */
  readonly offset: number;
  /** Display-column offset where this logical line's final screen row starts. */
  readonly lastOffset: number;
}

export interface WrapPlan {
  readonly rowCount: number;
  /** Total number of content columns available on each screen row. */
  readonly rowWidth: number;
  /** Display columns consumed by each row that carries a continuation marker. */
  readonly rowStride: number;
  /** First screen row occupied by each logical line. */
  readonly firstRow: readonly number[];
  /** Last screen row occupied by each logical line. */
  readonly lastRow: readonly number[];
}

/** Fit optional left-side chrome while retaining two content columns whenever
 * the terminal has room for both source text and a continuation marker. */
export function fitWrapChrome(
  totalWidth: number,
  gutterWidth: number,
  guideWidth: number,
): { gutterWidth: number; guideWidth: number } {
  const minContentWidth = totalWidth > 1 ? 2 : 1;
  let gutter = Math.max(0, gutterWidth);
  let guide = Math.max(0, guideWidth);
  if (totalWidth - gutter - guide < minContentWidth) gutter = 0;
  if (totalWidth - gutter - guide < minContentWidth) guide = 0;
  return { gutterWidth: gutter, guideWidth: guide };
}

/** Resolve one screen row without storing an object for every continuation in
 * the document. */
export function wrappedRowAt(
  plan: WrapPlan,
  row: number,
): WrappedRow | undefined {
  if (row < 0 || row >= plan.rowCount) return undefined;
  let lo = 0;
  let hi = plan.firstRow.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (plan.firstRow[mid] <= row) lo = mid;
    else hi = mid - 1;
  }
  return {
    line: lo,
    offset: (row - plan.firstRow[lo]) * plan.rowStride,
    lastOffset: (plan.lastRow[lo] - plan.firstRow[lo]) * plan.rowStride,
  };
}

/** Lay logical lines out as fixed-width screen rows. Rows whose content
 * continues reserve their final column for a marker. Empty lines still occupy
 * one row, while a line ending exactly at the edge does not add a blank row. */
export function buildWrapPlan(
  lines: readonly Line[],
  mode: DisplayMode,
  width: number,
): WrapPlan {
  const rowWidth = Math.max(1, width);
  const rowStride = Math.max(1, rowWidth - 1);
  let rowCount = 0;
  const firstRow: number[] = new Array(lines.length);
  const lastRow: number[] = new Array(lines.length);
  for (let line = 0; line < lines.length; line++) {
    firstRow[line] = rowCount;
    const width = displayWidth(lines[line], mode);
    const count = width <= rowWidth
      ? 1
      : 1 + Math.ceil((width - rowWidth) / rowStride);
    rowCount += count;
    lastRow[line] = rowCount - 1;
  }
  return { rowCount, rowWidth, rowStride, firstRow, lastRow };
}
