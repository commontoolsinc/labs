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
// BigInt -> minimal two's-complement big-endian bytes
// ---------------------------------------------------------------------------

/**
 * Helper for `bigintToMinimalTwosComplement()`, which converts a hex digit at a
 * particular index in a string to its 4-bit (nibble-sized) numeric value.
 * Handles '0'-'9' (0x30-0x39) and 'a'-'f' (0x61-0x66).
 *
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
 * Shared 8-byte scratch buffer for the DataView fast path. A single
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
 * Uses a hybrid strategy: values that fit in 64 bits (the common case) are
 * extracted via a single `DataView.setBigUint64()` call (~2x faster), while
 * larger values fall back to hex+nibble conversion.
 *
 * Edge cases:
 * - `0n` -> `[0x00]` (single zero byte)
 * - Positive values get a leading `0x00` byte when the high bit would
 *   otherwise be set (sign extension for positive).
 * - Negative values use two's complement with a leading `0xFF` byte added
 *   when the high bit would otherwise be clear (sign extension for negative).
 */
export function bigintToMinimalTwosComplement(value: bigint): Uint8Array {
  // Converts a value that fits into 64 bits.
  const convertSmallValue = (negative: boolean) => {
    dv64View.setBigUint64(0, value, false); // big-endian

    // Note: Loop necessarily ends before running off the end of the array
    // because by virtue of the caller's up-front check, there's definitely a
    // non-skipped byte).
    const skipByte = negative ? 0xff : 0x00;
    for (let i = 0; true; i++) {
      const byte = dv64Bytes[i];
      if (byte !== skipByte) {
        // Adjust starting index backwards if the non-skipped byte would flip
        // the sign of the result.
        if (negative) {
          if (byte <= 0x7f) i--;
        } else {
          if (byte >= 0x80) i--;
        }
        return dv64Bytes.slice(i);
      }
    }
  };

  // Converts a positive value to a hex string.
  const hexStringFromPositiveValue = (value: bigint) => {
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
  };

  if (value >= 0n) {
    if (value === 0n) {
      return ZERO_BYTES.slice();
    } else if (value <= 0x7fff_ffff_ffff_ffffn) {
      return convertSmallValue(false);
    }

    // Slow path for positive numbers: Stringify and parse. We use
    // toString(16).length to determine byte count because V8 has no BigInt
    // bit-length API. The TC39 BigInt Math proposal (Stage 1) includes
    // BigInt.bitLength() which would eliminate this string round-trip. See:
    // https://github.com/tc39/proposal-bigint-math

    const hex = hexStringFromPositiveValue(value);
    const byteLen = hex.length >> 1;
    const bytes = new Uint8Array(byteLen);

    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = byteValueAt(hex, i * 2);
    }

    return bytes;
  } else {
    if (value === -1n) {
      return NEGATIVE_ONE_BYTES.slice();
    } else if (value >= -0x8000_0000_0000_0000n) {
      return convertSmallValue(true);
    }

    // Slow path for negative numbers. See above for details. The extra twist
    // here is that we need to end up with a string that correctly represents
    // `value` as a twos-complement negative value. The trick we do here is
    // convert the _ones_-complement of `value` to a string, and then undo it
    // byte-by-byte when storing the result.

    const hex = hexStringFromPositiveValue(~value);
    const byteLen = hex.length >> 1;
    const bytes = new Uint8Array(byteLen);

    for (let i = 0; i < bytes.length; i++) {
      // `0xff - value` to undo the ones-complement in `~value` above.
      bytes[i] = 0xff - byteValueAt(hex, i * 2);
    }

    return bytes;
  }
}

// ---------------------------------------------------------------------------
// Two's-complement big-endian bytes -> BigInt
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
  const negative = (bytes[0] & 0x80) !== 0;

  // Fast path: use DataView.getBigUint64() for values that fit in 8 bytes.
  if (bytes.length <= 8) {
    dv64Bytes.fill(0);
    dv64Bytes.set(bytes, 8 - bytes.length);
    const raw = dv64View.getBigUint64(0, false); // big-endian
    if (!negative) return raw;
    return raw - (1n << BigInt(bytes.length * 8));
  }

  // Fallback: per-byte shift loop for larger values.
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }

  if (!negative) {
    return result;
  }

  // Two's complement: subtract 2^(byteLen*8) to get the negative value.
  return result - (1n << BigInt(bytes.length * 8));
}
