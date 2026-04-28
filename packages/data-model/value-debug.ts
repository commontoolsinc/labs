/**
 * Debugging-ish helpers for `FabricValue`s.
 */

import type { FabricValue } from "./interface.ts";

/**
 * Sentinel marker used to wrap content that should appear unquoted in the
 * final output. The replacer brackets a bare-token payload (e.g. `42n` or
 * `undefined`) with this marker; a post-processing pass then strips both the
 * markers and the surrounding JSON-string quotes.
 */
const UNQUOTE_MARKER = "@@DEBUG_UNQUOTE@@";

/** Regex matching a marked, JSON-quoted payload. Group 1 is the payload. */
const UNQUOTE_RE = /"@@DEBUG_UNQUOTE@@(.*?)@@DEBUG_UNQUOTE@@"/g;

/**
 * `JSON.stringify()` replacer that handles `bigint` and `undefined`, which it
 * otherwise mishandles for our debugging purposes (throws on `bigint`, and
 * silently drops/rewrites `undefined`). The returned strings carry their
 * desired bare-token form between sentinel markers.
 */
function debugReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return `${UNQUOTE_MARKER}${value}n${UNQUOTE_MARKER}`;
  } else if (value === undefined) {
    return `${UNQUOTE_MARKER}undefined${UNQUOTE_MARKER}`;
  } else {
    return value;
  }
}

/** Strips sentinel markers (and surrounding JSON quotes) in a stringify output. */
function unquoteMarked(json: string): string {
  return json.replace(UNQUOTE_RE, "$1");
}

/**
 * Produces a compact string representation of a value. In _many_ cases, the
 * output of this function is valid JSON text, but not _all_ cases. This
 * function must _not_ be relied on to produce a parseable string.
 */
export function toCompactDebugString(value: FabricValue): string {
  // TODO(danfuzz): This function will have to get smarter once we have values
  // that go beyond what's representable as JSON text.
  return unquoteMarked(JSON.stringify(value, debugReplacer));
}

/**
 * Produces an indented string representation of a value. In _many_ cases, the
 * output of this function is valid JSON text, but not _all_ cases. This
 * function must _not_ be relied on to produce a parseable string.
 */
export function toIndentedDebugString(value: FabricValue): string {
  // TODO(danfuzz): This function will have to get smarter once we have values
  // that go beyond what's representable as JSON text.
  return unquoteMarked(JSON.stringify(value, debugReplacer, 2));
}
