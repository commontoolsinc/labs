/**
 * Turns model {@link Span}s into ANSI-coloured strings. Used both by the
 * non-interactive print path (`renderLineColored` over every line) and as the
 * per-span styling primitive for the interactive renderer.
 *
 * Colour never changes the underlying characters: `renderLinePlain` and the
 * concatenated span text of `renderLineColored` are byte-for-byte identical to
 * the verbatim source line.
 */
import { paint, type Style } from "./ansi.ts";
import type { Line, Span } from "./model.ts";
import { bracketStyle, dialogStyleFor, lineBg, styleFor } from "./theme.ts";

/** Resolve the ANSI {@link Style} for a span (bracket spans rainbow by depth). */
export function spanStyle(span: Span): Style {
  if (span.cls === "bracket" && span.bracketDepth !== undefined) {
    return bracketStyle(span.bracketDepth);
  }
  return styleFor(span.cls);
}

/** The style for a span shown inside a dialog (a light-grey panel), where the
 * editor's bright colours would not read. */
export function overlaySpanStyle(span: Span): Style {
  return dialogStyleFor(span.cls);
}

/** The verbatim line, no colour. */
export function renderLinePlain(line: Line): string {
  return line.text;
}

/** The line with every span painted. `color === false` returns verbatim text. */
export function renderLineColored(line: Line, color: boolean): string {
  if (!color) return line.text;
  const bg = line.bg ? { bg: lineBg(line.bg) } : undefined;
  let out = "";
  for (const span of line.spans) {
    const style = bg ? { ...spanStyle(span), ...bg } : spanStyle(span);
    out += paint(span.text, style);
  }
  return out;
}
