/**
 * Shared BigInt two's-complement big-endian encoding, and base64 helpers for
 * the JSON wire format. Used by both `canonical-hash.ts` (byte-level hashing)
 * and `type-handlers.ts` (JSON serialization).
 *
 * The two's-complement encoding is minimal: no unnecessary leading 0x00 bytes
 * for positive values, no unnecessary leading 0xFF bytes for negative values,
 * except as needed for sign extension.
 */

// ---------------------------------------------------------------------------
// BigInt -> minimal two's-complement big-endian bytes
// ---------------------------------------------------------------------------

/**
 * Convert a hex digit char code to its 4-bit numeric value. Handles '0'-'9'
 * (0x30-0x39) and 'a'-'f' (0x61-0x66). Used instead of `parseInt` for ~2x
 * faster hex-to-byte conversion (see bigint-hashing-performance.md).
 */
function hexToNibble(c: number): number {
  // '0'-'9' = 0x30-0x39, 'a'-'f' = 0x61-0x66
  return c < 0x3a ? c - 0x30 : c - 0x57;
}

/**
 * Shared 8-byte scratch buffer for the DataView fast path. A single
 * `setBigUint64()` call writes all 8 bytes at once, avoiding hex string
 * processing for values that fit in 64 bits. Same shared-buffer pattern as
 * `f64Buf`/`f64View`/`f64Bytes` in `canonical-hash.ts`.
 */
const dv64Buf = new ArrayBuffer(8);
const dv64View = new DataView(dv64Buf);
const dv64Bytes = new Uint8Array(dv64Buf);

/**
 * Convert a bigint to its minimal two's-complement big-endian byte
 * representation. The encoding is the same one used by the canonical hash
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
  if (value === 0n) {
    return new Uint8Array([0]);
  }

  const negative = value < 0n;

  if (!negative) {
    // We use toString(16).length to determine byte count because V8 has no
    // BigInt bit-length API. The TC39 BigInt Math proposal (Stage 1) includes
    // BigInt.bitLength() which would eliminate this string round-trip.
    // See: https://github.com/tc39/proposal-bigint-math
    const hex = value.toString(16);
    // Determine minimal byte length from hex digit count.
    let byteLen = (hex.length + 1) >> 1; // ceil(hex.length / 2)
    // If high nibble has bit 7 set, need a sign-extension zero byte.
    if (hexToNibble(hex.charCodeAt(0)) >= 8) byteLen++;

    // Fast path: use DataView.setBigUint64() for values that fit in 8 bytes.
    if (byteLen <= 8) {
      dv64View.setBigUint64(0, value, false); // big-endian
      return dv64Bytes.slice(8 - byteLen);
    }

    // Fallback: hex+nibble for larger values.
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
  }

  // For negative numbers, compute two's complement.
  const abs = -value;
  const absHex = abs.toString(16);
  // Number of bits for the magnitude.
  const bitLen = absHex.length * 4;
  // We need enough bytes to represent the value, rounded up.
  let byteLen = Math.ceil(bitLen / 8);
  // Two's complement of -abs is 2^n - abs where n is the byte-aligned size.
  let twos = (1n << BigInt(byteLen * 8)) - abs;
  // Verify the high bit is set (value must look negative).
  const twosHex = twos.toString(16);
  if (hexToNibble(twosHex.charCodeAt(0)) < 8) {
    // High bit not set -- need one more byte.
    byteLen++;
    twos = (1n << BigInt(byteLen * 8)) - abs;
  }

  // Fast path: use DataView.setBigUint64() for values that fit in 8 bytes.
  if (byteLen <= 8) {
    dv64View.setBigUint64(0, twos, false); // big-endian
    return dv64Bytes.slice(8 - byteLen);
  }

  // Fallback: hex+nibble for larger values.
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

// ---------------------------------------------------------------------------
// Two's-complement big-endian bytes -> BigInt
// ---------------------------------------------------------------------------

/**
 * Interpret a byte array as a two's-complement big-endian integer and return
 * the corresponding bigint. Empty input throws.
 */
export function bigintFromMinimalTwosComplement(bytes: Uint8Array): bigint {
  if (bytes.length === 0) {
    throw new Error("bigintFromMinimalTwosComplement: empty input");
  }

  // Determine sign from the high bit of the first byte.
  const negative = (bytes[0] & 0x80) !== 0;

  // Build the unsigned magnitude from the bytes.
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

// ---------------------------------------------------------------------------
// Unpadded base64 encoding/decoding
// ---------------------------------------------------------------------------

/** Standard base64 alphabet. */
const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Encode a `Uint8Array` to an unpadded base64 string (no trailing `=`).
 */
export function toUnpaddedBase64(bytes: Uint8Array): string {
  let result = "";
  const len = bytes.length;
  let i = 0;

  // Process 3 bytes at a time -> 4 base64 chars.
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += B64_CHARS[(n >> 18) & 0x3f];
    result += B64_CHARS[(n >> 12) & 0x3f];
    result += B64_CHARS[(n >> 6) & 0x3f];
    result += B64_CHARS[n & 0x3f];
  }

  // Handle remaining 1 or 2 bytes (no padding appended).
  if (i < len) {
    const n1 = bytes[i];
    result += B64_CHARS[(n1 >> 2) & 0x3f];
    if (i + 1 < len) {
      // 2 remaining bytes -> 3 base64 chars.
      const n2 = bytes[i + 1];
      result += B64_CHARS[((n1 & 0x03) << 4) | ((n2 >> 4) & 0x0f)];
      result += B64_CHARS[(n2 & 0x0f) << 2];
    } else {
      // 1 remaining byte -> 2 base64 chars.
      result += B64_CHARS[(n1 & 0x03) << 4];
    }
  }

  return result;
}

/** Reverse lookup: base64 char -> 6-bit value. 0xFF = invalid. */
const B64_DECODE = new Uint8Array(128).fill(0xff);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_DECODE[B64_CHARS.charCodeAt(i)] = i;
}

/**
 * Decode a base64 string to `Uint8Array`. Accepts both padded and unpadded
 * input (trailing `=` characters are stripped before decoding).
 */
export function fromBase64(encoded: string): Uint8Array {
  // Strip trailing padding.
  let s = encoded;
  while (s.endsWith("=")) s = s.slice(0, -1);

  // Compute output byte count from the number of base64 characters.
  const outLen = (s.length * 3) >>> 2;
  const result = new Uint8Array(outLen);

  let bitBuf = 0;
  let bitCount = 0;
  let outIdx = 0;

  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 128 || B64_DECODE[code] === 0xff) {
      throw new Error(`fromBase64: invalid character at index ${i}`);
    }
    bitBuf = (bitBuf << 6) | B64_DECODE[code];
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      result[outIdx++] = (bitBuf >>> bitCount) & 0xff;
    }
  }

  return result;
}
