import type {
  FabricHash as ApiFabricHash,
  FabricHashConstructor as ApiFabricHashConstructor,
} from "@commonfabric/api";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { toOwnedUint8Array } from "@commonfabric/utils/buffers";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject } from "@commonfabric/utils/types";

import { BaseFabricPrimitive } from "@/codec-common/BaseFabricPrimitive.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import {
  type DecodeContext,
  JSON_CODEC,
  type NonterminalCodec,
  REALM_CODEC,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import type { RealmCodecValue } from "@/codec-realm/interface.ts";
import type { FabricValue } from "@/interface.ts";

/**
 * Content-addressed identifier: a hash digest paired with an algorithm tag.
 *
 * Stringification produces `<tag>:<base64urlHash>` where
 * `<base64urlHash>` is the unpadded base64url encoding (RFC 4648 section 5)
 * of the hash bytes. For example: `fid1:abc123...`
 *
 * Immutable: instances are `Object.freeze()`-d at construction time, and an
 * instance owns its hash bytes outright, holding a buffer no other code can
 * reach. (JS cannot freeze `ArrayBuffer` contents, so sole ownership is the
 * defense, and it is what keeps the bytes from drifting out of agreement with
 * the string form cached beside them.) That string form is cached so that
 * repeated `toString()` calls are O(1).
 */
export class FabricHash extends BaseFabricPrimitive implements ApiFabricHash {
  /**
   * Private byte storage. Guaranteed to be backed by an exact-sized and
   * unshared `ArrayBuffer`.
   */
  readonly #hash: Uint8Array<ArrayBuffer>;
  readonly #tag: string;
  readonly #justHashString: string;
  readonly #fullStringForm: string;

  /**
   * Constructs an instance from raw hash bytes and an algorithm tag, owning
   * the bytes outright. The instance is frozen after construction.
   *
   * @param hash - The raw hash bytes.
   * @param tag - Algorithm identifier (e.g., `fid1` for fabric ID v1).
   * @param transfer - Whether the caller cedes `hash` to this instance, which
   *   permits taking over its buffer instead of copying it. When `true`, the
   *   caller must not use `hash` afterwards; `toOwnedUint8Array()` says what that
   *   permission does and does not guarantee.
   */
  constructor(
    hash: Uint8Array,
    tag: string,
    transfer: boolean = false,
  ) {
    super();
    this.#hash = toOwnedUint8Array(hash, transfer);
    this.#tag = tag;
    this.#justHashString = toUnpaddedBase64url(this.#hash);
    this.#fullStringForm = `${tag}:${this.#justHashString}`;
    Object.freeze(this);
  }

  /** Defensive copy of the raw hash bytes. */
  get bytes(): Uint8Array {
    return new Uint8Array(this.#hash);
  }

  /** Length of the hash in bytes. */
  get length(): number {
    return this.#hash.length;
  }

  /** The algorithm tag (e.g., `"fid1"`, `"legacy"`). */
  get tag(): string {
    return this.#tag;
  }

  /**
   * String form of the hash _without_ an algorithm tag. The hash is in unpadded
   * base64url form.
   */
  get hashString(): string {
    return this.#justHashString;
  }

  /**
   * String form of the hash _with_ an algorithm tag. The form is
   * `<tag>:<base64urlHash>`, where the hash portion is in an unpadded base64url
   * string.
   */
  get taggedHashString(): string {
    return this.#fullStringForm;
  }

  /**
   * Copies the hash bytes into `target` starting at offset `0`, and returns
   * `target`.
   */
  copyInto(target: Uint8Array): Uint8Array {
    target.set(this.#hash);
    return target;
  }

  /** Returns the tagged hash string, same as `.taggedHashString`. */
  override toString(): string {
    return this.#fullStringForm;
  }

  //
  // Static members
  //

  static #jsonCodec = Object.freeze(
    new (class HashCodec extends BaseNonterminalCodec {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Hash, FabricHash);
      }

      /** @inheritDoc */
      encode(value: FabricHash): FabricValue {
        return { tag: value.tag, hash: value.hashString };
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        _context: DecodeContext,
      ): FabricValue {
        if (!isPlainObject(state)) {
          return new ProblematicValue(
            typeTag,
            state,
            `Hash: expected object state, got ${typeof state}`,
          );
        }
        const { tag, hash } = state;
        if (typeof tag !== "string" || typeof hash !== "string") {
          return new ProblematicValue(
            typeTag,
            state,
            "Hash: expected string `tag` and `hash`",
          );
        }
        try {
          return new FabricHash(fromBase64url(hash), tag, true);
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            `Hash: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    })(),
  );

  static #realmCodec = Object.freeze(
    new (class HashCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Hash, FabricHash);
      }

      /**
       * @inheritDoc
       *
       * The buffer covers exactly these bytes and is nobody else's: a
       * transfer hands over the whole of one, so a state covering more than
       * the value would cede bytes that are not part of it, and one shared
       * with this instance would leave a transferred value hollow.
       */
      encode(value: FabricHash): RealmCodecValue {
        return { tag: value.tag, hash: value.#hash.buffer.slice(0) };
      }

      /**
       * @inheritDoc
       *
       * Reports a bad state by returning a `ProblematicValue`, as this
       * class's JSON codec does. The two ways a codec can reject -- this and
       * throwing -- are equivalent to a caller, the engine settling them
       * against `lenient`, so what decides between them is consistency across
       * the codecs a reader meets together.
       *
       * The one exception is a detached buffer, which throws. It is not a
       * malformed state -- it is a well-formed one this tree already spent --
       * and it is caught rather than tested for, the constructor being what
       * discovers it. Reporting it by return would mean asking the same
       * question twice, once here and once there.
       */
      decode(
        typeTag: string,
        state: RealmCodecValue,
        _context: DecodeContext,
      ): FabricValue {
        if (!isPlainObject(state)) {
          return new ProblematicValue(
            typeTag,
            state,
            `expected object state, got ${typeof state}`,
          );
        }

        const { tag, hash } = state as { tag: any; hash: any };
        if ((typeof tag !== "string") || !(hash instanceof ArrayBuffer)) {
          return new ProblematicValue(
            typeTag,
            state,
            `expected string \`tag\` and \`ArrayBuffer\` \`hash\``,
          );
        }

        // Taken over rather than copied, as `FabricBytes` does: the buffer
        // arrived either by being cloned, making it this realm's own, or by
        // being transferred, which detached the sender's.
        try {
          return new FabricHash(new Uint8Array(hash), tag, true);
        } catch (e) {
          // A detached buffer, for the reason `FabricBytes` states: it
          // detaches by having been taken over, so this tree was decoded
          // before.
          throw new Error(
            "The state's buffer is detached, this tree having been decoded " +
              "already.",
            { cause: e },
          );
        }
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [JSON_CODEC](): NonterminalCodec {
    return this.#jsonCodec;
  }

  /**
   * The codec for instances of this class in the realm-crossing format.
   *
   * Terminal, and it is the hash bytes that make it so rather than the record
   * around them. A `Uint8Array` is in this format's domain and is not a
   * `FabricValue`, so a state holding one has no nonterminal reading. The
   * record being a plain object decides nothing either way.
   *
   * The state is terminal, and its `hash` is a bare `ArrayBuffer` for the
   * reason `FabricBytes` encodes to one: that is the form `postMessage()` can
   * *transfer*, so a caller assembling a transfer list finds a transferable
   * object here rather than a view it would have to reach through.
   */
  static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
    return this.#realmCodec;
  }

  /**
   * Parses an instance from its string representation
   * (`<tag>:<base64urlHash>`), which contains exactly one colon: a tag has
   * none, and neither does base64url. Splitting at the first colon therefore
   * rejects any source bearing a second one, since the colon then falls in the
   * hash segment, where it is not valid base64url.
   *
   * That rejection is a feature. A string with an extra colon is not a tagged
   * hash, and the only alternative to refusing it is to guess which colon was
   * meant -- silently returning a `FabricHash` with a tag its author never
   * wrote, which renders back as the string it came from and so looks correct.
   */
  static fromString(source: string): FabricHash {
    const colonIndex = source.indexOf(":");
    if (colonIndex === -1) {
      throw new ReferenceError(
        `Invalid content hash string: ${backtickQuote(source)}`,
      );
    }
    const tag = source.substring(0, colonIndex);
    const hashBase64url = source.substring(colonIndex + 1);
    return new FabricHash(fromBase64url(hashBase64url), tag, true);
  }
}

// Compile-time check that the exported `FabricHash` constructor matches the
// `FabricHashConstructor` declared in `@commonfabric/api`. This catches drift
// between the public type contract and this implementation.
FabricHash satisfies ApiFabricHashConstructor;
