import { crypto } from "jsr:@std/crypto";
import { encodeHex } from "jsr:@std/encoding/hex";

export async function sha256(content: string) {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return encodeHex(hashBuffer);
}

export async function sha256File(path: string) {
  const content = await Deno.readTextFile(path);
  return sha256(content);
}
