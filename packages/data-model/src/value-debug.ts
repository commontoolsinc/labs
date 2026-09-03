/** Debugging-ish helpers for `FabricValue`s. */

import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import {
  type CompactDebugStringOptions,
  type DebugValueOptions,
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
import { REALM_CODEC } from "@/codec-interface/interface.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";
import type { RealmCodecValue } from "@/codec-realm/interface.ts";

/**
 * Nesting depth a conversion stops at whatever its options say, so that
 * converting cannot blow out the stack.
 */
const ABSOLUTE_MAX_DEPTH = 100;

/** Nesting depth a debug string renders to, when its options do not say. */
const DEFAULT_STRING_MAX_DEPTH = 10;

/**
 * What a `FabricPrimitive`'s codec hands back to be rendered: the
 * realm-crossing encoding of a terminal codec, or the expansion of a
 * nonterminal one into other `FabricValue`s.
 */
type PrimitiveState = RealmCodecValue | FabricValue;

/**
 * One of the conversion's single-key tagged forms, taken apart: the tag,
 * less its leading slash, and the payload under it.
 */
type TaggedForm = { readonly tag: string; readonly payload: FabricValue };

/**
 * Returns the class name of the given object, or `<anonymous>` when it has
 * none. A class with no name reports it as the empty string, which counts.
 */
function classNameOf(value: object): string {
  const name = (value as { constructor?: { name?: unknown } }).constructor
    ?.name;
  return ((typeof name === "string") && (name !== "")) ? name : "<anonymous>";
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
      return DebugConverter.#makeUnconvertibleResult(e);
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
        byName[key] = DebugConverter.#makeUnconvertibleResult(e);
      }
    }

    return result;
  }

  /**
   * Converts a general instance (non-plain, non-`FabricValue` object), which is
   * known to be at the indicated nesting depth.
   */
  #convertInstance(value: any, depth: number): FabricValue {
    const className = classNameOf(value);
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
        result[resultKey] = DebugConverter.#makeUnconvertibleResult(e);
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
          return { "/function": DebugConverter.#makeUnconvertibleResult(e) };
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
      return DebugConverter.#makeUnconvertibleResult(e);
    }
  }

  //
  // Static members
  //

  /**
   * Produces the `/unconvertible` result form which stands in for a value whose
   * conversion threw, carrying the message of the error thrown.
   */
  static #makeUnconvertibleResult(error: any): FabricValue {
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
}

/**
 * Helper class for rendering the result of `toStructuredDebugValue()` as a
 * debug string, for a human to read. The rendering follows JSON syntax where
 * that suffices and departs from it where it does not; the details are the
 * renderer's to change, and the case files under `test/value-debug-cases/`
 * are what records them.
 */
class DebugStringifier {
  readonly #options: DebugValueOptions;
  readonly #indent: string | undefined;

  /**
   * Constructs an instance which renders using `indent` spaces per nesting
   * level when given, and on a single line when not. A value which turns up
   * unconverted while rendering is converted with `options`.
   */
  constructor(options: DebugValueOptions, indent?: number) {
    this.#options = options;
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
   * Renders a `FabricPrimitive` as `/TypeName(<state>)`, where the type name
   * is that of its codec type tag and the state is its realm-crossing
   * encoding, in the same form a class instance's properties take. When the
   * codec cannot be found, the class name stands in for the type name and the
   * state is elided.
   */
  #renderFabricPrimitive(value: FabricPrimitive, indent: string): string {
    let tag: string;
    let state: PrimitiveState;

    try {
      // A `FabricPrimitive` binds no `[CODEC]`, so its realm codec supplies
      // the tag and the state. That codec is the one whose terminals are the
      // richest -- a `bigint` stays a `bigint`, bytes stay bytes -- which is
      // what makes it the one to render. TODO(danfuzz): Replace `REALM_CODEC`
      // with `DEBUG_CODEC` once the latter exists.
      const codec = codecOf<RealmCodecValue>(value, REALM_CODEC);
      tag = codec.tagForValue(value);
      state = codec.encode(value, NULL_LIVE_ENVIRONMENT);
    } catch {
      // Never let the debug renderer throw; fall back to the class name, with
      // the state elided.
      return DebugStringifier.#renderElidedInstance(classNameOf(value));
    }

    const open = `/${DebugStringifier.#typeNameOf(tag)}(`;
    const realm = (v: PrimitiveState, i: string) =>
      this.#renderRealmState(v, i);

    if (isPlainObject(state)) {
      const parts = this.#renderProperties(
        state as { readonly [key: string]: PrimitiveState },
        indent,
        realm,
        false,
      );
      return this.#renderContainer(open, ")", parts, indent);
    } else {
      return `${open}${this.#renderRealmState(state, indent)})`;
    }
  }

  /**
   * Renders a realm-crossing encoding, or a piece of one. The encoding's own
   * terminal, an `ArrayBuffer`, is rendered as `buf [...]`; its containers are
   * walked as they stand; and anything else takes the ordinary path through
   * the conversion.
   */
  #renderRealmState(value: PrimitiveState, indent: string): string {
    const realm = (v: PrimitiveState, i: string) =>
      this.#renderRealmState(v, i);

    if (value instanceof ArrayBuffer) {
      return DebugStringifier.#renderBuffer(value);
    } else if (Array.isArray(value)) {
      const inner = this.#innerIndent(indent);
      const parts = value.map((element) => realm(element, inner));
      return this.#renderContainer("[", "]", parts, indent);
    } else if (isPlainObject(value)) {
      const parts = this.#renderProperties(
        value as { readonly [key: string]: PrimitiveState },
        indent,
        realm,
        false,
      );
      return this.#renderContainer("{", "}", parts, indent);
    } else {
      return this.#renderSubvalue(
        toStructuredDebugValue(value, this.#options),
        indent,
      );
    }
  }

  /**
   * Renders a class instance which the conversion carried under its class
   * name, or a `FabricInstance` carried under its type name, as
   * `/Name(<props>)` when its payload is a plain object of properties and as
   * `/Name(...)` when the conversion had nothing to show for it. Any other
   * payload -- a `toString()` form, what `toJSON()` returned, or an encoding
   * that is not a plain object -- is rendered as it stands inside the
   * parentheses.
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
      const tagged = DebugStringifier.#taggedFormOf(
        payload as FabricPlainObject,
      );

      if (tagged !== undefined) {
        // A marker form, rendered as what it stands for rather than spread as
        // properties.
        return `${open}${this.#renderTaggedForm(tagged, indent)})`;
      } else {
        const parts = this.#renderProperties(
          payload as FabricPlainObject,
          indent,
        );
        return this.#renderContainer(open, ")", parts, indent);
      }
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
    const tagged = DebugStringifier.#taggedFormOf(value);

    if (tagged !== undefined) {
      return this.#renderTaggedForm(tagged, indent);
    } else {
      const parts = this.#renderProperties(value, indent);
      return this.#renderContainer("{", "}", parts, indent);
    }
  }

  /**
   * Renders the properties of a plain object, one part per property, for a
   * container whose closing bracket is indented by `indent`, each value
   * rendered by `render` (by default, as a converted value). When `unescape`
   * is `true` (the default), a key is rendered as the original value's key:
   * the conversion prefixes a slash to a key that starts with one and to an
   * unsafe key, and that slash comes back off here.
   */
  #renderProperties<T>(
    value: { readonly [key: string]: T },
    indent: string,
    render: (value: T, indent: string) => string = (v, i) =>
      this.#renderSubvalue(v as unknown as FabricValue, i),
    unescape = true,
  ): string[] {
    const inner = this.#innerIndent(indent);
    const separator = (this.#indent === undefined) ? ":" : ": ";

    return Object.entries(value).map(([key, subvalue]) => {
      const original = (unescape && (key[0] === "/")) ? key.slice(1) : key;
      const rendered = render(subvalue, inner);
      return `${DebugStringifier.#renderKey(original)}${separator}${rendered}`;
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
        return `@${DebugStringifier.#renderKey(Symbol.keyFor(value) ?? "")}`;
      }

      case "object": {
        if (value === null) {
          return "null";
        } else if (Array.isArray(value)) {
          return this.#renderArray(value, indent);
        } else if (value instanceof FabricPrimitive) {
          return this.#renderFabricPrimitive(value, indent);
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

  /**
   * Renders one of the conversion's single-key tagged forms, as what it
   * stands for, with a container's closing bracket (when there is one and
   * the rendering is multi-line) indented by `indent`.
   */
  #renderTaggedForm(tagged: TaggedForm, indent: string): string {
    const { tag, payload } = tagged;

    if (isCodecTypeTag(tag)) {
      // A `FabricInstance`, carried as its encoding under its codec type tag,
      // laid out the way a class instance is.
      return this.#renderInstance(
        DebugStringifier.#typeNameOf(tag),
        payload,
        indent,
      );
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
        return this.#renderInstance(tag, payload, indent);
      }

      case "unconvertible": {
        // A value the conversion could not read, whose payload is the
        // error's message.
        return this.#renderInstance(tag, payload, indent);
      }

      case "...": {
        // The depth-limit marker. What kind of value was elided is left
        // out of the rendering.
        return "...";
      }

      default: {
        // A class instance, carried under its class name.
        return this.#renderInstance(tag, payload, indent);
      }
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
   * Renders an `ArrayBuffer` as `buf [...]`, with its bytes in hexadecimal, a
   * space after every fourth byte.
   */
  static #renderBuffer(buffer: ArrayBuffer): string {
    const hex = [...new Uint8Array(buffer)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .replace(/.{8}(?=.)/g, "$& ");
    return `buf [${hex}]`;
  }

  /**
   * Renders the elided form of a `FabricPrimitive` whose state cannot be had,
   * given its class name. The slash suggests a known encodable type rather
   * than an instance of some random class.
   */
  static #renderElidedInstance(name: string): string {
    return `/${name}(...)`;
  }

  /**
   * Returns the type name of a codec type tag: the tag less its encoding
   * version, which a rendering leaves out.
   */
  static #typeNameOf(tag: string): string {
    return tag.replace(/@.*$/, "");
  }

  /**
   * Renders a key -- an object property name or a symbol's key -- bare when it
   * is a valid identifier, and as a quoted string otherwise. The identifier
   * check is the ASCII one.
   */
  static #renderKey(key: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
  }

  /**
   * Returns the tag and payload of the given plain object when it is one of the
   * conversion's single-key tagged forms, and `undefined` when it is not. No key
   * of an original value can arrive in such a form, because the conversion
   * escapes a key with a leading slash and an unsafe key alike, by prefixing a
   * slash; the second-character check rules out the one and the unsafe-key
   * check the other.
   */
  static #taggedFormOf(value: FabricPlainObject): TaggedForm | undefined {
    const keys = Object.keys(value);
    const onlyKey = (keys.length === 1) ? keys[0] : undefined;

    if (
      (onlyKey === undefined) || (onlyKey[0] !== "/") || (onlyKey[1] === "/") ||
      isUnsafeObjectKey(onlyKey.slice(1))
    ) {
      return undefined;
    }

    return { tag: onlyKey.slice(1), payload: value[onlyKey] };
  }
}

/**
 * Helper for the entry points, which validates `options` and returns the
 * maximum nesting depth they call for: their `maxDepth` when present, and
 * `defaultMaxDepth` when not, either one capped at `ABSOLUTE_MAX_DEPTH`.
 *
 * @throws {Error} if `options` is not a plain object, or if its `maxDepth` is
 * not a positive integer.
 */
function checkedMaxDepth(
  options: DebugValueOptions | undefined,
  defaultMaxDepth: number,
): number {
  if ((options !== undefined) && !isPlainObject(options)) {
    const badOptions = backtickQuote(
      toCompactDebugString(options, { maxLength: 20 }),
    );
    throw new Error(
      `\`options\` must be a plain object or \`undefined\`; got ${badOptions}`,
    );
  }

  const maxDepth = options?.maxDepth;

  switch (typeof maxDepth) {
    case "number": {
      if (Number.isSafeInteger(maxDepth) && (maxDepth > 0)) {
        return Math.min(maxDepth, ABSOLUTE_MAX_DEPTH);
      }
      break;
    }
    case "undefined": {
      return Math.min(defaultMaxDepth, ABSOLUTE_MAX_DEPTH);
    }
  }

  const badDepth = backtickQuote(
    toCompactDebugString(maxDepth, { maxLength: 20 }),
  );
  throw new Error(
    `\`maxDepth\` must be a positive integer or \`undefined\`; got ${badDepth}`,
  );
}

/**
 * Renders the debug-string form of the given value with optional indentation,
 * by converting it with `toStructuredDebugValue()` per `options` and rendering
 * the result. A depth the options leave unsaid is `DEFAULT_STRING_MAX_DEPTH`.
 *
 * @throws {Error} if given invalid `options`.
 */
function renderDebugString(
  value: unknown,
  options: DebugValueOptions | undefined,
  indent?: number,
): string {
  const converterOptions: DebugValueOptions = {
    ...options,
    maxDepth: checkedMaxDepth(options, DEFAULT_STRING_MAX_DEPTH),
  };

  try {
    const converted = toStructuredDebugValue(value, converterOptions);
    return new DebugStringifier(converterOptions, indent).render(converted);
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
 * the maximum length given in `options`. When truncating is requested and turns
 * out to be necessary, the returned result will be the indicated length, which
 * includes an "ASCII ellipsis" of `...`.
 *
 * The value is first converted with `toStructuredDebugValue()`, passing along
 * the depth limit and replacer given in `options`, and it is that result which
 * gets rendered. This function handles:
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
 * The rendering stops at the nesting depth given in `options`, ten levels
 * when not given, below which a value is elided.
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
 *
 * @throws {Error} if given invalid `options`.
 */
export function toCompactDebugString(
  value: unknown,
  options?: CompactDebugStringOptions,
): string {
  const result = renderDebugString(value, options);
  const maxLength = options?.maxLength;

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
 * spaces per nesting level, and is never truncated for length, there being no
 * length to give. The depth limit and replacer apply to both.
 *
 * @throws {Error} if given invalid `options`.
 */
export function toIndentedDebugString(
  value: unknown,
  options?: DebugValueOptions,
): string {
  return renderDebugString(value, options, 2);
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
 * The nesting limit of the result and a replacer to consult are the
 * `maxDepth` and `replacer` of `options`. When there is no limit given, the
 * result nests as deep as reasonably possible.
 *
 * If the conversion could not be completed (stack overflow, object
 * `toJSON()` conversion error, etc.), this function returns the literal value
 * `{ "/unconvertible": "<errorMessage>" }`.
 *
 * @throws {Error} if given invalid `options`.
 */
export function toStructuredDebugValue(
  /** Value to convert. */
  value: any,
  /** Conversion options, if desired. */
  options?: DebugValueOptions,
): FabricValue {
  const maxDepth = checkedMaxDepth(options, ABSOLUTE_MAX_DEPTH);

  // We subtract one from `maxDepth` because the "suggestive forms" for elided
  // data all use one layer of depth.
  return new DebugConverter(value, maxDepth - 1, options?.replacer).convert();
}
