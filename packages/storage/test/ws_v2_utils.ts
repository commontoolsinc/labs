// Expose toBytes logic for unit testing.
export function toBytesForTest(v: unknown): Uint8Array {
  const decodeB64 = (s: string): Uint8Array => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return decodeB64(v);
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  try {
    const arr = Array.from(v as any);
    return new Uint8Array(arr as number[]);
  } catch {
    return new Uint8Array();
  }
}
