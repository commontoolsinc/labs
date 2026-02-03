/**
 * TUI formatting helpers for agent output — box-drawing borders,
 * ANSI colors, and word wrapping for sub-agent nesting.
 *
 * Visual language (Claude Code-inspired):
 *
 *   ⏺ Agent response text        ← depth 0 response
 *     continuation line
 *
 *   $ command                    ← depth 0 tool call ($ aligns with ⏺)
 *     output                    ← depth 0 tool result (indented 2)
 *
 *   ┌ sub-agent (sub policy)    ← task start (depth 1)
 *   │ ⏺ Sub-agent response      ← depth 1 response
 *   │   continuation
 *   │ $ command                 ← depth 1 tool call
 *   │   output                 ← depth 1 tool result
 *   │ ┌ nested sub-agent        ← task start (depth 2)
 *   │ │ ⏺ ...
 *   │ │ $ command
 *   │ └ → "result"             ← task end (depth 2)
 *   └ → "result"               ← task end (depth 1)
 *
 *   ⏺ More root agent text
 */

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
export const reset = `${ESC}0m`;
export const dim = (text: string): string => `${ESC}2m${text}${reset}`;
export const cyan = (text: string): string => `${ESC}36m${text}${reset}`;
export const bold = (text: string): string => `${ESC}1m${text}${reset}`;

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
    // Hard-wrap words longer than width
    if (word.length > width) {
      if (current) {
        lines.push(current.trimEnd());
        current = "";
      }
      for (let i = 0; i < word.length; i += width) {
        const chunk = word.slice(i, i + width);
        if (i + width < word.length) {
          lines.push(chunk);
        } else {
          current = chunk;
        }
      }
      continue;
    }
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
// Depth-based gutter
// ---------------------------------------------------------------------------

const BOX_V = "│";
const BOX_TL = "┌";
const BOX_BL = "└";
const GUTTER_UNIT = `${BOX_V} `;

/** Raw gutter string for a given depth (no ANSI). Used for width calculations. */
export function gutterRaw(depth: number): string {
  if (depth <= 0) return "";
  return GUTTER_UNIT.repeat(depth);
}

/** Dim-colored gutter prefix for content at a given nesting depth. */
export function gutter(depth: number): string {
  if (depth <= 0) return "";
  return dim(gutterRaw(depth));
}

/** Width in columns consumed by the gutter at a given depth. */
export function gutterWidth(depth: number): number {
  return depth * GUTTER_UNIT.length;
}

// ---------------------------------------------------------------------------
// Box drawing (depth-aware)
// ---------------------------------------------------------------------------

/** Opening line for a sub-agent box at `depth`. Drawn at parent's gutter. */
export function boxStart(label: string, depth: number): string {
  const parentGutter = depth > 1 ? gutter(depth - 1) : "";
  return parentGutter + dim(`${BOX_TL} ${label}`);
}

/** Closing line for a sub-agent box at `depth`. Drawn at parent's gutter. */
export function boxEnd(summary: string, depth: number): string {
  const parentGutter = depth > 1 ? gutter(depth - 1) : "";
  return parentGutter + dim(`${BOX_BL} → ${summary}`);
}

// ---------------------------------------------------------------------------
// Line formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a line with a marker prefix (e.g. "$ cmd", "# task"), word-wrapped
 * with continuation lines indented by 2 spaces (aligning under the marker text).
 */
export function fmtPrefixed(
  marker: string,
  text: string,
  depth: number,
  termWidth?: number,
): string {
  const g = gutter(depth);
  const tw = termWidth ?? getTermWidth();
  const prefix = `${marker} `;
  const contentWidth = Math.max(20, tw - gutterWidth(depth) - prefix.length);
  const wrapped = wordWrap(text, contentWidth);
  const lines = wrapped.split("\n");
  return lines
    .map((l, i) => (i === 0 ? `${g}${prefix}${l}` : `${g}  ${l}`))
    .join("\n");
}

/** Format a shell command: `gutter + "$ cmd"` with word wrap */
export function fmtCommand(cmd: string, depth: number): string {
  return fmtPrefixed("$", cmd, depth);
}

/**
 * Format output text: each line gets `gutter + "  "` indentation,
 * word-wrapped to fit the terminal width.
 * Empty lines get the gutter only.
 */
export function fmtOutput(
  text: string,
  depth: number,
  termWidth?: number,
): string {
  const g = gutter(depth);
  const tw = termWidth ?? getTermWidth();
  const indent = 2; // "  " prefix
  const contentWidth = Math.max(20, tw - gutterWidth(depth) - indent);
  const wrapped = wordWrap(text, contentWidth);
  return wrapped.split("\n").map((l) => l ? `${g}  ${l}` : g).join("\n");
}

/** Format a status message (e.g. [filtered: ...], [exit code: N]) */
export function fmtStatus(msg: string, depth: number): string {
  return `${gutter(depth)}  ${msg}`;
}

// ---------------------------------------------------------------------------
// Streaming text formatter
// ---------------------------------------------------------------------------

/**
 * Creates a stateful formatter for streaming assistant text deltas.
 * Tracks line position to apply `⏺` on first line and indentation on
 * continuation lines, all with the correct gutter prefix.
 *
 * Call `format(delta)` for each text chunk. Call `reset()` before each
 * new assistant response to restart the ⏺ marker.
 */
export function createStreamFormatter(
  getDepth: () => number,
): {
  format: (delta: string) => string;
  reset: () => void;
  /** Signal that the cursor is at the start of a new line (after a \n). */
  setAtLineStart: () => void;
  /** Whether the cursor is currently at the start of a line. */
  isAtLineStart: () => boolean;
} {
  let responseStart = true;
  let lineStart = false;
  let atLineStart = false; // cursor is at col 0 from a prior write
  let col = 0;

  return {
    reset() {
      responseStart = true;
      lineStart = false;
      col = 0;
    },
    setAtLineStart() {
      atLineStart = true;
    },
    isAtLineStart() {
      return atLineStart;
    },
    format(delta: string): string {
      const depth = getDepth();
      const tw = getTermWidth();
      const prefixWidth = gutterWidth(depth) + 2;
      const wrapCol = Math.max(20, tw - prefixWidth);
      let out = "";

      for (const ch of delta) {
        if (responseStart) {
          if (depth > 0) {
            // Inside a box: no extra blank line, just start on current/next line
            out += atLineStart ? `${gutter(depth)}⏺ ` : `\n${gutter(depth)}⏺ `;
          } else {
            // Root agent: blank line separator
            out += atLineStart ? `\n⏺ ` : `\n\n⏺ `;
          }
          responseStart = false;
          lineStart = false;
          atLineStart = false;
          col = 0;
        } else if (lineStart) {
          out += `${gutter(depth)}  `;
          lineStart = false;
          col = 0;
        }

        // Hard-wrap: force break if a single "word" exceeds the line
        if (col >= wrapCol && ch !== "\n" && ch !== " ") {
          out += `\n${gutter(depth)}  `;
          col = 0;
        }

        // Soft-wrap: break at space before the line overflows.
        // We wrap when the *next* word would likely push past wrapCol.
        // Since we can't look ahead in streaming, we break at spaces
        // once we're within a small margin of the limit.
        if (ch === " " && col >= wrapCol - 1) {
          out += `\n${gutter(depth)}  `;
          col = 0;
          continue;
        }

        out += ch;
        if (ch === "\n") {
          lineStart = true;
          col = 0;
        } else {
          col++;
        }
      }
      return out;
    },
  };
}
