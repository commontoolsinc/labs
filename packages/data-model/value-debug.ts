/**
 * Debugging-ish helpers for `FabricValue`s.
 */

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
 * `JSON.stringify()` replacer that handles values it otherwise mishandles for
 * our debugging purposes:
 *
 * - `bigint` (would throw),
 * - `undefined` (silently dropped/rewritten),
 * - `function` (silently dropped/rewritten),
 * - `symbol` (silently dropped/rewritten).
 *
 * The returned strings carry their desired bare-token form between sentinel
 * markers, which a post-processing pass strips along with the surrounding
 * JSON-string quotes.
 */
function debugReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return `${UNQUOTE_MARKER}${value}n${UNQUOTE_MARKER}`;
  } else if (value === undefined) {
    return `${UNQUOTE_MARKER}undefined${UNQUOTE_MARKER}`;
  } else if (typeof value === "function") {
    const payload = value.name === ""
      ? "(...) => {...}"
      : `function ${value.name}(...) {...}`;
    return `${UNQUOTE_MARKER}${payload}${UNQUOTE_MARKER}`;
  } else if (typeof value === "symbol") {
    const key = Symbol.keyFor(value);
    const payload = key !== undefined
      ? `Symbol.for(${JSON.stringify(key)})`
      : `Symbol(${JSON.stringify(value.description ?? "")})`;
    return `${UNQUOTE_MARKER}${payload}${UNQUOTE_MARKER}`;
  } else {
    return value;
  }
}

/**
 * Strips sentinel markers (and surrounding JSON quotes) in a stringify output.
 * The captured payload body is decoded back through `JSON.parse` so that any
 * quote / backslash escapes introduced by the outer `JSON.stringify` round-
 * trip are undone (e.g. so that the symbol-form payload `Symbol.for("name")`
 * retains its literal `"`s rather than coming out as `Symbol.for(\"name\")`).
 */
function unquoteMarked(json: string): string {
  return json.replace(UNQUOTE_RE, (_match, body) => {
    return JSON.parse(`"${body}"`);
  });
}

/**
 * Produces a compact string representation of a value. In _many_ cases, the
 * output of this function is valid JSON text, but not _all_ cases. This
 * function must _not_ be relied on to produce a parseable string.
 */
export function toCompactDebugString(value: unknown): string {
  // TODO(danfuzz): This function will have to get smarter once we have values
  // that go beyond what's representable as JSON text.
  return unquoteMarked(JSON.stringify(value, debugReplacer));
}

/**
 * Produces an indented string representation of a value. In _many_ cases, the
 * output of this function is valid JSON text, but not _all_ cases. This
 * function must _not_ be relied on to produce a parseable string.
 */
export function toIndentedDebugString(value: unknown): string {
  // TODO(danfuzz): This function will have to get smarter once we have values
  // that go beyond what's representable as JSON text.
  return unquoteMarked(JSON.stringify(value, debugReplacer, 2));
}
