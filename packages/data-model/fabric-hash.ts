import { FabricPrimitive } from "./interface.ts";
import { fromBase64url, toUnpaddedBase64url } from "./base64url.ts";

/**
 * A content-addressed identifier: a hash digest paired with an algorithm tag.
 * Extends `FabricPrimitive` -- treated like a primitive in the fabric
 * type system (always frozen, passes through conversion unchanged).
 *
 * Stringification produces `<algorithmTag>:<base64urlHash>` where
 * `<base64urlHash>` is the unpadded base64url encoding (RFC 4648 section 5)
 * of the hash bytes. For example: `fid1:abc123...`
 *
 * Immutable by convention: instances are `Object.freeze()`-d at construction
 * time, and the constructor assumes ownership of the `hash` bytes (callers
 * must not mutate the `Uint8Array` after passing it in, since JS cannot
 * freeze `ArrayBuffer` contents). The string form is cached internally so
 * that repeated `toString()` calls are O(1).
 */
export class FabricHash extends FabricPrimitive {
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
   * post-construction mutation of `hash` would cause `hash` and `toString()`
   * to diverge.
   *
   * @param hash - The raw hash bytes (ownership transferred to this instance).
   * @param algorithmTag - Algorithm identifier (e.g., `"fid1"` for fabric ID v1).
   */
  constructor(
    readonly hash: Uint8Array, // TODO(@danfuzz): Should not be exposed.
    readonly algorithmTag: string,
  ) {
    super();
    this.#justHashString = toUnpaddedBase64url(hash);
    this.#fullStringForm = `${algorithmTag}:${this.#justHashString}`;
    Object.freeze(this);
  }

  /**
   * CID-link-style accessor, returns the raw hash bytes. Present to satisfy
   * the `EntityId` structural type (`{ "/": string | Uint8Array }`).
   * TODO(danfuzz): Remove after canonical hashing flag graduates.
   */
  get "/"(): Uint8Array {
    return this.hash; // TODO(@danfuzz): `hash` should not be exposed.
  }

  /** Defensive copy of the raw hash bytes. */
  get bytes(): Uint8Array {
    return new Uint8Array(this.hash);
  }

  /** Length of the hash in bytes. */
  get length(): number {
    return this.hash.length;
  }

  /** String form of the hash _without_ an algorithm tag. */
  get hashString(): string {
    return this.#justHashString;
  }

  /** Copy the hash bytes into `target` starting at offset 0. Returns `target`. */
  copyInto(target: Uint8Array): Uint8Array {
    target.set(this.hash);
    return target;
  }

  /** Returns `<algorithmTag>:<base64urlHash>` (unpadded base64url). */
  override toString(): string {
    return this.#fullStringForm;
  }

  /**
   * JSON representation: `{ '/': '<algorithmTag>:<base64urlHash>' }`.
   * Preserves the `{"/": string}` shape used by `Reference.View.toJSON()`.
   */
  toJSON(): { "/": string } {
    return { "/": this.#fullStringForm };
  }

  /**
   * Parse an instance from its string representation
   * (`<algorithmTag>:<base64urlHash>`).
   */
  static fromString(source: string): FabricHash {
    const colonIndex = source.indexOf(":");
    if (colonIndex === -1) {
      throw new ReferenceError(`Invalid content hash string: ${source}`);
    }
    const algorithmTag = source.substring(0, colonIndex);
    const hashBase64url = source.substring(colonIndex + 1);
    return new FabricHash(fromBase64url(hashBase64url), algorithmTag);
  }
}
