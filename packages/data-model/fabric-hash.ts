/**
 * A content-addressed identifier: a hash digest paired with an algorithm tag.
 * Extends `SpecialPrimitiveValue` -- treated like a primitive in the storable
 * type system (always frozen, passes through conversion unchanged).
 *
 * Stringification produces `<algorithmTag>:<base64urlHash>` where
 * `<base64urlHash>` is the unpadded base64url encoding (RFC 4648 section 5)
 * of the hash bytes. For example: `fid1:abc123...`
 */
import { SpecialPrimitiveValue } from "./special-primitive-value.ts";
import { toUnpaddedBase64url } from "./bigint-encoding.ts";

export class FabricHash extends SpecialPrimitiveValue {
  constructor(
    /** The raw hash bytes. */
    readonly hash: Uint8Array,
    /** Algorithm identifier (e.g., `"fid1"` for fabric ID v1). */
    readonly algorithmTag: string,
  ) {
    super();
    Object.freeze(this);
  }

  /**
   * CID-link-style accessor, returns the raw hash bytes. Present to satisfy
   * the `EntityId` structural type (`{ "/": string | Uint8Array }`).
   * TODO(danfuzz): Remove after canonical hashing flag graduates.
   */
  get "/"(): Uint8Array {
    return this.hash;
  }

  /** Defensive copy of the raw hash bytes. */
  get bytes(): Uint8Array {
    return new Uint8Array(this.hash);
  }

  /** Copy the hash bytes into `target` starting at offset 0. Returns `target`. */
  copyHashInto(target: Uint8Array): Uint8Array {
    target.set(this.hash);
    return target;
  }

  /** Returns `<algorithmTag>:<base64urlHash>` (unpadded base64url). */
  override toString(): string {
    return `${this.algorithmTag}:${toUnpaddedBase64url(this.hash)}`;
  }

  /**
   * JSON representation: `{ '/': '<algorithmTag>:<base64urlHash>' }`.
   * Preserves the `{"/": string}` shape used by `Reference.View.toJSON()`.
   */
  toJSON(): { "/": string } {
    return { "/": this.toString() };
  }
}
