import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

import type { FabricValue } from "@/interface.ts";
import { BaseCodecEngine } from "@/codec-common/BaseCodecEngine.ts";
import { ProblematicStateError } from "@/codec-common/ProblematicStateError.ts";
import { DecodeAct } from "@/codec-common/DecodeAct.ts";
import { EncodeAct } from "@/codec-common/EncodeAct.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { CODEC, type LiveEnvironment } from "@/codec-interface/interface.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { NullLiveEnvironment } from "@/codec-interface/NullLiveEnvironment.ts";
import { UnknownValue } from "@/codec-common/UnknownValue.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { ENCODING_PREFIX_TAG, type JsonCodecValue } from "./interface.ts";
import { createBaseJsonRegistry } from "./createBaseJsonRegistry.ts";
import type { CodecRegistry } from "@/codec-common/CodecRegistry.ts";
import { CODEC_META_TAGS } from "@/codec-interface/codec-meta-tags.ts";

/**
 * Whole-value JSON codec implementing the `/<Type>@<Version>` wire format from
 * the formal spec (Section 5).
 *
 * Public instance surface, two directions and two boundary types:
 * - `encode(value, env?)` -- full pipeline: tree-encode + stringify
 * - `decode(data, env)` -- full pipeline: parse + tree-decode
 * - `encodeToBytes(value, env?)` -- as `encode()`, to UTF-8 bytes
 * - `decodeFromBytes(bytes, env)` -- as `decode()`, from UTF-8 bytes
 *
 * The machinery beneath is not public, and divides in two. The tree
 * walkers, the tag wrapper and the act factories are `protected`:
 * that is the surface a second engine extends, whether or not this one
 * overrides any given member of it. This class's own helpers -- byte
 * conversion, wire-text parsing, tag unwrapping and the container decode
 * arms -- are `#`-private. Per-type encoding and decoding is delegated to
 * the `FabricCodec`s in the `CodecRegistry`.
 *
 * Three statics are public besides: `seemsLikeEncoded()`, and the
 * `wrapEncodedValueForTesting()` / `unwrapEncodedValueForTesting()` pair
 * that lets a test build and take apart this format's tagged form without
 * reaching into the private wrapper.
 *
 * **Cycles are refused** and **shared references are flattened**, per Section
 * 1.6 of the formal spec, which requires an engine to say which of these it
 * does. Both follow from reaching text: JSON cannot represent a reference,
 * so a cycle has no encoding at all and is raised at the walk, and a value
 * held at two positions is written out twice, arriving as two objects that a
 * receiver cannot tell from two that were always distinct.
 */
export class JsonCodecEngine extends BaseCodecEngine<JsonCodecValue, string> {
  //
  // Instance members
  //

  /** @inheritDoc */
  protected override newEncodeAct(env: LiveEnvironment): EncodeAct {
    return new EncodeAct(env);
  }

  /**
   * @inheritDoc
   *
   * A plain one: this walk never enters a node, for the reason
   * {@link #decode} gives, so the act's in-progress set is never
   * allocated.
   */
  protected override newDecodeAct(
    env: LiveEnvironment,
    _data: string,
  ): DecodeAct {
    return new DecodeAct(env);
  }

  /**
   * @inheritDoc
   *
   * Stringifies the walked tree and prefixes the format tag.
   */
  protected override serializedFromEncoded(
    encoded: JsonCodecValue,
    _act: EncodeAct,
  ): string {
    return ENCODING_PREFIX_TAG + JSON.stringify(encoded);
  }

  /**
   * @inheritDoc
   *
   * Checks the format tag and parses what follows it. A string without the tag
   * is not this format's serialized form at all, which is refused here rather
   * than walked -- and settles against `lenient` like any other malformation
   * off a channel.
   */
  protected override encodedFromSerializedForm(data: string): JsonCodecValue {
    if (!JsonCodecEngine.seemsLikeEncoded(data)) {
      const excerpt = (data.length <= 50) ? data : `${data.slice(0, 50)}...`;
      throw new ProblematicStateError(
        "",
        excerpt,
        `Not a JSON-encoded \`FabricValue\` string: ${backtickQuote(excerpt)}`,
      );
    }

    return JsonCodecEngine.#parseWireText(
      data.slice(ENCODING_PREFIX_TAG.length),
    );
  }

  /** Encodes a fabric value to UTF-8 JSON bytes. */
  encodeToBytes(
    value: FabricValue,
    env: LiveEnvironment = NULL_LIVE_ENVIRONMENT,
  ): Uint8Array {
    return JsonCodecEngine.#toBytes(
      this.encodeValue(value, this.newEncodeAct(env)),
    );
  }

  /**
   * Decodes UTF-8 JSON bytes back into a fabric value. Carries no cycle
   * guard, for the reason {@link #decode} gives: this walk too gets its tree
   * from a parse.
   */
  decodeFromBytes(
    bytes: Uint8Array,
    env: LiveEnvironment = NULL_LIVE_ENVIRONMENT,
  ): FabricValue {
    const text = JsonCodecEngine.#textDecoder.decode(bytes);
    const act = this.newDecodeAct(env, text);
    let tree: JsonCodecValue;

    try {
      tree = JsonCodecEngine.#parseWireText(text);
    } catch (e) {
      return this.settleSyntacticRefusal(e);
    }

    return this.decodeValue(tree, act);
  }

  /**
   * @inheritDoc
   *
   * Prepends `/` to the tag to produce the JSON key. See Section 5.2 of the
   * formal spec.
   *
   * The result is not frozen. An encode-side tree is stringified and
   * discarded without ever reaching a caller, so the deep-frozen invariant
   * `JsonCodecValue` states does not cover it, and freezing every tagged node
   * on the way out is measurable on small values. The meta-tag call sites
   * below freeze what they build, where the cost is already paid by the
   * rebuild around it.
   */
  protected override wrapTag(
    tag: string,
    state: JsonCodecValue,
    _act: EncodeAct,
  ): JsonCodecValue {
    return { [`/${tag}`]: state } as JsonCodecValue;
  }

  /**
   * @inheritDoc
   *
   * A run of holes is represented as a `/hole` count, JSON having no way
   * to write an absent index.
   */
  protected override encodeArray(
    value: readonly FabricValue[],
    act: EncodeAct,
  ): JsonCodecValue {
    act.enter(value);

    const result: JsonCodecValue[] = [];
    try {
      let i = 0;
      while (i < value.length) {
        if (!(i in value)) {
          let count = 0;
          while (i < value.length && !(i in value)) {
            count++;
            i++;
          }
          result.push(
            Object.freeze(this.wrapTag(CODEC_META_TAGS.hole, count, act)),
          );
        } else {
          result.push(this.encodeValue(value[i]!, act));
          i++;
        }
      }
    } finally {
      act.leave(value);
    }

    return result as JsonCodecValue;
  }

  /**
   * @inheritDoc
   *
   * Keys are visited in UTF-8 byte order, matching the canonical order
   * `value-hash.ts` uses, so that this encoding is deterministic across
   * implementations and across objects whose keys differ only in insertion
   * order. See `3-json-encoding.md` Section 10.
   *
   * A `/`-prefixed key collides with the tag form, so an object bearing one is
   * escaped per Section 5.6: all values are encoded first, and if every one is
   * quote-safe the whole object is wrapped in `/quote` with any `/quote`
   * children collapsed into it, and otherwise in `/object` so that the decoder
   * walks the entries.
   */
  protected override encodePlainObject(
    value: Record<string, FabricValue>,
    act: EncodeAct,
  ): JsonCodecValue {
    act.enter(value);

    const result: Record<string, JsonCodecValue> = {};
    let anySlashKey = false;
    try {
      for (const key of utf8SortedKeysOf(value)) {
        JsonCodecEngine.assertEncodableKey(key);

        if (key.startsWith("/")) {
          anySlashKey = true;
        }
        result[key] = this.encodeValue(value[key]!, act);
      }
    } finally {
      act.leave(value);
    }

    if (anySlashKey) {
      if (Object.values(result).every((v) => JsonCodecEngine.#isQuoteSafe(v))) {
        const unquoted = Object.freeze(
          Object.fromEntries(
            Object.entries(result).map((
              [k, v],
            ) => [k, JsonCodecEngine.#unquote(v)]),
          ),
        );
        return Object.freeze(
          this.wrapTag(CODEC_META_TAGS.quote, unquoted, act),
        );
      }
      return Object.freeze(this.wrapTag(CODEC_META_TAGS.object, result, act));
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
  protected override decodeValue(
    data: JsonCodecValue,
    act: DecodeAct,
  ): FabricValue {
    const decoded = JsonCodecEngine.#unwrapTag(data);
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
            return this.reportReservedKey(key, inner);
          }
          result[key] = this.decodeValue(val, act);
        }
        return Object.freeze(result);
      }

      // `/quote` and `/object` returned above, so no codec ever sees their
      // state, and `/quote` contents alone go undecoded.
      return this.decodeTagged(tag, rawState, act);
    }

    // Primitives pass through.
    if (
      data === null || typeof data === "boolean" ||
      typeof data === "number" || typeof data === "string"
    ) {
      return data;
    }

    if (Array.isArray(data)) {
      return this.#decodeArray(data, act);
    }

    // `Array.isArray()` above removed the array arm, but TypeScript keeps it
    // in the union; the remaining member is the record.
    return this.#decodePlainObject(
      data as Record<string, JsonCodecValue>,
      act,
    );
  }

  /**
   * Arrays: recursively decode elements.
   *
   * One pass. A `/hole` run advances the write index past the indices it
   * stands for, leaving them absent, and the final length is set from that
   * index so that a run in the last position is preserved. Counting the
   * logical length first would mean walking and unwrapping every entry a
   * second time, for a number this pass arrives at anyway.
   *
   * The result is still sized up front, at the entry count. That is exact
   * whenever the array has no holes, which is the ordinary case, and an
   * underestimate otherwise -- growing from there beats growing from empty,
   * and a short array of holes is common enough to be worth not pessimizing.
   *
   * A run's count is validated, wire data being untrusted. Left unchecked it
   * is added to the write index directly, so a string concatenates onto it
   * and a negative or fractional one makes the length assignment throw --
   * failures with no bearing on what went wrong. A run stands for at least
   * one absent index, and anything else is reported instead.
   */
  #decodeArray(
    data: readonly JsonCodecValue[],
    act: DecodeAct,
  ): FabricValue {
    const result: FabricValue[] = new Array(data.length);
    let targetIndex = 0;
    for (const entry of data) {
      const entryDecoded = JsonCodecEngine.#unwrapTag(entry);
      if (
        entryDecoded !== null && entryDecoded.tag === CODEC_META_TAGS.hole
      ) {
        const count = entryDecoded.state;
        if (!JsonCodecEngine.#isHoleCount(count)) {
          return this.reportMalformed(
            CODEC_META_TAGS.hole,
            count,
            `hole: expected a positive integer count, got ${
              backtickQuote(toCompactDebugString(count, 30))
            }`,
          );
        }
        targetIndex += count;
      } else {
        result[targetIndex] = this.decodeValue(entry, act);
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
      return this.reportMalformed(
        CODEC_META_TAGS.hole,
        data,
        `hole: runs total ${targetIndex} elements, past the ` +
          `${MAX_ARRAY_LENGTH} an array can hold`,
      );
    }

    result.length = targetIndex;
    return Object.freeze(result);
  }

  /**
   * Plain objects: recursively decode values and freeze. Any
   * `/`-prefixed key is reserved per spec — return `ProblematicValue` on
   * first occurrence rather than silently round-tripping the object.
   */
  #decodePlainObject(
    data: Record<string, JsonCodecValue>,
    act: DecodeAct,
  ): FabricValue {
    const result: Record<string, FabricValue> = {};
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith("/")) {
        return this.reportMalformed(
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
        return this.reportReservedKey(key, data);
      }
      result[key] = this.decodeValue(val, act);
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
   * Live environment for the throwaway checks in the testing helpers
   * below. Deep-freezes, as the ordinary decode path does. Paired with a
   * lenient engine, a cell reference degrades to a `ProblematicValue`
   * rather than throwing.
   */
  static readonly #testingLiveEnvironment = Object.freeze(
    new NullLiveEnvironment(
      true,
      "no live environment (validity check in a test-only helper).",
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
    registry: CodecRegistry<JsonCodecValue> = JsonCodecEngine.#testingRegistry,
  ): string {
    if (isMalformed) {
      if (!JsonCodecEngine.seemsLikeEncoded(encoded)) {
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
      new JsonCodecEngine({ registry }).decode(
        encoded,
        JsonCodecEngine.#testingLiveEnvironment,
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
    registry: CodecRegistry<JsonCodecValue> = JsonCodecEngine.#testingRegistry,
  ): string {
    const encoded = ENCODING_PREFIX_TAG + json;

    if (!isMalformed) {
      // Throwaway decode and re-encode; both results are discarded. See above.
      const jsonCodecEngine = new JsonCodecEngine({ registry });
      jsonCodecEngine.encode(
        jsonCodecEngine.decode(
          encoded,
          JsonCodecEngine.#testingLiveEnvironment,
        ),
      );
    }

    return encoded;
  }

  /**
   * Unwraps a wire representation. Detects single-key objects with `/`-prefixed
   * keys. Returns `{ tag, state }` or `null` if not a tagged value. The
   * returned `state` is extracted directly from `data`, so if `data` is
   * deep-frozen (as it should be) then `state` will be too.
   *
   * See Section 5.4 of the formal spec.
   */
  static #unwrapTag(
    data: JsonCodecValue,
  ): { tag: string; state: JsonCodecValue } | null {
    if (!isPlainObject(data)) {
      return null;
    }

    if (!JsonCodecEngine.#isEncodedInstance(data)) {
      return null;
    }

    // `#isEncodedInstance()` guaranteed a single-property object, so this
    // destructures that one entry.
    const [key, value] = Object.entries(data)[0]!;
    return { tag: key.slice(1), state: value };
  }

  /** Converts a codec-value tree to UTF-8-encoded JSON bytes. */
  static #toBytes(data: JsonCodecValue): Uint8Array {
    return JsonCodecEngine.#textEncoder.encode(JSON.stringify(data));
  }

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
   * inside a /quote wrap without inner decoding: primitives, plain
   * objects/arrays free of non-/quote encoded instances, and /quote-wrapped
   * values (which `#unquote()` can collapse).
   */
  static #isQuoteSafe(v: JsonCodecValue): boolean {
    if (v === null || typeof v !== "object") return true;
    if (Array.isArray(v)) {
      return v.every((item) => JsonCodecEngine.#isQuoteSafe(item));
    }
    if (!JsonCodecEngine.#isEncodedInstance(v)) {
      return Object.values(v).every((item) =>
        JsonCodecEngine.#isQuoteSafe(item as JsonCodecValue)
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
      const result = v.map(JsonCodecEngine.#unquote) as JsonCodecValue;
      return Object.freeze(result);
    } else if (
      JsonCodecEngine.#isEncodedInstance(v) && Object.keys(v)[0] === "/quote"
    ) {
      return (v as Record<string, JsonCodecValue>)["/quote"]!;
    } else {
      const result = Object.fromEntries(
        Object.entries(v).map(
          ([k, val]) => [k, JsonCodecEngine.#unquote(val as JsonCodecValue)],
        ),
      ) as JsonCodecValue;
      return Object.freeze(result);
    }
  }

  /** Parses the JSON-text wire form, _without_ a tag prefix. */
  static #parseWireText(jsonText: string): JsonCodecValue {
    try {
      return deepFreeze(JSON.parse(jsonText) as JsonCodecValue);
    } catch (e) {
      // The tag said this was ours and the text under it is not JSON, which
      // is a refusal of the serialized form and settles against `lenient`
      // like the tag check above it. Raised as this class's own refusal
      // rather than passing `JSON.parse()`'s `SyntaxError` along, which
      // nothing downstream recognizes.
      const excerpt = (jsonText.length <= 50)
        ? jsonText
        : `${jsonText.slice(0, 50)}...`;
      throw new ProblematicStateError(
        "",
        excerpt,
        `Malformed JSON in an encoded \`FabricValue\` string: ${
          backtickQuote(excerpt)
        }`,
        { cause: e },
      );
    }
  }
}
