/** Encodes and decodes the segments of RFC 6901 pointers. */

/**
 * Encodes a JSON Pointer path according to RFC 6901.
 * Each token has ~ replaced with ~0 and / replaced with ~1, then joined with /.
 * @param path - Array of path tokens to encode
 * @returns The encoded JSON Pointer string
 */
export function encodeJsonPointer(path: readonly string[]): string {
  return path
    .map((token) => token.replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/");
}

/**
 * Decodes a JSON Pointer string according to RFC 6901.
 * Splits by / then replaces ~1 with / and ~0 with ~ in each token.
 * @param pointer - The JSON Pointer string to decode
 * @returns Array of decoded path tokens
 */
export function decodeJsonPointer(pointer: string): string[] {
  return pointer
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}
