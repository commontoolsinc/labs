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
 * Number of array elements a conversion stops at whatever its options say, so
 * that a result is bounded in size whatever the input.
 */
const ABSOLUTE_MAX_ARRAY_LENGTH = 10000;

/** Number of array elements a conversion stops at, when its options do not say. */
const DEFAULT_MAX_ARRAY_LENGTH = 100;

/**
 * Number of properties of an object a conversion stops at whatever its
 * options say, so that a result is bounded in size whatever the input.
 */
const ABSOLUTE_MAX_PROPERTIES = 10000;

/**
 * Number of properties of an object a conversion stops at, when its options
 * do not say.
 */
const DEFAULT_MAX_PROPERTIES = 100;

/**
 * Length of a string a conversion carries whole whatever its options say, so
 * that a result is bounded in size whatever the input.
 */
const ABSOLUTE_MAX_STRING_LENGTH = 100000;

/** Length of a string a conversion carries whole, when its options do not say. */
const DEFAULT_MAX_STRING_LENGTH = 200;

/**
 * Number of lines of a string a conversion carries whole whatever its options
 * say, so that a result is bounded in size whatever the input.
 */
const ABSOLUTE_MAX_STRING_LINES = 1000;

/**
 * Number of lines of a string a conversion carries whole, when its options do
 * not say.
 */
const DEFAULT_MAX_STRING_LINES = 5;

/** Matches one line break, of any of the three forms a string can hold. */
const LINE_BREAK_REGEX = /\r\n|[\r\n]/g;

/**
 * Matches the empty position just past each line break, so that splitting a
 * string on it yields the string's lines with their line breaks kept.
 */
const AFTER_LINE_BREAK_REGEX = /(?<=\r\n|\r(?!\n)|\n)/;

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
 * The payload of the conversion's string-length form: the length of the
 * whole string, and the excerpt of it that was carried.
 */
type PartialString = { readonly length: number; readonly excerpt: string };

/**
 * The limits a conversion runs within, each resolved from the option of the
 * same name: the limit stated, or its default when none was, capped at its
 * absolute maximum.
 */
type ConversionLimits = {
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly maxProperties: number;
  readonly maxStringLength: number;
  readonly maxStringLines: number;
};

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
  readonly #limits: ConversionLimits;
  readonly #replacer: undefined | ((value: any) => any);
  readonly #nestingStack = new Map<object, number>();

  /**
   * Constructs an instance.
   */
  constructor(
    /** Value to convert. */
    value: unknown,
    /** Limits to convert within. */
    limits: ConversionLimits,
    /** Replacer function. */
    replacer?: (value: any) => any,
  ) {
    this.#value = value;
    this.#limits = limits;
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
   * An array with more elements than the maximum array length has the
   * elements at indices below that limit converted, and at the limit's index
   * a `/...` form carrying the array's length in place of the rest. That form
   * nests two levels, so a result holding one can run one level past the
   * maximum nesting depth.
   */
  #convertArray(value: any, depth: number): FabricValue {
    const length: number = value.length;
    const maxLength = this.#limits.maxArrayLength;
    const result: FabricValue[] = [];
    // An array is indexable by property name directly, so the index names
    // `Object.keys()` yields are used as they come.
    const byName = result as unknown as Record<string, FabricValue>;

    result.length = Math.min(length, maxLength);
    for (const key of Object.keys(value)) {
      if (!isArrayIndexPropertyName(key)) {
        // It's a named property. Intentionally skipped as part of conforming to
        // `FabricValue`.
        continue;
      }

      if (Number(key) >= maxLength) {
        // It's an element past the limit, which the length form stands for.
        continue;
      }

      try {
        byName[key] = this.#convertSubvalue(value[key], depth + 1);
      } catch (e) {
        byName[key] = DebugConverter.#makeUnconvertibleResult(e);
      }
    }

    if (length > maxLength) {
      result.push({ "/...": { length } });
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
        return { [tag]: this.#convertString(stringForm) };
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
   * Converts a plain object, which is known to be at the indicated nesting
   * depth. An object with more properties than the maximum property count
   * has the first that many converted, in key order, and after them a `/...`
   * property carrying the count of the whole. That form nests two levels, so
   * a result holding one can run one level past the maximum nesting depth.
   */
  #convertPlainObject(value: any, depth: number): FabricValue {
    const maxProperties = this.#limits.maxProperties;
    const keys: string[] = Object.keys(value);
    const result: Record<string, FabricValue> = {};

    for (const key of keys.slice(0, maxProperties)) {
      const resultKey = (isUnsafeObjectKey(key) || (key[0] === "/"))
        ? `/${key}`
        : key;
      try {
        result[resultKey] = this.#convertSubvalue(value[key], depth + 1);
      } catch (e) {
        result[resultKey] = DebugConverter.#makeUnconvertibleResult(e);
      }
    }

    if (keys.length > maxProperties) {
      result["/..."] = { count: keys.length };
    }

    return result;
  }

  /**
   * Converts a string. A string longer than the maximum string length, or
   * holding more lines than the maximum string lines, is converted to a
   * `/partialString` form carrying its length and an excerpt: its first
   * characters up to the length limit, or its first lines up to the line
   * limit, whichever is shorter. A character cut can land inside a surrogate
   * pair, so an excerpt so cut loses a final high surrogate; a line cut lands
   * just past a line break, which the excerpt keeps. That form nests two
   * levels, so a result holding one can run one level past the maximum
   * nesting depth.
   */
  #convertString(value: string): FabricValue {
    const { maxStringLength, maxStringLines } = this.#limits;
    const length = value.length;
    const lengthCut = Math.min(length, maxStringLength);
    const lineCut = DebugConverter.#lineCutOf(value, maxStringLines);
    const cut = Math.min(lengthCut, lineCut);

    if (cut === length) {
      return value;
    }

    let excerpt = value.slice(0, cut);
    if ((cut < lineCut) && /[\uD800-\uDBFF]$/.test(excerpt)) {
      excerpt = excerpt.slice(0, -1);
    }

    return { "/partialString": { length, excerpt } };
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
      case "undefined": {
        return value;
      }

      case "string": {
        return this.#convertString(value);
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

      if (depth >= this.#limits.maxDepth) {
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
   * Returns the index at which `value` ends were it cut to its first
   * `maxLines` lines: the index just past the line break which ends that many
   * lines, or the length of `value` when it holds no more lines than that. A
   * line break at the very end of `value` ends its last line rather than
   * starting an empty one, which is a consequence of the cut landing past it.
   */
  static #lineCutOf(value: string, maxLines: number): number {
    let lines = 1;

    for (const lineBreak of value.matchAll(LINE_BREAK_REGEX)) {
      if (lines === maxLines) {
        return lineBreak.index + lineBreak[0].length;
      }
      lines++;
    }

    return value.length;
  }

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
  readonly #limits: ConversionLimits;
  readonly #singleIndent: string | undefined;
  readonly #spacer: string;
  readonly #colon: string;

  /** `#renderRealmState()` as a function, for passing to a renderer of parts. */
  readonly #renderRealmStateFn = (v: PrimitiveState, i: string): string =>
    this.#renderRealmState(v, i);

  /**
   * Constructs an instance which renders using `indent` spaces per nesting
   * level when given, and on a single line when not. A value which turns up
   * unconverted while rendering is converted with `options`, and what the
   * rendering lays out itself, unconverted, is bounded by `limits`.
   */
  constructor(
    options: DebugValueOptions,
    limits: ConversionLimits,
    indent?: number,
  ) {
    this.#options = options;
    this.#limits = limits;
    this.#singleIndent = (indent === undefined)
      ? undefined
      : " ".repeat(indent);
    this.#spacer = this.#isCompact ? "" : " ";
    this.#colon = `:${this.#spacer}`;
  }

  //
  // Instance members
  //

  /** Renders the given value. */
  render(value: FabricValue): string {
    return this.#renderSubvalue(value, "");
  }

  /** Whether this instance renders on a single line, with no indentation. */
  get #isCompact(): boolean {
    return this.#singleIndent === undefined;
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
    // The length form the conversion leaves at the end of a truncated array is
    // an element like any other, so a run of holes ends at it.
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
    } else if (this.#isCompact) {
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

    const typeName = DebugStringifier.#typeNameOf(tag);
    const open = `${DebugStringifier.#renderTypeName(typeName)}(`;

    if (isPlainObject(state)) {
      const parts = this.#renderProperties(
        state as { readonly [key: string]: PrimitiveState },
        indent,
        this.#renderRealmStateFn,
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
    if (value instanceof ArrayBuffer) {
      return this.#renderBuffer(value);
    } else if (Array.isArray(value)) {
      const inner = this.#innerIndent(indent);
      const parts = value.map((element) =>
        this.#renderRealmState(element, inner)
      );
      return this.#renderContainer("[", "]", parts, indent);
    } else if (isPlainObject(value)) {
      const parts = this.#renderProperties(
        value as { readonly [key: string]: PrimitiveState },
        indent,
        this.#renderRealmStateFn,
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
   * `/Name(...)` when the conversion had nothing to show for it, the name
   * rendered as `#renderTypeName()` renders it. Any other payload -- a
   * `toString()` form, what `toJSON()` returned, or an encoding that is not a
   * plain object -- is rendered as it stands inside the parentheses.
   */
  #renderInstance(
    className: string,
    payload: FabricValue,
    indent: string,
  ): string {
    const open = `${DebugStringifier.#renderTypeName(className)}(`;

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
   * rendered by `render` (by default, as a converted value). When `converted`
   * is `true` (the default), the object came through the conversion: a key is
   * rendered as the original value's key, the slash the conversion prefixes
   * to a key that starts with one and to an unsafe key coming back off here,
   * and a final `/...` property is the property-count form, rendered as the
   * count it carries. Otherwise the object is laid out as it stands, and one
   * with more properties than the maximum property count has the first that
   * many rendered and then the count of the whole.
   */
  #renderProperties<T>(
    value: { readonly [key: string]: T },
    indent: string,
    render: (value: T, indent: string) => string = (v, i) =>
      this.#renderSubvalue(v as unknown as FabricValue, i),
    converted = true,
  ): string[] {
    const inner = this.#innerIndent(indent);
    const entries = Object.entries(value);
    let count: number | undefined;

    if (converted) {
      const last = entries.at(-1);
      const lastCount = (last?.[0] === "/...")
        ? DebugStringifier.#countOf(last[1] as FabricValue)
        : undefined;
      if (lastCount !== undefined) {
        count = lastCount;
        entries.pop();
      }
    }

    if (entries.length > this.#limits.maxProperties) {
      count = entries.length;
      entries.length = this.#limits.maxProperties;
    }

    const parts = entries.map(([key, subvalue]) => {
      const original = (converted && (key[0] === "/")) ? key.slice(1) : key;
      const rendered = render(subvalue, inner);
      return `${
        DebugStringifier.#renderKey(original)
      }${this.#colon}${rendered}`;
    });

    if (count !== undefined) {
      parts.push(this.#renderElision("count", count));
    }

    return parts;
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
        return this.#renderString(value, indent);
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
          return `(...)${this.#spacer}=>${this.#spacer}{...}`;
        } else if (name !== undefined) {
          return `function ${name}(...)${this.#spacer}{...}`;
        }
        return this.#renderInstance(tag, payload, indent);
      }

      case "unconvertible": {
        // A value the conversion could not read, whose payload is the
        // error's message.
        return this.#renderInstance(tag, payload, indent);
      }

      case "...": {
        // The elision marker: the array-length form when its payload is an
        // object holding a `length`, and otherwise the depth-limit form,
        // whose payload -- what kind of value was elided -- is left out of
        // the rendering.
        const length = DebugStringifier.#lengthOf(payload);
        return (length === undefined)
          ? "..."
          : this.#renderElision("length", length);
      }

      case "partialString": {
        // The excerpt of a string too long to carry whole, followed by the
        // length of the whole. A payload not of that shape falls through to
        // render as it is.
        const partial = DebugStringifier.#partialStringOf(payload);
        if (partial !== undefined) {
          return this.#renderPartialString(partial, indent);
        }
        // deno-coverage-ignore-start
        // The conversion is the form's only producer and shapes it no other
        // way, so this fallthrough is a prophylactic no test can reach.
        return this.#renderInstance(tag, payload, indent);
      }
      // deno-coverage-ignore-stop

      default: {
        // A class instance, carried under its class name.
        return this.#renderInstance(tag, payload, indent);
      }
    }
  }

  /** Returns the indentation for the contents of a container indented by `indent`. */
  #innerIndent(indent: string): string {
    return this.#isCompact ? indent : `${indent}${this.#singleIndent}`;
  }

  /**
   * Renders an `ArrayBuffer` as `buf [...]`, the space being the spacer, with
   * its bytes in hexadecimal and a space after every fourth byte in either
   * mode.
   */
  #renderBuffer(buffer: ArrayBuffer): string {
    const hex = [...new Uint8Array(buffer)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .replace(/.{8}(?=.)/g, "$& ");
    return `buf${this.#spacer}[${hex}]`;
  }

  /**
   * Renders the note which stands for what a limit cut: an ellipsis, then
   * the actual measure under `label`, which names what was measured.
   */
  #renderElision(label: string, measure: number): string {
    return `...${this.#spacer}${label}${this.#colon}${measure}`;
  }

  /**
   * Renders the string-length form: the excerpt as `#renderString()` renders
   * it, followed by the length of the whole. The length follows on the same
   * line, or when the rendering is multi-line, on a line of its own, indented
   * by the inner indentation of `indent`.
   */
  #renderPartialString(partial: PartialString, indent: string): string {
    const rendered = this.#renderString(partial.excerpt, indent);
    const separator = this.#isCompact
      ? this.#spacer
      : `\n${this.#innerIndent(indent)}`;
    const length = this.#renderElision("length", partial.length);

    return `${rendered}${this.#spacer}+${separator}${length}`;
  }

  /**
   * Renders a string. When the rendering is multi-line and the string holds a
   * line break, each of its lines renders quoted on a line of its own, every
   * line but the last followed by ` +` and every line but the first indented
   * by the inner indentation of `indent`. Otherwise the string renders whole,
   * quoted.
   */
  #renderString(value: string, indent: string): string {
    const lines = DebugStringifier.#linesOf(value);

    if (this.#isCompact || (lines.length === 1)) {
      return JSON.stringify(value);
    }

    const inner = this.#innerIndent(indent);
    return lines.map((line) => JSON.stringify(line)).join(` +\n${inner}`);
  }

  //
  // Static members
  //

  /**
   * Renders the elided form of a `FabricPrimitive` whose state cannot be had,
   * given its class name. The slash suggests a known encodable type rather
   * than an instance of some random class.
   */
  static #renderElidedInstance(name: string): string {
    return `${DebugStringifier.#renderTypeName(name)}(...)`;
  }

  /**
   * Returns the type name of a codec type tag: the tag less its encoding
   * version, which a rendering leaves out.
   */
  static #typeNameOf(tag: string): string {
    return tag.replace(/@.*$/, "");
  }

  /**
   * Renders a key -- an object property name, a symbol's key, or a type name
   * -- bare when it is a valid identifier, and as a quoted string otherwise.
   * The identifier check is the ASCII one.
   */
  static #renderKey(key: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
  }

  /**
   * Renders the type name a tagged form opens with: a slash, then the name as
   * `#renderKey()` renders it. The `<anonymous>` marker, which stands for a
   * class with no name, stays bare.
   */
  static #renderTypeName(name: string): string {
    const rendered = (name === "<anonymous>")
      ? name
      : DebugStringifier.#renderKey(name);
    return `/${rendered}`;
  }

  /**
   * Returns the `count` of the given value when it is a plain object whose
   * `count` is a number, which is the payload shape of the property-count
   * form, and `undefined` when it is not.
   */
  static #countOf(value: FabricValue): number | undefined {
    return DebugStringifier.#measureOf(value, "count");
  }

  /**
   * Returns the `length` of the given value when it is a plain object whose
   * `length` is a number, which is the payload shape of the array-length
   * form, and `undefined` when it is not.
   */
  static #lengthOf(value: FabricValue): number | undefined {
    return DebugStringifier.#measureOf(value, "length");
  }

  /**
   * Returns the property `name` of the given value when it is a plain object
   * whose property so named is a number, and `undefined` when it is not.
   */
  static #measureOf(value: FabricValue, name: string): number | undefined {
    if (!isPlainObject(value)) {
      return undefined;
    }

    const measure = (value as FabricPlainObject)[name];
    return (typeof measure === "number") ? measure : undefined;
  }

  /**
   * Returns the lines of the given string, each with its line break kept. A
   * string ending in a line break has no empty line after it, and the empty
   * string is one empty line.
   */
  static #linesOf(value: string): string[] {
    const lines = value.split(AFTER_LINE_BREAK_REGEX);

    if ((lines.length > 1) && (lines.at(-1) === "")) {
      lines.pop();
    }

    return lines;
  }

  /**
   * Returns the length and excerpt of the given value when it is the payload
   * shape of the string-length form, a plain object whose `length` is a
   * number and whose `excerpt` is a string, and `undefined` when it is not.
   */
  static #partialStringOf(value: FabricValue): PartialString | undefined {
    const length = DebugStringifier.#lengthOf(value);
    // deno-coverage-ignore-start
    // The conversion shapes the form no other way; see the `partialString`
    // arm of `#renderTaggedForm()`.
    if (length === undefined) {
      return undefined;
    }
    // deno-coverage-ignore-stop

    const { excerpt } = value as FabricPlainObject;
    return (typeof excerpt === "string") ? { length, excerpt } : undefined;
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
 * Helper for `checkedLimits()`, which validates `options` as a whole. What
 * each option holds is validated as it is read, by `checkedLimit()`.
 *
 * @throws {Error} if `options` is not a plain object.
 */
function checkOptions(options: DebugValueOptions | undefined): void {
  if ((options !== undefined) && !isPlainObject(options)) {
    const badOptions = toCompactDebugString(options, {
      maxLength: 20,
      backtickQuote: true,
    });
    throw new Error(
      `\`options\` must be a plain object or \`undefined\`; got ${badOptions}`,
    );
  }
}

/**
 * Helper for `checkedLimits()`, which validates one of the limit options and
 * returns the limit it calls for: `value` when present, and `defaultValue`
 * when not, either one capped at `cap`. `name` is the option's name, for the
 * error.
 *
 * @throws {Error} if `value` is none of a positive integer, `Infinity`, or
 * `undefined`.
 */
function checkedLimit(
  name: string,
  value: number | undefined,
  defaultValue: number,
  cap: number,
): number {
  switch (typeof value) {
    case "number": {
      if (
        (Number.isSafeInteger(value) && (value > 0)) || (value === Infinity)
      ) {
        return Math.min(value, cap);
      }
      break;
    }
    case "undefined": {
      return Math.min(defaultValue, cap);
    }
  }

  const badValue = toCompactDebugString(value, {
    maxLength: 20,
    backtickQuote: true,
  });
  throw new Error(
    `\`${name}\` must be a positive integer, \`Infinity\`, or \`undefined\`; got ${badValue}`,
  );
}

/**
 * Helper for the entry points, which validates `options` and returns the
 * limits they call for: each limit stated, or when not, `defaultMaxDepth` for
 * the depth and the default for each of the others, all capped at their
 * absolute maximums. The string length defaults to `Infinity` rather than
 * to its usual default when the options state a line count.
 *
 * @throws {Error} if `options` is not a plain object, or if one of its limits
 * is none of a positive integer, `Infinity`, or `undefined`.
 */
function checkedLimits(
  options: DebugValueOptions | undefined,
  defaultMaxDepth: number,
): ConversionLimits {
  checkOptions(options);

  // A caller who states a line count and no length gets a line bound alone,
  // not the default length on top of it.
  const defaultMaxStringLength = (options?.maxStringLines === undefined)
    ? DEFAULT_MAX_STRING_LENGTH
    : Infinity;

  return {
    maxDepth: checkedLimit(
      "maxDepth",
      options?.maxDepth,
      defaultMaxDepth,
      ABSOLUTE_MAX_DEPTH,
    ),
    maxArrayLength: checkedLimit(
      "maxArrayLength",
      options?.maxArrayLength,
      DEFAULT_MAX_ARRAY_LENGTH,
      ABSOLUTE_MAX_ARRAY_LENGTH,
    ),
    maxProperties: checkedLimit(
      "maxProperties",
      options?.maxProperties,
      DEFAULT_MAX_PROPERTIES,
      ABSOLUTE_MAX_PROPERTIES,
    ),
    maxStringLength: checkedLimit(
      "maxStringLength",
      options?.maxStringLength,
      defaultMaxStringLength,
      ABSOLUTE_MAX_STRING_LENGTH,
    ),
    maxStringLines: checkedLimit(
      "maxStringLines",
      options?.maxStringLines,
      DEFAULT_MAX_STRING_LINES,
      ABSOLUTE_MAX_STRING_LINES,
    ),
  };
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
  // The limits are resolved here, ahead of the `try`, so that an invalid one
  // is refused rather than rendered as unrenderable.
  const limits = checkedLimits(options, DEFAULT_STRING_MAX_DEPTH);
  const converterOptions: DebugValueOptions = { ...options, ...limits };

  try {
    const converted = toStructuredDebugValue(value, converterOptions);
    return new DebugStringifier(converterOptions, limits, indent)
      .render(converted);
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
 * includes an "ASCII ellipsis" of `...`. When `options` asks for it, the result
 * is then quoted as a Markdown code span, ready to splice into message text.
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
 * when not given, below which a value is elided. It likewise stops at the
 * array length given in `options`, one hundred elements when not given, and
 * says the array's actual length in place of the elements past it; likewise
 * at the property count given in `options`, one hundred when not given, and
 * says the object's actual count in place of the properties past it; and a
 * string longer than the string length given in `options`, two hundred
 * characters when not given, renders as an excerpt of that length followed by
 * the string's actual length.
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
  let result = renderDebugString(value, options);
  const maxLength = options?.maxLength;

  if (typeof maxLength === "number") {
    const actualMax = Math.max(Math.floor(maxLength), 3);
    if (result.length > actualMax) {
      result = result.slice(0, actualMax - 3) + "...";
    }
  }

  return (options?.backtickQuote === true) ? backtickQuote(result) : result;
}

/**
 * Like `toCompactDebugString()`, except that the result is indented by two
 * spaces per nesting level, and is never truncated for length, there being no
 * length to give. The depth limit and replacer apply to both. A string holding
 * a line break renders one line of the string per line of the result, each
 * quoted, every line but the last followed by ` +`, and every line but the
 * first indented one level further than the value; and the length of a string
 * carried in part follows its excerpt on a line of its own, indented the same
 * way.
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
 * The limits of the result -- its nesting, the number of elements of an array
 * it represents, the number of properties of an object it represents, and the
 * length and number of lines of a string it carries whole -- and a replacer
 * to consult are the `maxDepth`, `maxArrayLength`, `maxProperties`,
 * `maxStringLength`, `maxStringLines`, and `replacer` of `options`. When
 * there is no nesting limit given, the result nests as deep as reasonably
 * possible; when there is no array length given, an array is represented to
 * one hundred elements; when there is no property count given, an object is
 * represented to one hundred properties; when there is no string line count
 * given, a string is
 * carried whole to five lines; and when there is no string length given, a
 * string is carried whole to two hundred characters, or as long as the
 * conversion allows when a line count is given.
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
  const limits = checkedLimits(options, ABSOLUTE_MAX_DEPTH);

  // We subtract one from `maxDepth` because the "suggestive forms" for elided
  // data use a layer of depth. The array-length and string-length forms use
  // two, and so can run one level past the limit.
  return new DebugConverter(
    value,
    { ...limits, maxDepth: limits.maxDepth - 1 },
    options?.replacer,
  ).convert();
}
