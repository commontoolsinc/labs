/**
 * A content-addressed identifier: a hash digest paired with an algorithm tag.
 * Extends `SpecialPrimitiveValue` -- treated like a primitive in the storable
 * type system (always frozen, passes through conversion unchanged).
 *
 * Stringification produces `<algorithmTag>:<base64hash>` where `<base64hash>`
 * is the unpadded base64 encoding of the hash bytes. For example:
 * `fid1:abc123...`
 */
import { SpecialPrimitiveValue } from "./special-primitive-value.ts";
import { toUnpaddedBase64 } from "./bigint-encoding.ts";

export class StorableContentId extends SpecialPrimitiveValue {
  constructor(
    /** The raw hash bytes. */
    readonly hash: Uint8Array,
    /** Algorithm identifier (e.g., `"fid1"` for fabric ID v1). */
    readonly algorithmTag: string,
  ) {
    super();
    Object.freeze(this);
  }

  /** Returns `<algorithmTag>:<base64hash>` (unpadded base64). */
  override toString(): string {
    return `${this.algorithmTag}:${toUnpaddedBase64(this.hash)}`;
  }
}
