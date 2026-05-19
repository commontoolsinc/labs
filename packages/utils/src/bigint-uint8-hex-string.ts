/**
 * Implementation of `bigint.ts` which uses the hex conversion methods of
 * `Uint8Array`. These only became part of the EcmaScript standard in 2025 and
 * so (as of this writing) cannot be relied on to exist in arbitrary JS
 * environments.
 */

/**
 * Shared 8-byte scratch buffer.
 */
const dv64Buf = new ArrayBuffer(8);

/**
 * `DataView` of `dv64buf`.
 */
const dv64View = new DataView(dv64Buf);

/**
 * `Uint8Array` view of `dv64buf`.
 */
const dv64Bytes = new Uint8Array(dv64Buf);

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
 * Helper for `bigintToMinimalTwosComplement()`, which converts a value that
 * fits into 64 bits and requires `length >= 5`.
 */
function encode5To8Bytes(value: bigint, negative: boolean): Uint8Array {
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
 * Version of `bigintToMinimalTwosComplement()` which uses the `Uint8Array`
 * hex-string methods.
 */
export function bigintToMtcHex(value: bigint): Uint8Array {
  if (value >= 0n) {
    if (value <= 0x7fff_ffffn) {
      const num = Number(value);
      if (num <= 0x7fff) {
        if (num <= 0x7f) {
          const result = new Uint8Array(1);
          result[0] = num;
          return result;
        } else {
          const result = new Uint8Array(2);
          result[0] = num >> 8;
          result[1] = num;
          return result;
        }
      } else {
        if (num <= 0x7f_ffff) {
          const result = new Uint8Array(3);
          result[0] = num >> 16;
          result[1] = num >> 8;
          result[2] = num;
          return result;
        } else {
          const result = new Uint8Array(4);
          result[0] = num >> 24;
          result[1] = num >> 16;
          result[2] = num >> 8;
          result[3] = num;
          return result;
        }
      }
    } else if (value <= 0x7fff_ffff_ffff_ffffn) {
      return encode5To8Bytes(value, false);
    }

    // Slow path for positive numbers: This stringifies and then parses back the
    // `value`, to work around JS's very limited set of `bigint` functionality.
    // If and when the TC39 BigInt Math proposal lands, this code could be
    // reworked to be much more performant. See:
    // <https://github.com/tc39/proposal-bigint-math>.

    const hex = hexStringFromPositiveValue(value);

    // Note: When it is widely-enough available, we will be able to say `return
    // Uint8Array.fromHex(hex)` here and probably see a major performance
    // improvement.

    const bytes = new Uint8Array(hex.length >> 1);

    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = byteValueAt(hex, i * 2);
    }

    return bytes;
  } else {
    if (value >= -0x8000_0000n) {
      const num = Number(value);
      if (num >= -0x8000) {
        if (num >= -0x80) {
          const result = new Uint8Array(1);
          result[0] = num;
          return result;
        } else {
          const result = new Uint8Array(2);
          result[0] = num >> 8;
          result[1] = num;
          return result;
        }
      } else {
        if (num >= -0x80_0000) {
          const result = new Uint8Array(3);
          result[0] = num >> 16;
          result[1] = num >> 8;
          result[2] = num;
          return result;
        } else {
          const result = new Uint8Array(4);
          result[0] = num >> 24;
          result[1] = num >> 16;
          result[2] = num >> 8;
          result[3] = num;
          return result;
        }
      }
    } else if (value >= -0x8000_0000_0000_0000n) {
      return encode5To8Bytes(value, true);
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

/**
 * Version of `bigintFromMinimalTwosComplement()` which uses the `Uint8Array`
 * hex-string methods.
 */
export function bigintFromMtcHex(bytes: Uint8Array): bigint {
  if (bytes.length === 0) {
    throw new Error("bigintFromMinimalTwosComplement: empty input");
  }

  const hexString = bytes.toHex();
  const positiveResult = BigInt(`0x${hexString}`);

  if (bytes[0] <= 0x7f) {
    return positiveResult;
  } else {
    // Negative number. We need to make the positive result of conversion
    // negative.
    const signBit = -1n << (BigInt(bytes.length) * 8n);
    return positiveResult | signBit;
  }
}
