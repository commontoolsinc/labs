import { isPlainObject } from "@commonfabric/utils/types";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

import { FabricSpecialObject, type FabricValue } from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import {
  type ReconstructionContext,
  type SerializationContext,
} from "@/codec-common/interface.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { EmptyReconstructionContext } from "@/codec-common/EmptyReconstructionContext.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { createDefaultRegistry } from "./createDefaultRegistry.ts";
import type { JsonWireValue } from "./interface.ts";
import { type CodecRegistry, SELF_REP } from "./CodecRegistry.ts";
import { CODEC_META_TAGS } from "@/codec-common/codec-meta-tags.ts";

/**
 * Tag prefix for the encoded form used by this module. We use this explicit
 * prefix so as to make it unambiguous when a given JSON-ish text string is
 * the result of encoding via this module vs. being JSON from some other source.
 * The tag stands for "Fabric Value Json, version 1."
 */
const ENCODING_PREFIX_TAG = "fvj1:";

/** Shared text encoder, created once. */
const textEncoder = new TextEncoder();

/** Shared text decoder, created once. */
const textDecoder = new TextDecoder();

/** Shared default handler registry, created once. */
const defaultRegistry: CodecRegistry = createDefaultRegistry();

/** Returns true if `v` is a single-key object whose key starts with `/` —
 * the wire form of an encoded instance (tag-wrapped value). */
function isEncodedInstance(v: JsonWireValue): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0]!.startsWith("/");
}

/**
 * Returns true if the already-serialized wire value `v` can be embedded
 * inside a /quote wrap without inner deserialization: primitives, plain
 * objects/arrays free of non-/quote encoded instances, and /quote-wrapped
 * values (which `unquote()` can collapse).
 */
function isQuoteSafe(v: JsonWireValue): boolean {
  if (v === null || typeof v !== "object") return true;
  if (Array.isArray(v)) return v.every((item) => isQuoteSafe(item));
  if (!isEncodedInstance(v)) {
    return Object.values(v).every((item) => isQuoteSafe(item as JsonWireValue));
  }
  return Object.keys(v)[0] === "/quote";
}

/**
 * Unwraps /quote forms one level so their literal content can be embedded
 * directly inside a parent /quote. The inner content of a /quote is already
 * literal and must not be recursed into.
 */
function unquote(v: JsonWireValue): JsonWireValue {
  if (v === null || typeof v !== "object") {
    return v;
  } else if (Array.isArray(v)) {
    const result = v.map(unquote) as JsonWireValue;
    return Object.freeze(result);
  } else if (isEncodedInstance(v) && Object.keys(v)[0] === "/quote") {
    return (v as Record<string, JsonWireValue>)["/quote"]!;
  } else {
    const result = Object.fromEntries(
      Object.entries(v).map(([k, val]) => [k, unquote(val as JsonWireValue)]),
    ) as JsonWireValue;
    return Object.freeze(result);
  }
}

/**
 * JSON encoding context implementing the `/<Type>@<Version>` wire format
 * from the formal spec (Section 5).
 *
 * Public interface: `SerializationContext<string>`
 * - `encode(value)` -- full pipeline: tree-encode + stringify
 * - `decode(data, context)` -- full pipeline: parse + tree-decode
 *
 * All internal machinery (tag wrapping, tree walking, byte conversion) is
 * private. Per-type encoding/decoding is delegated to the `FabricCodec`s in
 * the `CodecRegistry`.
 */
export class JsonEncodingContext implements SerializationContext<string> {
  /** Whether failed reconstructions produce `ProblematicValue` instead of
   *  throwing. */
  readonly lenient: boolean;

  /**
   * Constructs an instance, optionally configured for lenient mode (which
   * produces `ProblematicValue` on failed reconstruction instead of throwing).
   */
  constructor(options?: { lenient?: boolean }) {
    this.lenient = options?.lenient ?? false;
  }

  //
  // Instance members
  //

  /**
   * Encodes a fabric value to a JSON string. Serializes fabric types into
   * the `/<Type>@<Version>` tagged wire format, then stringifies.
   */
  encode(value: FabricValue): string {
    return ENCODING_PREFIX_TAG + JSON.stringify(this.#encodeValue(value));
  }

  /**
   * Decodes a JSON string back into a fabric value. Parses the string,
   * then deserializes tagged forms back into runtime types.
   */
  decode(data: string, context: ReconstructionContext): FabricValue {
    if (!JsonEncodingContext.seemsLikeEncoded(data)) {
      const excerpt = (data.length <= 50) ? data : `${data.slice(0, 50)}...`;
      throw new Error(
        `Not a JSON-encoded \`FabricValue\` string: \`${excerpt}\``,
      );
    }

    const json = data.slice(ENCODING_PREFIX_TAG.length);
    const parsed = JsonEncodingContext.#parseWireText(json);
    return this.#decodeValue(parsed, context);
  }

  /**
   * Serializes a fabric value to UTF-8 JSON bytes. (Public for now -- used by
   * byte-level round-trip tests.)
   */
  encodeToBytes(value: FabricValue): Uint8Array {
    return this.toBytes(this.#encodeValue(value));
  }

  /**
   * Deserializes UTF-8 JSON bytes back into a fabric value.
   */
  decodeFromBytes(
    bytes: Uint8Array,
    context: ReconstructionContext,
  ): FabricValue {
    const tree = this.fromBytes(bytes);
    return this.#decodeValue(tree, context);
  }

  /**
   * Wraps a tag and state into the `/<tag>` wire format. Prepends `/` to the
   * tag to produce the JSON key. See Section 5.2 of the formal spec.
   */
  private wrapTag(tag: string, state: JsonWireValue): JsonWireValue {
    return Object.freeze({ [`/${tag}`]: state } as JsonWireValue);
  }

  /**
   * Unwraps a wire representation. Detects single-key objects with `/`-prefixed
   * keys. Returns `{ tag, state }` or `null` if not a tagged value. The
   * returned `state` is extracted directly from `data`, so if `data` is
   * deep-frozen (as it should be) then `state` will be too.
   *
   * See Section 5.4 of the formal spec.
   */
  private unwrapTag(
    data: JsonWireValue,
  ): { tag: string; state: JsonWireValue } | null {
    if (!isPlainObject(data)) {
      return null;
    }

    if (!isEncodedInstance(data)) {
      return null;
    }

    // `isEncodedInstance()` guaranteed a single-property object, so this
    // destructures that one entry. (`isPlainObject()` is not a type guard, so
    // narrow explicitly for the type-checker.)
    const [key, value] = Object.entries(
      data as Record<string, JsonWireValue>,
    )[0]!;
    return { tag: key.slice(1), state: value };
  }

  /** Converts a wire-format tree to UTF-8-encoded JSON bytes. */
  private toBytes(data: JsonWireValue): Uint8Array {
    return textEncoder.encode(JSON.stringify(data));
  }

  /** Parses UTF-8-encoded JSON bytes back into a wire-format tree. */
  private fromBytes(bytes: Uint8Array): JsonWireValue {
    const json = textDecoder.decode(bytes);
    return JsonEncodingContext.#parseWireText(json);
  }

  /**
   * Encodes a fabric value into the wire-format tree. Recursively processes
   * nested values. See Section 4.5 of the formal spec.
   */
  #encodeValue(
    value: FabricValue,
    _seen?: Set<object>,
    registry: CodecRegistry = defaultRegistry,
  ): JsonWireValue {
    const codec = registry.codecFromValue(value);

    if (codec === SELF_REP) {
      // A self-representing primitive is its own wire form.
      return value as JsonWireValue;
    } else if (codec) {
      const seen = _seen ?? new Set<object>();
      let addedToSeen = false;

      if (value !== null && typeof value === "object") {
        if (seen.has(value as object)) {
          throw new Error("Circular reference detected during serialization");
        }
        seen.add(value as object);
        addedToSeen = true;
      }

      // We use `tagForValue()` here rather than relying on any direct property
      // of `value`, because `value` might not actually know what codec is being
      // used for it, and it is up to the _codec_ not the value per se to
      // determine the correct tag.
      const tag = codec.tagForValue(value);

      const unprocessedState = codec.encode(value);
      const finalState = this.#encodeValue(unprocessedState, seen, registry);
      const result: JsonWireValue = { [`/${tag}`]: finalState };

      if (addedToSeen) {
        seen.delete(value as object);
      }

      return result;
    } else if (value instanceof FabricSpecialObject) {
      // Every `FabricSpecialObject` (that is, all objects that are
      // `FabricValue`s other than plain objects and plain arrays must be
      // recognized by a registered codec. Complain here since we didn't find a
      // `codec` above.
      throw new Error(
        `No codec registered for fabric object class: ${value.constructor.name}`,
      );
    }

    // Self-representing primitives returned `SELF_REP` above. Past this point,
    // `value` is an `object`.

    // Arrays
    if (Array.isArray(value)) {
      const seen = _seen ?? new Set<object>();
      if (seen.has(value)) {
        throw new Error("Circular reference detected during serialization");
      }
      seen.add(value);

      const result: JsonWireValue[] = [];
      let i = 0;
      while (i < value.length) {
        if (!(i in value)) {
          let count = 0;
          while (i < value.length && !(i in value)) {
            count++;
            i++;
          }
          result.push(this.wrapTag(CODEC_META_TAGS.hole, count));
        } else {
          result.push(
            this.#encodeValue(value[i] as FabricValue, seen, registry),
          );
          i++;
        }
      }

      seen.delete(value);
      return result as JsonWireValue;
    }

    // The only legit object we can have at this point is a plain object. (The
    // other `FabricValue` object cases were handled above. So, if we find
    // ourselves looking at a non-plain object at this point, it's always an
    // error (and probably a case that can be tracked down to a typesystem lie
    // of some sort).
    if (!isPlainObject(value)) {
      throw new Error(
        `Cannot encode ${
          toCompactDebugString(value, 50)
        }: no applicable codec.`,
      );
    }

    // Plain objects
    const seen = _seen ?? new Set<object>();
    if (seen.has(value as object)) {
      throw new Error("Circular reference detected during serialization");
    }
    seen.add(value as object);

    // Iterate keys in UTF-8 byte order. This matches the canonical key order
    // used by `value-hash.ts`, and makes JSON encoding deterministic across
    // implementations and across objects whose keys differ only in insertion
    // order. See `3-json-encoding.md` Section 10 for the spec.
    const result: Record<string, JsonWireValue> = {};
    const valueRec = value as Record<string, FabricValue>;
    for (const key of utf8SortedKeysOf(valueRec)) {
      result[key] = this.#encodeValue(valueRec[key], seen, registry);
    }
    seen.delete(value as object);

    // Apply escaping per Section 5.6 for plain objects with /-prefixed keys.
    // Serialize all values first (post-pass), then check if all are quote-safe.
    // If so, unwrap any /quote children and wrap the whole object with /quote.
    // Otherwise wrap with /object so the decoder deserializes entries.
    const keys = Object.keys(result);
    if (keys.some((k) => k.startsWith("/"))) {
      if (Object.values(result).every((v) => isQuoteSafe(v))) {
        const unquoted = Object.freeze(
          Object.fromEntries(
            Object.entries(result).map(([k, v]) => [k, unquote(v)]),
          ),
        );
        return this.wrapTag(CODEC_META_TAGS.quote, unquoted) as JsonWireValue;
      }
      return this.wrapTag(CODEC_META_TAGS.object, result) as JsonWireValue;
    }

    return result as JsonWireValue;
  }

  /**
   * Decodes a wire-format tree back into fabric values. See Section 4.5 of
   * the formal spec.
   *
   * Frozen-ness contract: values returned via the codec dispatch arm are
   * guaranteed deep-frozen at this boundary, so callers do not each have to
   * freeze. The unknown-tag fallback (`UnknownValue`) is a separate arm and is
   * intentionally NOT covered by this contract.
   */
  #decodeValue(
    data: JsonWireValue,
    context: ReconstructionContext,
    registry: CodecRegistry = defaultRegistry,
  ): FabricValue {
    const decoded = this.unwrapTag(data);
    if (decoded !== null) {
      const { tag, state: rawState } = decoded;

      // `CODEC_META_TAGS.quote` literal handling (Section 5.6).
      if (tag === CODEC_META_TAGS.quote) {
        return rawState as FabricValue;
      }

      // `CODEC_META_TAGS.object` unwrapping (Section 5.6).
      if (tag === CODEC_META_TAGS.object) {
        const inner = rawState as Record<string, JsonWireValue>;
        const result: Record<string, FabricValue> = {};
        for (const [key, val] of Object.entries(inner)) {
          result[key] = this.#decodeValue(val, context, registry);
        }
        return Object.freeze(result);
      }

      // Except for `/quote` and `/object`, the `state` needs to be fully decoded.
      const state = this.#decodeValue(rawState, context, registry);

      // A bare `"/"` key (empty tag after stripping the leading slash) is
      // always an encoding error per spec §9 — no valid tag has an empty
      // name. Produce a `ProblematicValue` rather than an `UnknownValue` with
      // an empty tag.
      if (tag === "") {
        return new ProblematicValue(
          tag,
          state as unknown as FabricValue,
          `object has bare "/" key`,
        ) as unknown as FabricValue;
      }

      // Registry-based (tag lookup) dispatch
      //
      // `FabricCodec.decode()` makes a contractual guarantee that its
      // results are deep-frozen, rather than relying on every caller to
      // freeze: every return out of this arm passes through `deepFreeze()`.
      // This covers the handler's produced value (e.g. `FabricPrimitive`
      // subclasses -- already frozen, so this is an O(1) cache hit) and the
      // lenient-mode `ProblematicValue` fallback. The class-registry
      // fallback below is a separate arm and is intentionally NOT covered by
      // this contract.
      const codec = registry.codecFromTag(tag);
      if (codec) {
        if (this.lenient) {
          try {
            return deepFreeze(codec.decode(tag, state, context));
          } catch (e: unknown) {
            return deepFreeze(
              new ProblematicValue(
                tag,
                state as unknown as FabricValue,
                e instanceof Error ? e.message : String(e),
              ) as unknown as FabricValue,
            );
          }
        }
        return deepFreeze(codec.decode(tag, state, context));
      }

      // No registered codec for this tag: preserve the unknown form for
      // round-tripping.
      return new UnknownValue(tag, state);
    }

    // Primitives pass through.
    if (
      data === null || typeof data === "boolean" ||
      typeof data === "number" || typeof data === "string"
    ) {
      return data;
    }

    // Arrays: recursively deserialize elements.
    if (Array.isArray(data)) {
      let logicalLength = 0;
      for (const entry of data) {
        const entryDecoded = this.unwrapTag(entry);
        if (
          entryDecoded !== null && entryDecoded.tag === CODEC_META_TAGS.hole
        ) {
          logicalLength += entryDecoded.state as number;
        } else {
          logicalLength++;
        }
      }

      const result = new Array(logicalLength);
      let targetIndex = 0;
      for (const entry of data) {
        const entryDecoded = this.unwrapTag(entry);
        if (
          entryDecoded !== null && entryDecoded.tag === CODEC_META_TAGS.hole
        ) {
          targetIndex += entryDecoded.state as number;
        } else {
          result[targetIndex] = this.#decodeValue(entry, context, registry);
          targetIndex++;
        }
      }
      return Object.freeze(result);
    }

    // Plain objects: recursively deserialize values and freeze. Any
    // `/`-prefixed key is reserved per spec — return `ProblematicValue` on
    // first occurrence rather than silently round-tripping the object.
    const result: Record<string, FabricValue> = {};
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith("/")) {
        return new ProblematicValue(
          key.slice(1),
          data as unknown as FabricValue,
          `object contains reserved /-prefixed key: "${key}"`,
        ) as unknown as FabricValue;
      }
      result[key] = this.#decodeValue(val, context, registry);
    }
    return Object.freeze(result);
  }

  //
  // Static members
  //

  /**
   * Reconstruction context for the throwaway checks in the testing helpers
   * below. Deep-freezes, as the ordinary decode path does. Paired with a
   * lenient codec context, a cell reference degrades to a `ProblematicValue`
   * rather than throwing.
   */
  static readonly #testingReconstructionContext = Object.freeze(
    new EmptyReconstructionContext(
      true,
      "no runtime context (validity check in a test-only helper).",
    ),
  );

  /**
   * Indicates if the given text has a "first-blush" appearance as valid JSON
   * encoded by this class -- that is, whether it carries the encoding prefix
   * tag.
   */
  static seemsLikeEncoded(value: string): boolean {
    return value.startsWith(ENCODING_PREFIX_TAG);
  }

  /**
   * **Intended for tests only.** Strips the encoding prefix tag off an encoded
   * value, yielding the bare JSON text underneath.
   *
   * Tests legitimately need the JSON body on its own -- to pretty-print it, to
   * store it in a fixture file, to compare it against a literal. Doing that by
   * hand means writing the prefix a second time, which is how one definition of
   * a format quietly becomes several that can drift apart.
   *
   * This is deliberately not useful outside a test. Its result is precisely a
   * string that is _no longer_ an encoded fabric value: it has shed the very
   * marker whose purpose is to say "this JSON came from here." Production code
   * that wants to recognize an encoded value should call `seemsLikeEncoded()`;
   * production code that wants the value itself should call `decode()`.
   *
   * That is enforced rather than merely advised: this performs a throwaway
   * decode of `encoded` and throws if it is not genuinely decodable. So it
   * cannot serve as a cheap "chop off the first few characters," and it is far
   * too expensive to belong on any hot path.
   *
   * Pass `isMalformed` when the payload is _deliberately_ bad -- a test feeding
   * a broken tag state through the decoder to see it degrade, say. The check
   * then runs leniently, so such a payload survives it, and the call site says
   * out loud that the badness is the point. Note that this also covers a
   * payload holding a cell reference, which cannot be reconstructed here for
   * want of a runtime.
   */
  static unwrapEncodedValueForTesting(
    encoded: string,
    isMalformed = false,
  ): string {
    // Throwaway decode. The result is discarded; it is performed only to
    // establish that `encoded` really is one of ours, rather than a string that
    // happens to begin with the right few characters.
    JsonEncodingContext.#testingCheckContext(isMalformed).decode(
      encoded,
      JsonEncodingContext.#testingReconstructionContext,
    );

    return encoded.slice(ENCODING_PREFIX_TAG.length);
  }

  /**
   * **Intended for tests only.** Attaches the encoding prefix tag to bare JSON
   * text, producing an encoded value. The inverse of
   * `unwrapEncodedValueForTesting()`, and it exists for the same reason: so a
   * test that took an encoded value apart can put it back together without
   * naming the prefix itself.
   *
   * The same caveats apply, and for the same reason. Nothing in production
   * should be assembling an encoded value out of text -- code that has a value
   * to encode should call `encode()`, which is the only thing that can promise
   * the result is well-formed.
   *
   * Here that promise is checked directly: the tagged result is decoded and
   * then re-encoded, and both steps must succeed. Text earns the prefix only if
   * the codec can actually read what follows it and write it back out. Note
   * that the re-encoded form is not compared against the input, so incidental
   * differences -- whitespace, in particular -- are fine; a pretty-printed body
   * is accepted.
   *
   * `isMalformed` means the same thing as it does on
   * `unwrapEncodedValueForTesting()`: the payload is meant to be bad, so check
   * it leniently and let the call site say so.
   */
  static wrapEncodedValueForTesting(
    json: string,
    isMalformed = false,
  ): string {
    const encoded = ENCODING_PREFIX_TAG + json;

    // Throwaway decode and re-encode; both results are discarded. See above.
    const context = JsonEncodingContext.#testingCheckContext(isMalformed);
    context.encode(
      context.decode(
        encoded,
        JsonEncodingContext.#testingReconstructionContext,
      ),
    );

    return encoded;
  }

  /**
   * Codec context for the throwaway checks above. Strict by default, so that
   * anything the codec cannot cleanly read is refused; lenient when the caller
   * has declared the payload bad on purpose, which downgrades a failed
   * reconstruction to a `ProblematicValue` instead of an error.
   */
  static #testingCheckContext(isMalformed: boolean): JsonEncodingContext {
    return new JsonEncodingContext({ lenient: isMalformed });
  }

  /**
   * Parses the JSON-text wire form, _without_ a tag prefix.
   */
  static #parseWireText(jsonText: string): JsonWireValue {
    return deepFreeze(JSON.parse(jsonText) as JsonWireValue);
  }
}
