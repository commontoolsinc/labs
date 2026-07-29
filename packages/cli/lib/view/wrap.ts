/**
 * Screen-row layout for wrapped pager content. A wrapped row identifies
 * the logical line it draws and the display-column offset where that row starts.
 */
import { type DisplayMode, displayWidth } from "./display.ts";
import type { Line } from "./model.ts";

export interface WrappedRow {
  /** Absolute screen row in the complete wrapped document. */
  readonly row: number;
  /** Index of the logical line in the displayed document. */
  readonly line: number;
  /** Display-column offset where this screen row starts. */
  readonly offset: number;
  /** Display-column offset where this logical line's final screen row starts. */
  readonly lastOffset: number;
  /** Source cells available on this row. */
  readonly sourceWidth: number;
  /** Whether source content continues on the following row. */
  readonly continues: boolean;
  /** Whether this row has room for a continuation marker. */
  readonly wrapMarker: boolean;
  /** Cells reserved at the right edge for a line annotation. */
  readonly suffixWidth: number;
}

export interface WrapDecoration {
  /** Cells reserved on the logical line's first screen row. */
  readonly firstWidth: number;
  /** Cells reserved on the first screen row after the logical line wraps. */
  readonly firstContinuationWidth?: number;
  /** Cells reserved on later screen rows of the logical line. */
  readonly continuationWidth: number;
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
  /** Source cells consumed by a continued first row. */
  readonly firstSourceWidth: readonly number[];
  /** Source cells consumed by each continued row after the first. */
  readonly continuationStride: readonly number[];
  /** Source cells consumed by the first continuation when it wraps again. */
  readonly firstContinuationStride: readonly number[];
  /** Annotation width on each logical line's first row. */
  readonly firstSuffixWidth: readonly number[];
  /** Annotation width on each logical line's first continuation row. */
  readonly firstContinuationSuffixWidth: readonly number[];
  /** Annotation width on later rows of each logical line. */
  readonly continuationSuffixWidth: readonly number[];
}

export interface ViewLayout {
  readonly gutterWidth: number;
  readonly guideWidth: number;
  readonly contentWidth: number;
  readonly marginWidth: number;
}

/** Fit pager chrome around at least one source cell. Wrapped rows retain a
 * second content cell for their continuation marker when the terminal has room.
 * The expansion margin is kept ahead of optional left-side chrome. */
export function fitViewLayout(
  totalWidth: number,
  gutterWidth: number,
  guideWidth: number,
  marginWidth: number,
  wrapLines: boolean,
): ViewLayout {
  const width = Math.max(1, totalWidth);
  const margin = Math.min(Math.max(0, marginWidth), width - 1);
  const availableWidth = width - margin;
  const minContentWidth = wrapLines && availableWidth > 1 ? 2 : 1;
  let gutter = Math.max(0, gutterWidth);
  let guide = Math.max(0, guideWidth);
  if (availableWidth - gutter - guide < minContentWidth) gutter = 0;
  if (availableWidth - gutter - guide < minContentWidth) guide = 0;
  return {
    gutterWidth: gutter,
    guideWidth: guide,
    contentWidth: availableWidth - gutter - guide,
    marginWidth: margin,
  };
}

/** Fit optional left-side chrome while retaining two content columns whenever
 * the terminal has room for both source text and a continuation marker. */
export function fitWrapChrome(
  totalWidth: number,
  gutterWidth: number,
  guideWidth: number,
): { gutterWidth: number; guideWidth: number } {
  const { gutterWidth: gutter, guideWidth: guide } = fitViewLayout(
    totalWidth,
    gutterWidth,
    guideWidth,
    0,
    true,
  );
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
  const within = row - plan.firstRow[lo];
  const lastWithin = plan.lastRow[lo] - plan.firstRow[lo];
  const firstSource = plan.firstSourceWidth[lo];
  const firstContinuationStride = plan.firstContinuationStride[lo];
  const stride = plan.continuationStride[lo];
  const offset = within === 0
    ? 0
    : within === 1
    ? firstSource
    : firstSource + firstContinuationStride + (within - 2) * stride;
  const lastOffset = lastWithin === 0
    ? 0
    : lastWithin === 1
    ? firstSource
    : firstSource + firstContinuationStride + (lastWithin - 2) * stride;
  const suffixWidth = within === 0
    ? plan.firstSuffixWidth[lo]
    : within === 1
    ? plan.firstContinuationSuffixWidth[lo]
    : plan.continuationSuffixWidth[lo];
  const continues = within < lastWithin;
  const available = plan.rowWidth - suffixWidth;
  return {
    row,
    line: lo,
    offset,
    lastOffset,
    sourceWidth: continues
      ? available > 1 ? available - 1 : available
      : available,
    continues,
    wrapMarker: continues && available > 1,
    suffixWidth,
  };
}

/** Resolve the wrapped row containing a display column on one logical line. */
export function wrappedRowForPosition(
  plan: WrapPlan,
  line: number,
  displayCol: number,
): WrappedRow | undefined {
  if (line < 0 || line >= plan.firstRow.length) return undefined;
  const first = plan.firstRow[line];
  const last = plan.lastRow[line];
  const col = Math.max(0, displayCol);
  let row = first;
  const firstSource = plan.firstSourceWidth[line];
  if (first < last && col >= firstSource) {
    const firstContinuationStride = plan.firstContinuationStride[line];
    const afterFirst = col - firstSource;
    row = first + 1;
    if (first + 1 < last && afterFirst >= firstContinuationStride) {
      row = first + 2 +
        Math.floor(
          (afterFirst - firstContinuationStride) /
            plan.continuationStride[line],
        );
    }
  }
  return wrappedRowAt(plan, Math.min(row, last));
}

/** Lay logical lines out as fixed-width screen rows. Rows whose content
 * continues reserve their final column for a marker. Empty lines still occupy
 * one row, while a line ending exactly at the edge does not add a blank row. */
export function buildWrapPlan(
  lines: readonly Line[],
  mode: DisplayMode,
  width: number,
  decorations: ReadonlyMap<number, WrapDecoration> = new Map(),
): WrapPlan {
  const rowWidth = Math.max(1, width);
  const rowStride = Math.max(1, rowWidth - 1);
  let rowCount = 0;
  const firstRow: number[] = new Array(lines.length);
  const lastRow: number[] = new Array(lines.length);
  const firstSourceWidth: number[] = new Array(lines.length);
  const continuationStride: number[] = new Array(lines.length);
  const firstContinuationStride: number[] = new Array(lines.length);
  const firstSuffixWidth: number[] = new Array(lines.length);
  const firstContinuationSuffixWidth: number[] = new Array(lines.length);
  const continuationSuffixWidth: number[] = new Array(lines.length);
  for (let line = 0; line < lines.length; line++) {
    firstRow[line] = rowCount;
    const decoration = decorations.get(line);
    const firstSuffix = Math.min(
      Math.max(0, decoration?.firstWidth ?? 0),
      rowWidth - 1,
    );
    const continuationSuffix = Math.min(
      Math.max(0, decoration?.continuationWidth ?? 0),
      rowWidth - 1,
    );
    const firstContinuationSuffix = Math.min(
      Math.max(
        0,
        decoration?.firstContinuationWidth ?? continuationSuffix,
      ),
      rowWidth - 1,
    );
    const firstAvailable = rowWidth - firstSuffix;
    const firstContinuationAvailable = rowWidth - firstContinuationSuffix;
    const continuationAvailable = rowWidth - continuationSuffix;
    const firstStride = firstAvailable > 1
      ? firstAvailable - 1
      : firstAvailable;
    const nextStride = firstContinuationAvailable > 1
      ? firstContinuationAvailable - 1
      : firstContinuationAvailable;
    const laterStride = continuationAvailable > 1
      ? continuationAvailable - 1
      : continuationAvailable;
    const lineWidth = displayWidth(lines[line], mode);
    let count = 1;
    if (lineWidth > firstAvailable) {
      const afterFirst = lineWidth - firstStride;
      if (afterFirst <= firstContinuationAvailable) {
        count = 2;
      } else {
        const afterNext = afterFirst - nextStride;
        const middle = Math.max(
          0,
          Math.ceil(
            (afterNext - continuationAvailable) / laterStride,
          ),
        );
        count = 3 + middle;
      }
    }
    rowCount += count;
    lastRow[line] = rowCount - 1;
    firstSourceWidth[line] = count === 1 ? firstAvailable : firstStride;
    firstContinuationStride[line] = nextStride;
    continuationStride[line] = laterStride;
    firstSuffixWidth[line] = firstSuffix;
    firstContinuationSuffixWidth[line] = firstContinuationSuffix;
    continuationSuffixWidth[line] = continuationSuffix;
  }
  return {
    rowCount,
    rowWidth,
    rowStride,
    firstRow,
    lastRow,
    firstSourceWidth,
    continuationStride,
    firstContinuationStride,
    firstSuffixWidth,
    firstContinuationSuffixWidth,
    continuationSuffixWidth,
  };
}
