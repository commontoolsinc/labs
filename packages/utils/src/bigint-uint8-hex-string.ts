/**
 * Implementation of `bigint.ts` which uses the hex conversion methods of
 * `Uint8Array`. These only became part of the EcmaScript standard in 2025 and
 * so (as of this writing) cannot be relied on to exist in arbitrary JS
 * environments.
 */

import { hexStringFromPositiveValue } from "./bigint-shared-impl.ts";

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
