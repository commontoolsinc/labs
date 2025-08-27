import {
  decodeBase64 as stdDecodeB64,
  encodeBase64 as stdEncodeB64,
} from "@std/encoding/base64";

export function encodeBase64(bytes: Uint8Array): string {
  return stdEncodeB64(bytes);
}

export function decodeBase64(s: string): Uint8Array {
  return stdDecodeB64(s);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  const b64 = stdEncodeB64(bytes);
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(s: string): Uint8Array {
  // Pad to multiple of 4 and revert URL-safe alphabet
  let b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  return stdDecodeB64(b64);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
