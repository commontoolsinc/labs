// Shared crypto helpers for storage backend

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const out = new Uint8Array(digest);
  const hex: string[] = new Array(out.length);
  for (let i = 0; i < out.length; i++) {
    hex[i] = out[i]!.toString(16).padStart(2, "0");
  }
  return hex.join("");
}
