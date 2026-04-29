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

/** Wraps a payload in the sentinel markers for unquoting. */
function marked(payload: string): string {
  return `${UNQUOTE_MARKER}${payload}${UNQUOTE_MARKER}`;
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
 * Helper class for rendering debug-string representations of values.
 */
class DebugStringifier {
  #circles = new Set<object>();
  #unusedCircles = new Set<object>();
  #indent: number | undefined;
  #value: unknown;

  constructor(value: unknown, indent?: number) {
    this.#value = value;
    this.#indent = indent;
  }

  render() {
    this.#findCircles(this.#value);

    const rawResult = JSON.stringify(
      this.#value,
      (_key: string, value: unknown) => this.#replacer(value),
      this.#indent);

    return unquoteMarked(rawResult);
  }

  #findCircles(value: unknown, possibleCircles: Set<object> = new Set<object>()) {
    if (!value || (typeof value !== "object") || this.#circles.has(value)) {
      return;
    } else if (possibleCircles.has(value)) {
      this.#circles.add(value);
      this.#unusedCircles.add(value);
      return;
    }

    const valueObj = value as Record<string, unknown>;

    possibleCircles.add(value);
    for (const key in valueObj) {
      this.#findCircles(valueObj[key], possibleCircles);
    }
    possibleCircles.delete(value);
  }

  #replacer(value: unknown) {
    switch (typeof value) {
      case "bigint": {
        return marked(`${value}n`);
      }

      case "function": {
        return marked(
          value.name === ""
            ? "(...) => {...}"
            : `function ${value.name}(...) {...}`,
        );
      }

      case "number": {
        if (Number.isFinite(value)) {
          return Object.is(value, -0) ? marked("-0") : value;
        } else if (Number.isNaN(value)) {
          return marked("NaN");
        } else if (value === Infinity) {
          return marked("Infinity");
        } else if (value === -Infinity) {
          return marked("-Infinity");
        } else {
          // Shouldn't happen; there aren't any other non-finite possibilites.
          return marked(`<non-finite ${value}>`);
        }
      }

      case "object": {
        // TODO(danfuzz): This case will have to get smarter once we have
        // `FabricSpecialObject`s flowing through the system (which generally cannot
        // be stringified with full fidelity via `JSON.stringify()`'s default
        // behavior).

        if ((value !== null) && this.#circles.has(value)) {
          if (this.#unusedCircles.has(value)) {
            this.#unusedCircles.delete(value);
            return value;
          }
          return marked("<circle>");
        } else {
          return value;
        }
      }

      case "symbol": {
        const key = Symbol.keyFor(value);
        return marked(
          (key === undefined)
            ? `Symbol(${JSON.stringify(value.description ?? "")})`
            : `Symbol.for(${JSON.stringify(key)})`,
        );
      }

      case "undefined": {
        return marked("undefined");
      }

      default: {
        return value;
      }
    }
  }
}

/**
 * Renders the debug-string form of the given value with optional indentation.
 */
function renderDebugString(value: unknown, indent?: number) {
  try {
    return new DebugStringifier(value, indent).render();
  } catch {
    return "<unrenderable debug string>";
  }
}

/**
 * Produces a compact string representation of a value, optionally truncating to
 * a specified maximum length. When truncating is requested and turns out to be
 * necessary, the returned result will be the indicated length, which includes
 * an "ASCII ellipsis" of `...`.
 *
 * This function handles:
 * * all normal JSON-compatible values.
 * * other JavaScript primitive values:
 *   * bigints.
 *   * symbols, both interned and uninterned.
 *   * non-finite numbers.
 *   * `-0` rendered as such.
 * * functions, rendered in a simplified form and without any additional
 *   properties listed.
 * * objects which define `toJSON()`, calling that method in the usual way.
 * * objects and arrays with circular references, rendering the back-references
 *   as `<circle>`.
 *
 * If the stringification could not be completed (stack overflow, object
 * `toJSON()` conversion error, etc.), this function returns the literl string
 * `"<unrenderable debug string>"`.
 *
 * **Note:** In _many_ cases, the output of this function is valid JSON text,
 * but not _all_ cases. This function must _not_ be relied on to produce a
 * parseable string.
 */
export function toCompactDebugString(
  value: unknown,
  maxLength?: number,
): string {
  const result = renderDebugString(value);

  if (typeof maxLength === "number") {
    const actualMax = Math.max(Math.floor(maxLength), 3);
    if (result.length > actualMax) {
      return result.slice(0, actualMax - 3) + "...";
    }
  }

  return result;
}

/**
 * Produces an indented string representation of a value.
 *
 * This function handles:
 * * all normal JSON-compatible values.
 * * other JavaScript primitive values:
 *   * bigints.
 *   * symbols, both interned and uninterned.
 *   * non-finite numbers.
 *   * `-0` rendered as such.
 * * functions, rendered in a simplified form and without any additional
 *   properties listed.
 * * objects which define `toJSON()`, calling that method in the usual way.
 * * objects and arrays with circular references, rendering the back-references
 *   as `<circle>`.
 *
 * If the stringification could not be completed (stack overflow, object
 * `toJSON()` conversion error, etc.), this function returns the literl string
 * `"<unrenderable debug string>"`.
 *
 * **Note:** In _many_ cases, the output of this function is valid JSON text,
 * but not _all_ cases. This function must _not_ be relied on to produce a
 * parseable string.
 */
export function toIndentedDebugString(value: unknown): string {
  return renderDebugString(value, 2);
}
