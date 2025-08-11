// Shared byte/hex helpers for storage backend

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    out[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  const hex: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    hex[i] = bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex.join("");
}
