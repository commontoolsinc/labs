/** Debugging-ish helpers for `FabricValue`s. */

import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import {
  FabricInstance,
  type FabricPlainObject,
  FabricPrimitive,
  FabricValue,
} from "./interface.ts";
// Imported from its own module rather than the package barrel, deliberately:
// the barrel pulls in every codec, and three of those import
// `ProblematicValue` -- a `BaseFabricInstance` subclass. Going through the
// barrel would make this module part of a cycle with the fabric base classes,
// whose custom inspectors import it, and an `extends` clause evaluated inside
// that cycle fails with "Cannot access 'BaseFabricInstance' before
// initialization". `codecOf.ts` itself is a leaf.
import { codecOf } from "@/codec-common/codecOf.ts";
import { isCodecTypeTag } from "@/codec-common/isCodecTypeTag.ts";
import { JSON_CODEC } from "@/codec-interface/interface.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";

/**
 * Renders a key -- an object property name or a symbol's key -- bare when it
 * is a valid identifier, and as a quoted string otherwise. The identifier
 * check is the ASCII one.
 */
function renderKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Produces the `/unconvertible` result form which stands in for a value whose
 * conversion threw, carrying the message of the error thrown.
 */
function makeUnconvertibleResult(error: any): FabricValue {
  const message = (() => {
    try {
      if (error instanceof Error) {
        const msg = error.message;
        if (typeof msg === "string") {
          return msg;
        }
      }
      return String(error);
    } catch {
      return "/unconvertibleError";
    }
  })();

  return { "/unconvertible": message };
}

/**
 * Helper class for converting values to their valid `FabricValue` debug
 * representations.
 */
class DebugConverter {
  readonly #value: any;
  readonly #maxDepth: number;
  readonly #replacer: undefined | ((value: any) => any);
  readonly #nestingStack = new Map<object, number>();

  /**
   * Constructs an instance.
   */
  constructor(
    /** Value to convert. */
    value: unknown,
    /** Maximum nesting depth. */
    maxDepth: number,
    /** Replacer function. */
    replacer?: (value: any) => any,
  ) {
    this.#value = value;
    this.#maxDepth = maxDepth;
    this.#replacer = replacer;
  }

  //
  // Instance members
  //

  /**
   * Converts the configured value. This method is meant to be called no more
   * than once per instance of this class. In particular, it doesn't cache the
   * result, so a second call repeats the conversion.
   */
  convert(): FabricValue {
    try {
      return this.#convertSubvalue(this.#value, 0);
      // deno-coverage-ignore-start
    } catch (e) {
      // There is an inner `try-catch` which should catch most conversion errors
      // close to where they're thrown. This `catch` is a prophylactic "just
      // in case" to help nail down the intention of really really trying not to
      // `throw` out of this method.
      return makeUnconvertibleResult(e);
    }
    // deno-coverage-ignore-stop
  }

  /**
   * Converts an array, which is known to be at the indicated nesting depth.
   */
  #convertArray(value: any, depth: number): FabricValue {
    const result: FabricValue[] = [];
    // An array is indexable by property name directly, so the index names
    // `Object.keys()` yields are used as they come.
    const byName = result as unknown as Record<string, FabricValue>;

    result.length = value.length;
    for (const key of Object.keys(value)) {
      if (!isArrayIndexPropertyName(key)) {
        // It's a named property. Intentionally skipped as part of conforming to
        // `FabricValue`.
        continue;
      }

      try {
        byName[key] = this.#convertSubvalue(value[key], depth + 1);
      } catch (e) {
        byName[key] = makeUnconvertibleResult(e);
      }
    }

    return result;
  }

  /**
   * Converts a general instance (non-plain, non-`FabricValue` object), which is
   * known to be at the indicated nesting depth.
   */
  #convertInstance(value: any, depth: number): FabricValue {
    const className =
      (value as { constructor?: { name?: string } }).constructor?.name ??
        "<anonymous>";
    const tag = `/${className}`;

    const stringForm = value.toString();
    if (typeof stringForm === "string") {
      const matchedGenericName: string | undefined = stringForm.match(
        /^\[object (?<name>[a-zA-Z0-9_$]+)\]$/,
      )?.groups?.name;
      if (
        (matchedGenericName !== "Object") && (matchedGenericName !== className)
      ) {
        return { [tag]: stringForm };
      }
    }

    if (typeof value.toJSON === "function") {
      return { [tag]: this.#convertSubvalue(value.toJSON(), depth + 1) };
    }

    const props = { ...value };
    const converted = (Object.keys(props).length !== 0)
      ? this.#convertSubvalue(props, depth + 1)
      : "/...";
    return { [tag]: converted };
  }

  /**
   * Converts a plain object, which is known to be at the indicated nesting depth.
   */
  #convertPlainObject(value: any, depth: number): FabricValue {
    const result: Record<string, FabricValue> = {};

    for (const key of Object.keys(value)) {
      const resultKey = (isUnsafeObjectKey(key) || (key[0] === "/"))
        ? `/${key}`
        : key;
      try {
        result[resultKey] = this.#convertSubvalue(value[key], depth + 1);
      } catch (e) {
        result[resultKey] = makeUnconvertibleResult(e);
      }
    }

    return result;
  }

  /**
   * Converts the given value, which is known to be at the indicated nesting
   * depth.
   */
  #convertSubvalue(value: any, depth: number): FabricValue {
    try {
      // Give the `replacer` (if supplied) an opportunity to perform replacement.
      value = this.#replacer ? this.#replacer(value) : value;
    } catch {
      // Fall through: Treat `replacer` failure as refusal to replace and not an
      // actual error.
    }

    // Handle all the straightforward cases.
    switch (typeof value) {
      case "bigint":
      case "boolean":
      case "number":
      case "string":
      case "undefined": {
        return value;
      }

      case "symbol": {
        const key = Symbol.keyFor(value);
        if (key === undefined) {
          // Unique (uninterned) symbol.
          return { "/uniqueSymbol": value.description };
        } else {
          // Interned symbol.
          return value;
        }
      }

      case "function": {
        try {
          const name = value.name;
          const content = (name != "") ? `${name}(...)` : "<anonymous>(...)";
          return { "/function": content };
        } catch (e) {
          return { "/function": makeUnconvertibleResult(e) };
        }
      }

      case "object": {
        if (value === null) {
          return null;
        }
        break;
      }

      // deno-coverage-ignore-start
      // This will only happen if JS introduces a new type.
      default: {
        throw new Error(`Shouldn't happen: unknown type \`${typeof value}\``);
      }
        // deno-coverage-ignore-stop
    }

    // We have a non-null object of some sort.

    try {
      if (value instanceof FabricPrimitive) {
        // These can in effect require an additional layer of nesting to
        // convert, by the time they actually hit _some_ real transports. We
        // hereby accept the fact that there can be an arguable inconsistency
        // between intended and actual maximum nesting when these are converted
        // "at the edge."
        return value;
      }

      const nestedAt = this.#nestingStack.get(value);
      if (nestedAt !== undefined) {
        return { "/circle": nestedAt };
      }

      if (depth >= this.#maxDepth) {
        return { "/...": toDebugKindString(value) };
      }

      this.#nestingStack.set(value, depth);

      try {
        if (value instanceof FabricInstance) {
          const codec = codecOf(value);
          const tag = codec.tagForValue(value);
          const contents = codec.encode(value, NULL_LIVE_ENVIRONMENT);
          return { [`/${tag}`]: this.#convertSubvalue(contents, depth + 1) };
        } else if (Array.isArray(value)) {
          return this.#convertArray(value, depth);
        } else if (isPlainObject(value)) {
          return this.#convertPlainObject(value, depth);
        } else {
          return this.#convertInstance(value, depth);
        }
      } finally {
        this.#nestingStack.delete(value);
      }
    } catch (e) {
      return makeUnconvertibleResult(e);
    }
  }
}

/**
 * Helper class for rendering the result of `toStructuredDebugValue()` as a
 * debug string, for a human to read. The rendering follows JSON syntax where
 * that suffices and departs from it where it does not; the details are the
 * renderer's to change, and the case files under `test/value-debug-cases/`
 * are what records them.
 */
class DebugStringifier {
  readonly #indent: string | undefined;

  /**
   * Constructs an instance which renders using `indent` spaces per nesting
   * level when given, and on a single line when not.
   */
  constructor(indent?: number) {
    this.#indent = (indent === undefined) ? undefined : " ".repeat(indent);
  }

  //
  // Instance members
  //

  /** Renders the given value. */
  render(value: FabricValue): string {
    return this.#renderSubvalue(value, "");
  }

  /**
   * Renders an array, whose closing bracket (when the rendering is multi-line)
   * is indented by `indent`.
   */
  #renderArray(value: readonly FabricValue[], indent: string): string {
    const inner = this.#innerIndent(indent);
    const parts: string[] = [];

    // Iterated by index rather than by element, so that a hole is noticed. A
    // run of holes renders as a single part which says how long the run is.
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        parts.push(this.#renderSubvalue(value[i], inner));
        continue;
      }

      let holeCount = 1;
      while (((i + 1) < value.length) && !((i + 1) in value)) {
        holeCount++;
        i++;
      }
      parts.push((holeCount === 1) ? "<hole>" : `<${holeCount} holes>`);
    }

    return this.#renderContainer("[", "]", parts, indent);
  }

  /**
   * Renders a container from its already-rendered parts, given the opening and
   * closing bracket text and the indentation of the closing bracket.
   */
  #renderContainer(
    open: string,
    close: string,
    parts: string[],
    indent: string,
  ): string {
    if (parts.length === 0) {
      return `${open}${close}`;
    } else if (this.#indent === undefined) {
      return `${open}${parts.join(",")}${close}`;
    }

    const inner = this.#innerIndent(indent);
    return `${open}\n${inner}${parts.join(`,\n${inner}`)}\n${indent}${close}`;
  }

  /**
   * Renders a `FabricPrimitive`, in the elided form `/TypeName(...)`, where the
   * type name is that of its codec type tag. When the codec cannot be found,
   * the class name stands in for the type name.
   */
  #renderFabricPrimitive(value: FabricPrimitive): string {
    let tag;

    try {
      // A `FabricPrimitive` binds no `[CODEC]`, so its JSON codec supplies the
      // tag. TODO(danfuzz): Replace `JSON_CODEC` with `DEBUG_CODEC` once the
      // latter exists.
      tag = codecOf(value, JSON_CODEC).tagForValue(value);
    } catch {
      // Never let the debug renderer throw; fall back to the class name.
      tag = value.constructor?.name ?? "<anonymous>";
    }

    return DebugStringifier.#renderElidedInstance(tag);
  }

  /**
   * Renders a class instance which the conversion carried under its class
   * name, as `/ClassName(<props>)` when its payload is its properties and as
   * `/ClassName(...)` when the conversion had nothing to show for it. Any
   * other payload -- a `toString()` form, or what `toJSON()` returned -- is
   * rendered as it stands inside the parentheses.
   */
  #renderInstance(
    className: string,
    payload: FabricValue,
    indent: string,
  ): string {
    const open = `/${className}(`;

    if (payload === "/...") {
      return `${open}...)`;
    } else if (isPlainObject(payload)) {
      const parts = this.#renderProperties(
        payload as FabricPlainObject,
        indent,
      );
      return this.#renderContainer(open, ")", parts, indent);
    } else {
      // The payload sits where the parenthesis opens, so it takes the
      // indentation of the parenthesis itself.
      return `${open}${this.#renderSubvalue(payload, indent)})`;
    }
  }

  /**
   * Renders a plain object, whose closing brace (when the rendering is
   * multi-line) is indented by `indent`.
   */
  #renderPlainObject(value: FabricPlainObject, indent: string): string {
    const keys = Object.keys(value);
    const onlyKey = (keys.length === 1) ? keys[0] : undefined;

    if (
      (onlyKey !== undefined) && (onlyKey[0] === "/") && (onlyKey[1] !== "/") &&
      !isUnsafeObjectKey(onlyKey.slice(1))
    ) {
      // The conversion's single-key tagged forms. No key of the original value
      // can arrive here in one of these forms, because the conversion escapes
      // a key with a leading slash and an unsafe key alike, by prefixing a
      // slash; the second-character check rules out the one and the
      // unsafe-key check the other.
      const tag = onlyKey.slice(1);
      const payload = value[onlyKey];

      if (isCodecTypeTag(tag)) {
        // A `FabricInstance`, carried as its encoding under its codec type tag.
        return DebugStringifier.#renderElidedInstance(tag);
      }

      switch (tag) {
        case "circle": {
          // A reference back to an enclosing object.
          return "<circle>";
        }

        case "uniqueSymbol": {
          // A unique (uninterned) symbol, whose payload is its description.
          return (payload === undefined)
            ? "Symbol()"
            : `Symbol(${JSON.stringify(payload)})`;
        }

        case "function": {
          // A function, whose payload names it, or is `/unconvertible` when
          // even that failed; the latter falls through to render as it is.
          const name = (typeof payload === "string")
            ? payload.match(/^(?<name>.*)\(\.\.\.\)$/)?.groups?.name
            : undefined;
          if (name === "<anonymous>") {
            return "(...) => {...}";
          } else if (name !== undefined) {
            return `function ${name}(...) {...}`;
          }
          break;
        }

        case "...":
        case "unconvertible": {
          // The remaining markers, rendered as the objects they are, their
          // keys included.
          const parts = this.#renderProperties(value, indent, false);
          return this.#renderContainer("{", "}", parts, indent);
        }

        default: {
          // A class instance, carried under its class name.
          return this.#renderInstance(tag, payload, indent);
        }
      }
    }

    const parts = this.#renderProperties(value, indent);
    return this.#renderContainer("{", "}", parts, indent);
  }

  /**
   * Renders the properties of a plain object, one part per property, for a
   * container whose closing bracket is indented by `indent`. When `unescape`
   * is `true` (the default), a key is rendered as the original value's key:
   * the conversion prefixes a slash to a key that starts with one and to an
   * unsafe key, and that slash comes back off here.
   */
  #renderProperties(
    value: FabricPlainObject,
    indent: string,
    unescape = true,
  ): string[] {
    const inner = this.#innerIndent(indent);
    const separator = (this.#indent === undefined) ? ":" : ": ";

    return Object.keys(value).map((key) => {
      const original = (unescape && (key[0] === "/")) ? key.slice(1) : key;
      const rendered = this.#renderSubvalue(value[key], inner);
      return `${renderKey(original)}${separator}${rendered}`;
    });
  }

  /**
   * Renders the given value, whose closing bracket (when the value is a
   * container and the rendering is multi-line) is indented by `indent`.
   */
  #renderSubvalue(value: FabricValue, indent: string): string {
    switch (typeof value) {
      case "bigint": {
        return `${value}n`;
      }

      case "boolean":
      case "undefined": {
        return String(value);
      }

      case "number": {
        // `String(-0)` is `0`, so negative zero is the one number that needs
        // special handling.
        return Object.is(value, -0) ? "-0" : String(value);
      }

      case "string": {
        return JSON.stringify(value);
      }

      case "symbol": {
        // The conversion represents a unique symbol as a tagged object, so
        // only an interned symbol arrives here.
        return `@${renderKey(Symbol.keyFor(value) ?? "")}`;
      }

      case "object": {
        if (value === null) {
          return "null";
        } else if (Array.isArray(value)) {
          return this.#renderArray(value, indent);
        } else if (value instanceof FabricPrimitive) {
          return this.#renderFabricPrimitive(value);
        } else {
          // The conversion represents every other non-plain object as a plain
          // one, so what is left is a plain object.
          return this.#renderPlainObject(value as FabricPlainObject, indent);
        }
      }

      // deno-coverage-ignore-start
      // This will only happen if JS introduces a new type.
      default: {
        throw new Error(`Shouldn't happen: unknown type \`${typeof value}\``);
      }
        // deno-coverage-ignore-stop
    }
  }

  /** Returns the indentation for the contents of a container indented by `indent`. */
  #innerIndent(indent: string): string {
    return `${indent}${this.#indent ?? ""}`;
  }

  //
  // Static members
  //

  /**
   * Renders the elided form of a `FabricInstance` or `FabricPrimitive`, given
   * its codec type tag (or, failing that, its class name). The slash suggests
   * a known encodable type rather than an instance of some random class, and
   * the version of the tag is left out.
   */
  static #renderElidedInstance(tag: string): string {
    return `/${tag.replace(/@.*$/, "")}(...)`;
  }
}

/**
 * Renders the debug-string form of the given value with optional indentation,
 * by converting it with `toStructuredDebugValue()` and rendering the result.
 */
function renderDebugString(value: unknown, indent?: number): string {
  try {
    return new DebugStringifier(indent).render(toStructuredDebugValue(value));
    // deno-coverage-ignore-start
  } catch {
    // Neither the conversion nor the rendering is meant to throw. This `catch`
    // is a prophylactic "just in case" to nail down the intention of really
    // really trying not to `throw` out of this function.
    return "<unrenderable debug string>";
  }
  // deno-coverage-ignore-stop
}

/**
 * Produces a compact string representation of a value, optionally truncating to
 * a specified maximum length. When truncating is requested and turns out to be
 * necessary, the returned result will be the indicated length, which includes
 * an "ASCII ellipsis" of `...`.
 *
 * The value is first converted with `toStructuredDebugValue()`, and it is that
 * result which gets rendered. This function handles:
 * * all normal JSON-compatible values.
 * * other JavaScript primitive values:
 *   * bigints.
 *   * symbols, both interned and uninterned.
 *   * non-finite numbers.
 *   * `-0`.
 * * functions.
 * * `FabricInstance`s and `FabricPrimitive`s.
 * * instances of other classes.
 * * objects and arrays with circular references.
 * * arrays with holes.
 *
 * How any of these renders is _not_ a contract. The rendering is meant for a
 * human reading a diagnostic, and it changes as that reading is improved;
 * nothing but a test should depend on its details.
 *
 * If the rendering could not be completed, this function returns the literal
 * string `"<unrenderable debug string>"`.
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
 * Like `toCompactDebugString()`, except that the result is indented by two
 * spaces per nesting level, and is never truncated.
 */
export function toIndentedDebugString(value: unknown): string {
  return renderDebugString(value, 2);
}

/**
 * Produces a short human-readable kind-string for a value, suitable for
 * error messages and other diagnostic contexts where the caller wants to
 * say something like _"can't operate on a `${toDebugKindString(value)}`"_.
 *
 * Distinguishes:
 *
 * - `null` / `undefined` -- rendered literally.
 * - Plain objects and arrays -- `"object"` / `"array"`.
 * - `FabricInstance` and `FabricPrimitive` -- rendered with their concrete
 *   subclass constructor name (e.g. `"FabricInstance (FabricError)"`).
 * - Other class instances -- rendered with their constructor name.
 * - JS primitives -- rendered as their `typeof` (`"number"`, `"string"`,
 *   `"bigint"`, `"boolean"`, `"symbol"`, `"function"`).
 */
export function toDebugKindString(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  if (value instanceof FabricInstance) {
    return `FabricInstance (${value.constructor.name})`;
  }
  if (value instanceof FabricPrimitive) {
    return `FabricPrimitive (${value.constructor.name})`;
  }
  if (isPlainObject(value)) return "object";
  return value.constructor?.name ?? "object";
}

/**
 * Produces a valid `FabricValue` meant to represent the given value as
 * accurately as possible, suitable for use in debugging, including rendering as
 * a debug string or including in a structured debug log. All valid
 * `FabricValue`s are self-represented in the result. Beyond that, no specific
 * guarantees are made as to the exact nature of the conversion. The general aim
 * is to represent non-`FabricValue` results in a way reminiscent of the
 * `codec-json` encoding form, and with as little chance for ambiguity as can
 * be reasonably achieved.
 *
 * If a `maxDepth` is supplied as a positive integer, that is the nesting limit
 * of the result. Any items which would require further nesting are instead
 * converted into a form suggestive of the elided information.
 *
 * If a `replacer` is supplied, it is called on every value and sub-value
 * encountered, to get a replacement value to use. If the `replacer` does not
 * want to replace the value, then it should return the value it receives.
 *
 * If the conversion could not be completed (stack overflow, object
 * `toJSON()` conversion error, etc.), this function returns the literal value
 * `{ "/unconvertible": "<errorMessage>" }`.
 *
 * @throws {Error} if given an invalid value for `maxDepth`.
 */
export function toStructuredDebugValue(
  /** Value to convert. */
  value: any,
  /**
   * Maximum depth of result nesting. Must be a positive integer or `undefined`
   * if specified. `undefined` and large integers are taken to mean "as high as
   * reasonably possible." There is no guarantee about the _actual_ possible
   * maximum depth.
   */
  maxDepth?: number | undefined,
  /** Replacer function, if desired. */
  replacer?: (value: any) => any,
): FabricValue {
  const ACTUAL_MAX = 100; // To prevent blowing out the stack when converting.

  // Validate `maxDepth` and transform as necessary.
  maxDepth = (() => {
    switch (typeof maxDepth) {
      case "number": {
        if (Number.isSafeInteger(maxDepth) && (maxDepth > 0)) {
          return Math.min(maxDepth, ACTUAL_MAX);
        }
        break;
      }
      case "undefined": {
        return ACTUAL_MAX;
      }
    }

    const badDepth = backtickQuote(toCompactDebugString(maxDepth, 20));
    throw new Error(
      `\`maxDepth\` must be a positive integer or \`undefined\`; got ${badDepth}`,
    );
  })();

  // We subtract one from `maxDepth` because the "suggestive forms" for elided
  // data all use one layer of depth.
  return new DebugConverter(value, maxDepth - 1, replacer).convert();
}
