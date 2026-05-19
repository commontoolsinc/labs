/**
 * Shared `bigint` two's-complement big-endian encoding and decoding. Used for
 * byte-level value hashing and JSON wire-format (de)serialization.
 *
 * The two's-complement encoding is minimal: no unnecessary leading 0x00 bytes
 * for positive values, no unnecessary leading 0xFF bytes for negative values,
 * except as needed for sign extension.
 */

import {
  bigintFromMtcDirect,
  bigintToMtcDirect,
} from "./bigint-uint8-direct.ts";
import { bigintFromMtcHex, bigintToMtcHex } from "./bigint-uint8-hex-string.ts";

/**
 * Whether to use the version that relies on `Uint8Array.{from,to}Hex()`,
 * methods which are new enough to JS to not be ubiquitously available.
 */
const useUint8ArrayToFromHex: boolean = false;

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
  return useUint8ArrayToFromHex
    ? bigintToMtcHex(value)
    : bigintToMtcDirect(value);
}

/**
 * Interprets a byte array as a two's-complement big-endian integer and returns
 * the corresponding bigint. Empty input throws.
 */
export function bigintFromMinimalTwosComplement(bytes: Uint8Array): bigint {
  return useUint8ArrayToFromHex
    ? bigintFromMtcHex(bytes)
    : bigintFromMtcDirect(bytes);
}
