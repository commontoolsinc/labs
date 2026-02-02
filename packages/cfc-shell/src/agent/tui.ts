/**
 * TUI formatting helpers for agent output — box-drawing borders,
 * ANSI colors, and word wrapping for sub-agent nesting.
 */

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
export const reset = `${ESC}0m`;
export const dim = (text: string): string => `${ESC}2m${text}${reset}`;
export const cyan = (text: string): string => `${ESC}36m${text}${reset}`;

// ---------------------------------------------------------------------------
// Terminal width
// ---------------------------------------------------------------------------

export function getTermWidth(): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return 80;
  }
}

// ---------------------------------------------------------------------------
// Word wrapping
// ---------------------------------------------------------------------------

/**
 * Soft-wrap text at word boundaries to fit within `width` columns.
 * Preserves existing newlines. Lines already within width are unchanged.
 */
export function wordWrap(text: string, width: number): string {
  if (width <= 0) return text;
  return text.split("\n").map((line) => wrapLine(line, width)).join("\n");
}

function wrapLine(line: string, width: number): string {
  if (line.length <= width) return line;

  const words = line.split(/(\s+)/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length > width && current.length > 0) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      current += word;
    }
  }
  if (current) lines.push(current.trimEnd());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

const BOX_V = "│";
const BOX_TL = "┌";
const BOX_BL = "└";

/** Opening line: `┌ {label}` in dim color */
export function boxStart(label: string): string {
  return dim(`${BOX_TL} ${label}`);
}

/**
 * Content line: `│ ` prefix + word-wrapped text.
 * `termWidth` is used to calculate available content width.
 */
export function boxLine(text: string, termWidth?: number): string {
  const prefix = `${BOX_V} `;
  const tw = termWidth ?? getTermWidth();
  const contentWidth = Math.max(20, tw - prefix.length - 2);
  const wrapped = wordWrap(text, contentWidth);
  return wrapped
    .split("\n")
    .map((line) => dim(prefix) + line)
    .join("\n");
}

/** Closing line: `└ → {summary}` in dim color */
export function boxEnd(summary: string): string {
  return dim(`${BOX_BL} → ${summary}`);
}
