import type {
  FabricHash as ApiFabricHash,
  FabricHashConstructor as ApiFabricHashConstructor,
} from "@commonfabric/api";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { isPlainObject } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";

/**
 * Content-addressed identifier: a hash digest paired with an algorithm tag.
 *
 * Stringification produces `<tag>:<base64urlHash>` where
 * `<base64urlHash>` is the unpadded base64url encoding (RFC 4648 section 5)
 * of the hash bytes. For example: `fid1:abc123...`
 *
 * Immutable by convention: instances are `Object.freeze()`-d at construction
 * time, and the constructor assumes ownership of the `hash` bytes (callers
 * must not mutate the `Uint8Array` after passing it in, since JS cannot
 * freeze `ArrayBuffer` contents). The string form is cached internally so
 * that repeated `toString()` calls are O(1).
 */
export class FabricHash extends BaseFabricPrimitive implements ApiFabricHash {
  readonly #hash: Uint8Array;
  readonly #tag: string;
  readonly #justHashString: string;
  readonly #fullStringForm: string;

  /**
   * Constructs a `FabricHash` from raw hash bytes and an algorithm tag.
   * The instance is frozen after construction.
   *
   * **Ownership transfer:** the caller must not mutate `hash` after passing
   * it to the constructor. `Object.freeze` freezes the object reference but
   * not the underlying `ArrayBuffer`, so the bytes remain technically
   * mutable. The cached string form is computed once at construction time;
   * post-construction mutation of the bytes would cause the internal state
   * and `toString()` to diverge.
   *
   * @param hash - The raw hash bytes (ownership transferred to this instance).
   * @param tag - Algorithm identifier (e.g., `"fid1"` for fabric ID v1).
   */
  constructor(
    hash: Uint8Array,
    tag: string,
  ) {
    super();
    this.#hash = hash;
    this.#tag = tag;
    this.#justHashString = toUnpaddedBase64url(hash);
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

  /** Copies the hash bytes into `target` starting at offset 0. Returns `target`. */
  copyInto(target: Uint8Array): Uint8Array {
    target.set(this.#hash);
    return target;
  }

  /** Returns the tagged hash string, same as `.taggedHashString`. */
  override toString(): string {
    return this.#fullStringForm;
  }

  /**
   * Parses an instance from its string representation
   * (`<tag>:<base64urlHash>`). Splits at the LAST colon: the hash segment is
   * base64url and never contains one, while the tag segment may in principle.
   * Entity kinds do NOT ride the tag — they ride the URI scheme OUTSIDE the
   * tagged-hash string (`computed:fid1:<hash>`; see `entity-kind.ts`), so a
   * kinded id's hash portion parses here as a plain `fid1` hash.
   */
  static fromString(source: string): FabricHash {
    const colonIndex = source.lastIndexOf(":");
    if (colonIndex === -1) {
      throw new ReferenceError(`Invalid content hash string: ${source}`);
    }
    const tag = source.substring(0, colonIndex);
    const hashBase64url = source.substring(colonIndex + 1);
    return new FabricHash(fromBase64url(hashBase64url), tag);
  }

  static #codec = Object.freeze(
    new (class HashCodec extends BaseFabricCodec {
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
        _context: ReconstructionContext,
      ): FabricValue {
        if (!isPlainObject(state)) {
          return new ProblematicValue(
            typeTag,
            state,
            `Hash: expected object state, got ${typeof state}`,
          );
        }
        const { tag, hash } = state as Record<string, unknown>;
        if (typeof tag !== "string" || typeof hash !== "string") {
          return new ProblematicValue(
            typeTag,
            state,
            "Hash: expected string `tag` and `hash`",
          );
        }
        try {
          return new FabricHash(fromBase64url(hash), tag);
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

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}

// Compile-time check that the exported `FabricHash` constructor matches the
// `FabricHashConstructor` declared in `@commonfabric/api`. This catches drift
// between the public type contract and this implementation.
FabricHash satisfies ApiFabricHashConstructor;
