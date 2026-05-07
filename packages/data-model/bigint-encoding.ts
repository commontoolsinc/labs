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
 * Helper for `bigintToMinimalTwosComplement()`, which converts a hex digit
 * char code to its 4-bit numeric value. Handles '0'-'9' (0x30-0x39) and
 * 'a'-'f' (0x61-0x66). Used instead of `parseInt` for ~2x faster
 * hex-to-byte conversion (see bigint-hashing-performance.md).
 */
function hexToNibble(c: number): number {
  // '0'-'9' = 0x30-0x39, 'a'-'f' = 0x61-0x66
  return c < 0x3a ? c - 0x30 : c - 0x57;
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
  if (value >= 0n) {
    if (value === 0n) {
      return ZERO_BYTES.slice();
    } else if (value <= 0x7fff_ffff_ffff_ffffn) {
      dv64View.setBigUint64(0, value, false); // big-endian

      // Note: Loop necessarily ends before running off the end of the array
      // because `value !== 0n` (that is, there's definitely a non-skipped
      // byte).
      for (let i = 0; /*i*/; i++) {
        const byte = dv64Bytes[i];
        if (byte !== 0) {
          return dv64Bytes.slice((byte <= 0x7f) ? i : i - 1);
        }
      }
    }

    // Slow path for positive numbers: Stringify and parse. We use
    // toString(16).length to determine byte count because V8 has no BigInt
    // bit-length API. The TC39 BigInt Math proposal (Stage 1) includes
    // BigInt.bitLength() which would eliminate this string round-trip. See:
    // https://github.com/tc39/proposal-bigint-math

    const hex = value.toString(16);

    // Determine minimal byte length from hex digit count.
    let byteLen = (hex.length + 1) >> 1; // ceil(hex.length / 2)

    // If the high nibble of byte 0 has bit 3 set, we need a sign-extension
    // zero byte. For odd hex length the byte's high nibble is 0 (from the
    // implicit leading-zero pad), so the check only applies for even
    // hex.length, where `hex[0]` *is* the leading byte's high nibble.
    if ((hex.length & 1) === 0 && hexToNibble(hex.charCodeAt(0)) >= 8) {
      byteLen++;
    }

    let padded = hex;
    if (padded.length % 2 !== 0) padded = "0" + padded;
    if (hexToNibble(padded.charCodeAt(0)) >= 8) padded = "00" + padded;
    const bytes = new Uint8Array(padded.length / 2);

    for (let i = 0; i < bytes.length; i++) {
      const j = i * 2;
      bytes[i] = (hexToNibble(padded.charCodeAt(j)) << 4) |
        hexToNibble(padded.charCodeAt(j + 1));
    }

    return bytes;
  } else {
    if (value === -1n) {
      return NEGATIVE_ONE_BYTES.slice();
    } else if (value >= -0x8000_0000_0000_0000n) {
      dv64View.setBigUint64(0, value, false); // big-endian

      // Note: Loop necessarily ends before running off the end of the array
      // because `value !== -1n` (that is, there's definitely a non-skipped
      // byte).
      for (let i = 0; /*i*/; i++) {
        const byte = dv64Bytes[i];
        if (byte !== 0xff) {
          return dv64Bytes.slice((byte >= 0x80) ? i : i - 1);
        }
      }
    }

    // Slow path for negative numbers. See above for details.

    // Compute two's complement.
    const abs = -value;
    const absHex = abs.toString(16);
    // Number of bits for the magnitude.
    const bitLen = absHex.length * 4;
    // We need enough bytes to represent the value, rounded up.
    let byteLen = Math.ceil(bitLen / 8);
    // Two's complement of -abs is 2^n - abs where n is the byte-aligned size.
    let twos = (1n << BigInt(byteLen * 8)) - abs;
    // Verify the high bit of byte 0 of the encoded form is set (value must
    // look negative). It is *not* set if either:
    //   (a) `twosHex` is shorter than `byteLen * 2` (so byte 0 starts with a
    //       padding-zero nibble), or
    //   (b) `twosHex.length === byteLen * 2` but its leading nibble is < 8.
    // In either case we need one more byte to keep the high bit set.
    const twosHex = twos.toString(16);
    if (
      twosHex.length < byteLen * 2 || hexToNibble(twosHex.charCodeAt(0)) < 8
    ) {
      byteLen++;
      twos = (1n << BigInt(byteLen * 8)) - abs;
    }

    let hex = twos.toString(16);
    while (hex.length < byteLen * 2) hex = "0" + hex;
    const bytes = new Uint8Array(byteLen);
    for (let i = 0; i < bytes.length; i++) {
      const j = i * 2;
      bytes[i] = (hexToNibble(hex.charCodeAt(j)) << 4) |
        hexToNibble(hex.charCodeAt(j + 1));
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
