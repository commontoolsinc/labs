import { decodeBase64 } from "../src/codec/bytes.ts";

// Expose toBytes logic for unit testing.
export function toBytesForTest(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return decodeBase64(v);
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  try {
    const arr = Array.from(v as any);
    return new Uint8Array(arr as number[]);
  } catch {
    return new Uint8Array();
  }
}
