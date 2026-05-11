/**
 * Shared BigInt two's-complement big-endian encoding, and base64url helpers for
 * the JSON wire format. Used by both `value-hash.ts` (byte-level hashing)
 * and `json-type-handlers.ts` (JSON serialization).
 *
 * The two's-complement encoding is minimal: no unnecessary leading 0x00 bytes
 * for positive values, no unnecessary leading 0xFF bytes for negative values,
 * except as needed for sign extension.
 */

// ---------------------------------------------------------------------------
// `bigint` -> minimal two's-complement big-endian bytes
// ---------------------------------------------------------------------------

/**
 * Helper for `bigintToMinimalTwosComplement()`, which converts a hex digit at a
 * particular index in a string to its 4-bit (nibble-sized) numeric value.
 * Handles '0'-'9' (0x30-0x39) and 'a'-'f' (0x61-0x66).
 */
function nibbleValueAt(hex: string, at: number): number {
  const c = hex.charCodeAt(at);

  // '0'-'9' = 0x30-0x39, 'a'-'f' = 0x61-0x66
  return c < 0x3a ? c - 0x30 : c - 0x57;
}

/**
 * Helper for `bigintToMinimalTwosComplement()`, which converts a pair of hex
 * digits at a particular index in a string to its 8-bit (byte-sized) numeric
 * value. Handles '0'-'9' (0x30-0x39) and 'a'-'f' (0x61-0x66).
 */
function byteValueAt(hex: string, at: number): number {
  return (nibbleValueAt(hex, at) << 4) | nibbleValueAt(hex, at + 1);
}

/**
 * Helper for `bigintToMinimalTwosComplement()`, which converts a positive
 * `bigint` to a hex string with an even number of digits, _and_ a leading
 * `00` if it would otherwise be interpreted as a negative number in
 * twos-complement.
 */
function hexStringFromPositiveValue(value: bigint): string {
  const hex = value.toString(16);
  if ((hex.length & 1) === 1) {
    // Round up to an even number of nibbles.
    return "0" + hex;
  } else if (nibbleValueAt(hex, 0) >= 8) {
    // Add an extra `0x00` byte, because the high-order bit would otherwise
    // be `1` and therefore the encoded result would be negative, which
    // would be wrong.
    return "00" + hex;
  } else {
    return hex;
  }
}

/**
 * Helper for `bigintToMinimalTwosComplement()`, which converts a non-zero and
 * non-`-1` value that fits into 64 bits.
 */
function convertSmallValue(value: bigint, negative: boolean) {
  const skipByte = negative ? 0xff : 0x00;
  const signBit = skipByte & 0x80;

  dv64View.setBigInt64(0, value, false); // `false` means big-endian.

  // Note: Loop necessarily ends before running off the end of the array
  // because by virtue of the caller's up-front check, there's definitely a
  // non-skipped byte).
  for (let i = 0; true; i++) {
    const byte = dv64Bytes[i];
    if (byte !== skipByte) {
      // Adjust starting index backwards if the non-skipped byte would flip
      // the sign of the result.
      return ((byte & 0x80) === signBit)
        ? dv64Bytes.slice(i)
        : dv64Bytes.slice(i - 1);
    }
  }
}

/**
 * Shared 8-byte scratch buffer for the `DataView` fast path. A single
 * `setBigUint64()` call writes all 8 bytes at once, avoiding hex string
 * processing for values that fit in 64 bits. Same shared-buffer pattern as
 * `f64Buf`/`f64View`/`f64Bytes` in `value-hash.ts`.
 */
const dv64Buf = new ArrayBuffer(8);
const dv64View = new DataView(dv64Buf);
const dv64Bytes = new Uint8Array(dv64Buf);

/**
 * Cached result of `0n` as a `Uint8Array`.
 */
const ZERO_BYTES = new Uint8Array([0x00]);

/**
 * Cached result of `-1n` as a `Uint8Array`.
 */
const NEGATIVE_ONE_BYTES = new Uint8Array([0xFF]);

/**
 * Converts a bigint to its minimal two's-complement big-endian byte
 * representation. The encoding is the same one used by the hash
 * byte-level spec (Section 3.7).
 *
 * Edge cases:
 * - `0n` -> `[0x00]` (single zero byte)
 * - Positive values get a leading `0x00` byte when the high bit would
 *   otherwise be set (sign extension for positive).
 * - Negative values use two's complement with a leading `0xFF` byte added
 *   when the high bit would otherwise be clear (sign extension for negative).
 */
export function bigintToMinimalTwosComplement(value: bigint): Uint8Array {
  if (value >= 0n) {
    if (value === 0n) {
      return ZERO_BYTES.slice();
    } else if (value <= 0x7fff_ffff_ffff_ffffn) {
      return convertSmallValue(value, false);
    }

    // Slow path for positive numbers: This stringifies and then parses back the
    // `value`, to work around JS's very limited set of `bigint` functionality.
    // If and when the TC39 BigInt Math proposal lands, this code could be
    // reworked to be much more performant. See:
    // <https://github.com/tc39/proposal-bigint-math>.

    const hex = hexStringFromPositiveValue(value);
    const bytes = new Uint8Array(hex.length >> 1);

    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = byteValueAt(hex, i * 2);
    }

    return bytes;
  } else {
    if (value === -1n) {
      return NEGATIVE_ONE_BYTES.slice();
    } else if (value >= -0x8000_0000_0000_0000n) {
      return convertSmallValue(value, true);
    }

    // Slow path for negative numbers. See above for details. The extra twist
    // here is that we need to end up with a string that correctly represents
    // `value` as a twos-complement negative value. The trick we do here is
    // convert the _ones_-complement of `value` to a string, and then undo it
    // byte-by-byte when storing the result.

    const hex = hexStringFromPositiveValue(~value);
    const bytes = new Uint8Array(hex.length >> 1);

    for (let i = 0; i < bytes.length; i++) {
      // `0xff ^ value` to undo the ones-complement in `~value` above.
      bytes[i] = 0xff ^ byteValueAt(hex, i * 2);
    }

    return bytes;
  }
}

// ---------------------------------------------------------------------------
// Two's-complement big-endian bytes -> `bigint`
// ---------------------------------------------------------------------------

/**
 * Interprets a byte array as a two's-complement big-endian integer and returns
 * the corresponding bigint. Empty input throws.
 */
export function bigintFromMinimalTwosComplement(bytes: Uint8Array): bigint {
  if (bytes.length === 0) {
    throw new Error("bigintFromMinimalTwosComplement: empty input");
  }

  // Determine sign from the high bit of the first byte.
  const negative = (bytes[0]! & 0x80) !== 0;

  if (bytes.length <= 8) {
    // Fast path for `bytes.length <= 8`.
    dv64Bytes.fill(negative ? 0xff : 0);
    dv64Bytes.set(bytes, 8 - bytes.length);
    return dv64View.getBigInt64(0, false); // `false` means big-endian.
  }

  // Slow path. For negative numbers, this uses a similar ones-complement trick
  // as is done in the encoder function, above.

  const byteMask = negative ? 0xff : 0x00;
  const bigMask = negative ? 0xffff_ffff_ffff_ffffn : 0n;
  const partials = bytes.length & 7;

  let result = 0n;

  for (let i = 0; i < partials; i++) {
    result = (result << 8n) | BigInt(byteMask ^ bytes[i]!);
  }

  for (let i = partials; i < bytes.length; i += 8) {
    dv64Bytes.set(bytes.subarray(i, i + 8));
    result = (result << 64n) |
      (bigMask ^ dv64View.getBigUint64(0, false)); // `false` means big-endian.
  }

  return negative ? ~result : result;
}
