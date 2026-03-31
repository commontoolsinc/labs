/**
 * Base64url helper functions.
 */

/**
 * Encodes a `Uint8Array` to an unpadded base64url string (no trailing `=`).
 * Uses the base64url alphabet (RFC 4648 section 5).
 */
export function toUnpaddedBase64url(bytes: Uint8Array): string {
  return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

/**
 * Decodes a base64url string to `Uint8Array`. This accepts both unpadded and
 * padded (trailing `=` characters) in the `encoded` input. Uses the base64url
 * alphabet (RFC 4648 section 5).
 */
export function fromBase64url(encoded: string): Uint8Array {
  return Uint8Array.fromBase64(encoded, { alphabet: "base64url" });
}
