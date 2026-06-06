import { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";

/**
 * Immutable byte sequence in the fabric type system.
 *
 * The underlying bytes are private. Callers access them through:
 * - `length` -- the byte count.
 * - `slice()` -- returns an unshared copy (or sub-range).
 * - `copyInto()` -- copies bytes into a caller-provided buffer.
 *
 * Immutable by convention: instances are `Object.freeze()`-d at construction
 * time, and the constructor copies the input bytes so the caller cannot mutate
 * them after construction. (JS cannot freeze `ArrayBuffer` contents, so the
 * copy is the defense.)
 */
export class FabricBytes extends BaseFabricPrimitive {
  /** Private byte storage. Callers use `slice()` or `copyInto()`. */
  readonly #bytes: Uint8Array;

  /**
   * Constructs a `FabricBytes` from raw bytes. The input is copied;
   * the caller may freely mutate the original after construction.
   *
   * @param bytes - The raw bytes to wrap (copied, not shared).
   */
  constructor(bytes: Uint8Array) {
    super();
    this.#bytes = new Uint8Array(bytes);
    Object.freeze(this);
  }

  /** @inheritDoc */
  get wireTypeTag(): string {
    return WIRE_TYPE_TAGS.Bytes;
  }

  /** The number of bytes. */
  get length(): number {
    return this.#bytes.length;
  }

  /**
   * Returns a copy of the bytes (or a sub-range). The returned array is
   * unshared -- the caller may mutate it freely.
   *
   * @param start - Start index (inclusive, default 0).
   * @param end - End index (exclusive, default `length`).
   */
  slice(start?: number, end?: number): Uint8Array {
    return this.#bytes.slice(start, end);
  }

  /**
   * Copies bytes from this instance into a caller-provided buffer.
   *
   * @param target - The destination buffer.
   * @param offset - Byte offset in the source to start copying from (default 0).
   * @param length - Number of bytes to copy (default: all remaining from offset).
   * @returns The number of bytes actually copied.
   */
  copyInto(target: Uint8Array, offset = 0, length?: number): number {
    if (offset < 0) {
      throw new RangeError(
        `copyInto: offset must be non-negative, got ${offset}`,
      );
    }
    if (length !== undefined && length < 0) {
      throw new RangeError(
        `copyInto: length must be non-negative, got ${length}`,
      );
    }
    const available = this.#bytes.length - offset;
    if (available <= 0) return 0;
    const toCopy = Math.min(length ?? available, available, target.length);
    target.set(this.#bytes.subarray(offset, offset + toCopy));
    return toCopy;
  }
}
