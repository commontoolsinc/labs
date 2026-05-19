/**
 * Implementation of `bigint.ts` which uses the hex conversion methods of
 * `Uint8Array`. These only became part of the EcmaScript standard in 2025 and
 * so (as of this writing) cannot be relied on to exist in arbitrary JS
 * environments.
 */

/**
 * Helper for `biToMtcHex()`, which converts a hex digit at a particular index
 * in a string to its 4-bit (nibble-sized) numeric value. Handles '0'-'9'
 * (0x30-0x39) and 'a'-'f' (0x61-0x66).
 */
function nibbleValueAt(hex: string, at: number): number {
  const c = hex.charCodeAt(at);

  // '0'-'9' = 0x30-0x39, 'a'-'f' = 0x61-0x66
  return c < 0x3a ? c - 0x30 : c - 0x57;
}

/**
 * Helper for `biToMtcHex()`, which converts a positive `bigint` to a hex string
 * with an even number of digits, _and_ a leading `00` if it would otherwise be
 * interpreted as a negative number in twos-complement.
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
 * Version of `bigintToMinimalTwosComplement()` which uses the `Uint8Array`
 * hex-string methods.
 */
export function bigintToMtcHex(value: bigint): Uint8Array {
  if (value >= 0) {
    const hexString = hexStringFromPositiveValue(value);
    return Uint8Array.fromHex(hexString);
  } else {
    // Negative value. We ones-complement it before conversion to string, then
    // undo the conversion in the array result.
    const hexString = hexStringFromPositiveValue(~value);
    const result = Uint8Array.fromHex(hexString);
    for (let i = 0; i < result.length; i++) {
      result[i] = ~result[i];
    }
    return result;
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
