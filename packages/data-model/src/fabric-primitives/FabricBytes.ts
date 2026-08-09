import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { toOwnedUint8Array } from "@commonfabric/utils/buffers";

import { FabricValue } from "@/interface.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import {
  CODEC,
  FabricCodec,
  ReconstructionContext,
} from "@/codec-common/interface.ts";

/**
 * Immutable byte sequence in the fabric type system.
 *
 * The underlying bytes are private. Callers access them through:
 * - `length` -- the byte count.
 * - `slice()` -- returns an unshared copy (or sub-range).
 * - `copyInto()` -- copies bytes into a caller-provided buffer.
 *
 * Immutable: instances are `Object.freeze()`-d at construction time, and an
 * instance owns its bytes outright, holding a buffer no other code can reach.
 * (JS cannot freeze `ArrayBuffer` contents, so sole ownership is the defense.)
 */
export class FabricBytes extends BaseFabricPrimitive {
  /** Private byte storage. Callers use `slice()` or `copyInto()`. */
  readonly #bytes: Uint8Array;

  /**
   * Constructs an instance holding the given bytes, which it owns outright.
   *
   * @param bytes - The raw bytes to wrap.
   * @param transfer - Whether the caller cedes `bytes` to this instance, which
   *   permits taking over its buffer instead of copying it. When `true`, the
   *   caller must not use `bytes` afterwards; `toOwnedUint8Array()` says what that
   *   permission does and does not guarantee.
   */
  constructor(bytes: Uint8Array, transfer: boolean = false) {
    super();
    this.#bytes = toOwnedUint8Array(bytes, transfer);
    Object.freeze(this);
  }

  //
  // Instance members
  //

  /** The number of bytes. */
  get length(): number {
    return this.#bytes.length;
  }

  /**
   * Returns a copy of the bytes (or a sub-range). The returned array is
   * unshared -- the caller may mutate it freely -- and is backed by a plain
   * `ArrayBuffer`, never a `SharedArrayBuffer`, so it is usable wherever one
   * is required.
   *
   * @param start - Start index (inclusive, default 0).
   * @param end - End index (exclusive, default `length`).
   */
  slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
    return this.#bytes.slice(start, end);
  }

  /**
   * Copies bytes from this instance into a caller-provided buffer.
   *
   * @param target - The destination buffer.
   * @param offset - Byte offset in the source to start copying from
   *   (default `0`).
   * @param length - Number of bytes to copy (default: all remaining from
   *   `offset`).
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

  //
  // Static members
  //

  static #codec = Object.freeze(
    new (class BytesCodec extends BaseFabricCodec {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Bytes, FabricBytes);
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        _context: ReconstructionContext,
      ): FabricBytes | ProblematicValue {
        if (typeof state !== "string") {
          return new ProblematicValue(
            typeTag,
            state,
            `Bytes: expected string state, got ${typeof state}`,
          );
        }
        try {
          const bytes = fromBase64url(state);
          return new FabricBytes(bytes, true);
        } catch {
          return new ProblematicValue(
            typeTag,
            state,
            `Bytes: invalid base64: ${state}`,
          );
        }
      }

      /** @inheritDoc */
      encode(value: FabricBytes): FabricValue {
        return toUnpaddedBase64url(value.#bytes);
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
