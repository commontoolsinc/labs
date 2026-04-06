/**
 * Base64url helper functions.
 */

/**
 * Do we need to use our own implementation of base64url encoding? As of
 * 2024-04, most current browser releases support it directly, but it's not
 * universal.
 */
const useBase64Polyfill = !Uint8Array.fromBase64;

/**
 * Encodes a `Uint8Array` to an unpadded base64url string (no trailing `=`).
 * Uses the base64url alphabet (RFC 4648 section 5).
 */
export function toUnpaddedBase64url(bytes: Uint8Array): string {
  return useBase64Polyfill
    ? toBase64Polyfill(bytes)
    : bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

/**
 * Decodes a base64url string to `Uint8Array`. This accepts both unpadded and
 * padded (trailing `=` characters) in the `encoded` input. Uses the base64url
 * alphabet (RFC 4648 section 5).
 */
export function fromBase64url(encoded: string): Uint8Array {
  return useBase64Polyfill
    ? fromBase64Polyfill(encoded)
    : Uint8Array.fromBase64(encoded, { alphabet: "base64url" });
}

// ---------------------------------------------------------------------------
// Polyfill
// ---------------------------------------------------------------------------

/** Base64url alphabet (RFC 4648 section 5): `+` -> `-`, `/` -> `_`. */
const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Polyfill for `toUnpaddedBase64url()`. `export`ed just for testing.
 */
export function toBase64Polyfill(bytes: Uint8Array): string {
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

/** Invalid reverse-lookup value. */
const B64_INVALID = 0xff;

/** Padding character. */
const B64_PADDING_CHAR = "=";

/** Reverse lookup: base64 char -> 6-bit value. */
const B64_DECODE = new Uint8Array(128).fill(B64_INVALID);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_DECODE[B64_CHARS.charCodeAt(i)] = i;
}

/**
 * Polyfill for `fromBase64url()`. `export`ed just for testing.
 */
export function fromBase64Polyfill(encoded: string): Uint8Array {
  const s = encoded;

  let bitBuf = 0;
  let bitCount = 0;
  let outIdx = 0;
  let inLen = s.length;

  while ((inLen > 0) && (s[inLen - 1] === B64_PADDING_CHAR)) {
    inLen--;
  }
  if ((s.length - inLen) > 2) {
    throw new Error("fromBase64url: too much padding");
  }

  // Compute output byte count from the number of base64 characters.
  const outLen = (inLen * 3) >>> 2;
  const result = new Uint8Array(outLen);

  for (let i = 0; i < inLen; i++) {
    const val = B64_DECODE[s.charCodeAt(i)];
    switch (val) {
      case undefined:
      case B64_INVALID: {
        throw new Error(`fromBase64url: invalid character at index ${i}`);
      }
      default: {
        bitBuf = (bitBuf << 6) | val;
        bitCount += 6;
        if (bitCount >= 8) {
          bitCount -= 8;
          result[outIdx++] = (bitBuf >>> bitCount) & 0xff;
        }
      }
    }
  }

  return result;
}
