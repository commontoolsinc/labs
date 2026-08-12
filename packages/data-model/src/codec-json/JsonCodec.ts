import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

import { FabricSpecialObject, type FabricValue } from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import {
  CODEC,
  type NonterminalCodec,
  type ReconstructionContext,
  type SerializationContext,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { EmptyReconstructionContext } from "@/codec-interface/EmptyReconstructionContext.ts";
import { UnknownValue } from "@/codec-common/UnknownValue.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { ENCODING_PREFIX_TAG, type JsonCodecValue } from "./interface.ts";
import { createBaseJsonRegistry } from "./createBaseJsonRegistry.ts";
import { type CodecRegistry, SELF_REP } from "@/codec-common/CodecRegistry.ts";
import { CODEC_META_TAGS } from "@/codec-interface/codec-meta-tags.ts";

/**
 * Whole-value JSON codec implementing the `/<Type>@<Version>` wire format from
 * the formal spec (Section 5).
 *
 * Public interface: `SerializationContext<string>`
 * - `encode(value)` -- full pipeline: tree-encode + stringify
 * - `decode(data, context)` -- full pipeline: parse + tree-decode
 *
 * All internal machinery (tag wrapping, tree walking, byte conversion) is
 * private. Per-type encoding/decoding is delegated to the `FabricCodec`s in
 * the `CodecRegistry`.
 */
export class JsonCodec implements SerializationContext<string> {
  /**
   * Whether a failed reconstruction produces a `ProblematicValue` instead of
   * throwing.
   */
  readonly lenient: boolean;

  /** Registry consulted for per-type encoding and decoding. */
  readonly #registry: CodecRegistry<JsonCodecValue>;

  /**
   * Constructs an instance. `options.registry` supplies the codecs this
   * instance encodes and decodes with, and so decides which classes it can
   * carry; there is no default, because which classes participate is a
   * question this class has no standing to answer. `options.lenient` makes a
   * failed reconstruction produce a `ProblematicValue` instead of throwing.
   */
  constructor(
    options: { registry: CodecRegistry<JsonCodecValue>; lenient?: boolean },
  ) {
    this.lenient = options.lenient ?? false;
    this.#registry = options.registry;
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
    if (!JsonCodec.seemsLikeEncoded(data)) {
      const excerpt = (data.length <= 50) ? data : `${data.slice(0, 50)}...`;
      throw new Error(
        `Not a JSON-encoded \`FabricValue\` string: ${backtickQuote(excerpt)}`,
      );
    }

    const json = data.slice(ENCODING_PREFIX_TAG.length);
    const parsed = JsonCodec.#parseWireText(json);
    return this.#decodeValue(parsed, context);
  }

  /** Serializes a fabric value to UTF-8 JSON bytes. */
  encodeToBytes(value: FabricValue): Uint8Array {
    return this.#toBytes(this.#encodeValue(value));
  }

  /** Deserializes UTF-8 JSON bytes back into a fabric value. */
  decodeFromBytes(
    bytes: Uint8Array,
    context: ReconstructionContext,
  ): FabricValue {
    const tree = this.#fromBytes(bytes);
    return this.#decodeValue(tree, context);
  }

  /**
   * Wraps a tag and state into the `/<tag>` wire format. Prepends `/` to the
   * tag to produce the JSON key. See Section 5.2 of the formal spec.
   */
  #wrapTag(tag: string, state: JsonCodecValue): JsonCodecValue {
    return Object.freeze({ [`/${tag}`]: state } as JsonCodecValue);
  }

  /**
   * Unwraps a wire representation. Detects single-key objects with `/`-prefixed
   * keys. Returns `{ tag, state }` or `null` if not a tagged value. The
   * returned `state` is extracted directly from `data`, so if `data` is
   * deep-frozen (as it should be) then `state` will be too.
   *
   * See Section 5.4 of the formal spec.
   */
  #unwrapTag(
    data: JsonCodecValue,
  ): { tag: string; state: JsonCodecValue } | null {
    if (!isPlainObject(data)) {
      return null;
    }

    if (!JsonCodec.#isEncodedInstance(data)) {
      return null;
    }

    // `#isEncodedInstance()` guaranteed a single-property object, so this
    // destructures that one entry.
    const [key, value] = Object.entries(data)[0]!;
    return { tag: key.slice(1), state: value };
  }

  /** Converts a codec-value tree to UTF-8-encoded JSON bytes. */
  #toBytes(data: JsonCodecValue): Uint8Array {
    return JsonCodec.#textEncoder.encode(JSON.stringify(data));
  }

  /** Parses UTF-8-encoded JSON bytes back into a codec-value tree. */
  #fromBytes(bytes: Uint8Array): JsonCodecValue {
    const json = JsonCodec.#textDecoder.decode(bytes);
    return JsonCodec.#parseWireText(json);
  }

  /**
   * Encodes a fabric value into the codec-value tree. Recursively processes
   * nested values. See Section 4.5 of the formal spec.
   */
  #encodeValue(
    value: FabricValue,
    _seen?: Set<object>,
  ): JsonCodecValue {
    const matched = this.#registry.codecFromValue(value);

    if (matched === SELF_REP) {
      // A self-representing primitive is its own wire form.
      return value as JsonCodecValue;
    } else if (matched) {
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
      //
      // A terminal codec's state is already in this format's domain, so it is
      // final; a nonterminal codec's is made of fabric values, which this
      // walker has yet to expand.
      const tag = matched.tagForValue(value);
      const finalState = (matched instanceof BaseTerminalCodec)
        ? matched.encode(value) as JsonCodecValue
        : this.#encodeValue(matched.encode(value) as FabricValue, seen);
      const result: JsonCodecValue = { [`/${tag}`]: finalState };

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
        `No codec registered for fabric object class: ${
          backtickQuote(value.constructor.name)
        }`,
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

      const result: JsonCodecValue[] = [];
      let i = 0;
      while (i < value.length) {
        if (!(i in value)) {
          let count = 0;
          while (i < value.length && !(i in value)) {
            count++;
            i++;
          }
          result.push(this.#wrapTag(CODEC_META_TAGS.hole, count));
        } else {
          result.push(
            this.#encodeValue(value[i], seen),
          );
          i++;
        }
      }

      seen.delete(value);
      return result as JsonCodecValue;
    }

    // The only legit object we can have at this point is a plain object. (The
    // other `FabricValue` object cases were handled above. So, if we find
    // ourselves looking at a non-plain object at this point, it's always an
    // error (and probably a case that can be tracked down to a typesystem lie
    // of some sort).
    if (!isPlainObject(value)) {
      throw new Error(
        `Cannot encode ${
          backtickQuote(toCompactDebugString(value, 50))
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
    const result: Record<string, JsonCodecValue> = {};
    const valueRec = value as Record<string, FabricValue>;
    let anySlashKey = false;
    for (const key of utf8SortedKeysOf(valueRec)) {
      if (key.startsWith("/")) {
        anySlashKey = true;
      }
      result[key] = this.#encodeValue(valueRec[key], seen);
    }
    seen.delete(value as object);

    // Apply escaping per Section 5.6 for plain objects with /-prefixed keys.
    // Serialize all values first (post-pass), then check if all are quote-safe.
    // If so, unwrap any /quote children and wrap the whole object with /quote.
    // Otherwise wrap with /object so the decoder deserializes entries.
    if (anySlashKey) {
      if (Object.values(result).every((v) => JsonCodec.#isQuoteSafe(v))) {
        const unquoted = Object.freeze(
          Object.fromEntries(
            Object.entries(result).map(([k, v]) => [k, JsonCodec.#unquote(v)]),
          ),
        );
        return this.#wrapTag(CODEC_META_TAGS.quote, unquoted) as JsonCodecValue;
      }
      return this.#wrapTag(CODEC_META_TAGS.object, result) as JsonCodecValue;
    }

    return result as JsonCodecValue;
  }

  /**
   * Decodes a codec-value tree back into fabric values. See Section 4.5 of
   * the formal spec.
   *
   * Frozen-ness contract: values returned via the codec dispatch arm are
   * guaranteed deep-frozen at this boundary, so callers do not each have to
   * freeze. The unknown-tag fallback (`UnknownValue`) is a separate arm and is
   * intentionally NOT covered by this contract.
   */
  #decodeValue(
    data: JsonCodecValue,
    context: ReconstructionContext,
  ): FabricValue {
    const decoded = this.#unwrapTag(data);
    if (decoded !== null) {
      const { tag, state: rawState } = decoded;

      // `CODEC_META_TAGS.quote` literal handling (Section 5.6).
      if (tag === CODEC_META_TAGS.quote) {
        return rawState;
      }

      // `CODEC_META_TAGS.object` unwrapping (Section 5.6).
      if (tag === CODEC_META_TAGS.object) {
        const inner = rawState as Record<string, JsonCodecValue>;
        const result: Record<string, FabricValue> = {};
        for (const [key, val] of Object.entries(inner)) {
          // Same reservation as the plain-object arm below: the assignment
          // cannot rebuild these names.
          if (isUnsafeObjectKey(key)) {
            return new ProblematicValue(
              key,
              inner,
              `object contains a key this runtime reserves: "${key}"`,
            );
          }
          result[key] = this.#decodeValue(val, context);
        }
        return Object.freeze(result);
      }

      // Registry-based (tag lookup) dispatch. The lookup comes first because
      // it decides what form the state is wanted in: a terminal codec takes
      // the state exactly as it arrived, and everything else takes state this
      // walker has decoded. (`/quote` and `/object` returned above; no codec
      // ever sees their state, and `/quote` contents alone go undecoded.)
      const matched = this.#registry.codecFromTag(tag);

      if (matched === undefined) {
        const state = this.#decodeValue(rawState, context);

        // A bare `"/"` key (empty tag after stripping the leading slash) is
        // always an encoding error per spec §9 — no valid tag has an empty
        // name. Produce a `ProblematicValue` rather than an `UnknownValue`
        // with an empty tag.
        //
        // Otherwise the tag is simply one this registry does not carry, and
        // the unknown form is preserved so that it round-trips. Neither of
        // these is covered by the deep-frozen contract that the codec arm
        // below states.
        return (tag === "")
          ? new ProblematicValue(tag, state, `object has bare "/" key`)
          : new UnknownValue(tag, state);
      }

      // A terminal codec takes the state exactly as it arrived; a nonterminal
      // one takes it expanded. The two casts restate what `instanceof` just
      // established, which TypeScript drops on a generic class.
      const terminal = matched instanceof BaseTerminalCodec;
      const state = terminal ? rawState : this.#decodeValue(rawState, context);

      try {
        // A codec's `decode()` promises deep-frozen results rather than
        // relying on every caller to freeze, so both returns here pass through
        // `deepFreeze()`. That covers the codec's own product -- a
        // `FabricPrimitive` is already frozen, making it an O(1) cache hit --
        // and the lenient fallback alike. The two arms above are separate and
        // deliberately not covered.
        return deepFreeze(
          terminal
            ? (matched as TerminalCodec<JsonCodecValue>).decode(
              tag,
              rawState,
              context,
            )
            : (matched as NonterminalCodec).decode(
              tag,
              state as FabricValue,
              context,
            ),
        );
      } catch (e: unknown) {
        if (!this.lenient) {
          throw e;
        }

        // Report over the state the codec was actually handed, so that it says
        // what the codec choked on.
        return deepFreeze(
          new ProblematicValue(
            tag,
            state,
            e instanceof Error ? e.message : String(e),
          ),
        );
      }
    }

    // Primitives pass through.
    if (
      data === null || typeof data === "boolean" ||
      typeof data === "number" || typeof data === "string"
    ) {
      return data;
    }

    // Arrays: recursively deserialize elements.
    //
    // One pass. A `/hole` run advances the write index past the indices it
    // stands for, leaving them absent, and the final length is set from that
    // index so that a run in the last position is preserved. Counting the
    // logical length first would mean walking and unwrapping every entry a
    // second time, for a number this pass arrives at anyway.
    //
    // The result is still sized up front, at the entry count. That is exact
    // whenever the array has no holes, which is the ordinary case, and an
    // underestimate otherwise -- growing from there beats growing from empty,
    // and a short array of holes is common enough to be worth not pessimizing.
    //
    // A run's count is validated, wire data being untrusted. Left unchecked it
    // is added to the write index directly, so a string concatenates onto it
    // and a negative or fractional one makes the length assignment throw --
    // failures with no bearing on what went wrong. A run stands for at least
    // one absent index, and anything else is reported instead.
    if (Array.isArray(data)) {
      const result: FabricValue[] = new Array(data.length);
      let targetIndex = 0;
      for (const entry of data) {
        const entryDecoded = this.#unwrapTag(entry);
        if (
          entryDecoded !== null && entryDecoded.tag === CODEC_META_TAGS.hole
        ) {
          const count = entryDecoded.state;
          if (!JsonCodec.#isHoleCount(count)) {
            return new ProblematicValue(
              CODEC_META_TAGS.hole,
              count,
              `hole: expected a positive integer count, got ${
                backtickQuote(toCompactDebugString(count, 30))
              }`,
            );
          }
          targetIndex += count;
        } else {
          result[targetIndex] = this.#decodeValue(entry, context);
          targetIndex++;
        }
      }

      // The total is bounded here rather than each advance being bounded as
      // it happens, because both a single run and the running total can pass
      // what an array may hold, and one check at the end covers both. Beyond
      // that, the assignment below throws `RangeError` from the array
      // machinery, which says nothing about the wire that caused it.
      const MAX_ARRAY_LENGTH = 0xffff_ffff;
      if (targetIndex > MAX_ARRAY_LENGTH) {
        return new ProblematicValue(
          CODEC_META_TAGS.hole,
          data,
          `hole: runs total ${targetIndex} elements, past the ` +
            `${MAX_ARRAY_LENGTH} an array can hold`,
        );
      }

      result.length = targetIndex;
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
          data,
          `object contains reserved /-prefixed key: "${key}"`,
        );
      }
      // A name this runtime reserves cannot be rebuilt by the assignment
      // below: `__proto__` would repoint the result's prototype instead of
      // becoming a property. Such a record cannot have been written by this
      // implementation, whose write path refuses it, so report it rather than
      // decoding something the bytes do not say.
      if (isUnsafeObjectKey(key)) {
        return new ProblematicValue(
          key,
          data,
          `object contains a key this runtime reserves: "${key}"`,
        );
      }
      result[key] = this.#decodeValue(val, context);
    }
    return Object.freeze(result);
  }

  //
  // Static members
  //

  /** Shared text encoder, created once. */
  static readonly #textEncoder = new TextEncoder();

  /** Shared text decoder, created once. */
  static readonly #textDecoder = new TextDecoder();

  /**
   * Registry for the throwaway checks in the testing helpers below: this
   * format's primitive determination, plus the two classes the format uses to
   * represent its own failures. No domain class is registered.
   *
   * That line is what makes those checks answer the question they are asked.
   * They validate that text is well-formed in this wire format, not that any
   * particular class is available to receive it, so a body naming any fabric
   * class has to survive the round trip regardless of who registered what.
   * Both fallbacks are needed for it to:
   *
   * * `UnknownValue` receives an unrecognized tag, and re-encodes to the tag
   *   it came from.
   * * `ProblematicValue` receives a state its codec rejects -- which a codec
   *   may hand back directly rather than throwing, independent of `lenient`
   *   -- and likewise re-encodes.
   *
   * A helper drawing on a fuller registry would instead accept or reject text
   * according to a roster its caller never chose.
   */
  static readonly #testingRegistry: CodecRegistry<JsonCodecValue> =
    createBaseJsonRegistry()
      .extend(UnknownValue[CODEC], ProblematicValue[CODEC]);

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
   * Indicates whether `count` is usable as a `/hole` run length: a safe
   * integer of at least one. A run always stands for at least one absent
   * index, so zero is refused along with everything else that is not a count.
   */
  static #isHoleCount(count: JsonCodecValue): count is number {
    // `isSafeInteger()` returns `false` for a non-number, but it cannot be a
    // TypeScript type predicate on `number` since it also returns `false` for
    // plenty of numbers. So, the subsequent cast `as number` is safe by
    // construction but is nonetheless required.
    return Number.isSafeInteger(count) && ((count as number) >= 1);
  }

  /**
   * Returns true if `v` is a single-key object whose key starts with `/` --
   * the wire form of an encoded instance (tag-wrapped value).
   */
  static #isEncodedInstance(v: JsonCodecValue): boolean {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const keys = Object.keys(v);
    return keys.length === 1 && keys[0]!.startsWith("/");
  }

  /**
   * Returns true if the already-encoded codec value `v` can be embedded
   * inside a /quote wrap without inner deserialization: primitives, plain
   * objects/arrays free of non-/quote encoded instances, and /quote-wrapped
   * values (which `#unquote()` can collapse).
   */
  static #isQuoteSafe(v: JsonCodecValue): boolean {
    if (v === null || typeof v !== "object") return true;
    if (Array.isArray(v)) {
      return v.every((item) => JsonCodec.#isQuoteSafe(item));
    }
    if (!JsonCodec.#isEncodedInstance(v)) {
      return Object.values(v).every((item) =>
        JsonCodec.#isQuoteSafe(item as JsonCodecValue)
      );
    }
    return Object.keys(v)[0] === "/quote";
  }

  /**
   * Unwraps /quote forms one level so their literal content can be embedded
   * directly inside a parent /quote. The inner content of a /quote is already
   * literal and must not be recursed into.
   */
  static #unquote(v: JsonCodecValue): JsonCodecValue {
    if (v === null || typeof v !== "object") {
      return v;
    } else if (Array.isArray(v)) {
      const result = v.map(JsonCodec.#unquote) as JsonCodecValue;
      return Object.freeze(result);
    } else if (
      JsonCodec.#isEncodedInstance(v) && Object.keys(v)[0] === "/quote"
    ) {
      return (v as Record<string, JsonCodecValue>)["/quote"]!;
    } else {
      const result = Object.fromEntries(
        Object.entries(v).map(
          ([k, val]) => [k, JsonCodec.#unquote(val as JsonCodecValue)],
        ),
      ) as JsonCodecValue;
      return Object.freeze(result);
    }
  }

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
   * That is enforced rather than merely advised: by default this performs a
   * throwaway decode of `encoded` and throws if it is not genuinely decodable.
   * So it cannot serve as a cheap "chop off the first few characters," and it
   * is far too expensive to belong on any hot path.
   *
   * Pass `isMalformed` when the payload is bad on purpose. The decode is then
   * skipped entirely -- malformed means malformed, and deliberately broken text
   * cannot be asked to survive a decode. Only the prefix check remains.
   *
   * The tag itself is still required either way. That is not a judgment about
   * the payload: removing a prefix that is not there does not produce the body,
   * it produces nonsense, so there is nothing for this to return.
   *
   * `registry` decides what the check is able to read, and so what counts as
   * decodable. It defaults to the format-only registry described above, under
   * which any tag is acceptable; pass one carrying a class roster to hold the
   * payload to that roster's codecs as well.
   */
  static unwrapEncodedValueForTesting(
    encoded: string,
    isMalformed = false,
    registry: CodecRegistry<JsonCodecValue> = JsonCodec.#testingRegistry,
  ): string {
    if (isMalformed) {
      if (!JsonCodec.seemsLikeEncoded(encoded)) {
        throw new Error(
          `Not a JSON-encoded \`FabricValue\` string: ${
            backtickQuote(encoded)
          }`,
        );
      }
    } else {
      // Throwaway decode. The result is discarded; it is performed only to
      // establish that `encoded` really is one of ours, rather than a string
      // that happens to begin with the right few characters. (`decode()` checks
      // the tag first, so the malformed branch above loses nothing.)
      new JsonCodec({ registry }).decode(
        encoded,
        JsonCodec.#testingReconstructionContext,
      );
    }

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
   * Pass `isMalformed` when the payload is bad on purpose -- a test that wants
   * the decoder to choke on it, say. No check runs at all in that case:
   * malformed means malformed, and text that is deliberately broken cannot be
   * asked to survive a decode. The result is the tag with `json` after it,
   * whatever `json` is. The flag is the call site saying out loud that the
   * badness is the point.
   *
   * `registry` decides what the check is able to read, exactly as for
   * `unwrapEncodedValueForTesting()`.
   */
  static wrapEncodedValueForTesting(
    json: string,
    isMalformed = false,
    registry: CodecRegistry<JsonCodecValue> = JsonCodec.#testingRegistry,
  ): string {
    const encoded = ENCODING_PREFIX_TAG + json;

    if (!isMalformed) {
      // Throwaway decode and re-encode; both results are discarded. See above.
      const jsonCodec = new JsonCodec({ registry });
      jsonCodec.encode(
        jsonCodec.decode(
          encoded,
          JsonCodec.#testingReconstructionContext,
        ),
      );
    }

    return encoded;
  }

  /** Parses the JSON-text wire form, _without_ a tag prefix. */
  static #parseWireText(jsonText: string): JsonCodecValue {
    return deepFreeze(JSON.parse(jsonText) as JsonCodecValue);
  }
}
