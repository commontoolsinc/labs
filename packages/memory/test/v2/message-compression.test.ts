/** Tests the negotiated memory WebSocket compression envelope. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES,
} from "../../v2/message-compression.ts";

describe("message-compression", () => {
  it("allows messages to expand to 256 MiB", () => {
    expect(MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES).toBe(256 * 1_024 * 1_024);
  });

  it("keeps small messages in their original wire form", async () => {
    const payload = 'fvj1:{"type":"session.ack"}';

    expect(await encodeCompressedMemoryMessage(payload)).toBe(payload);
    expect(await decodeCompressedMemoryMessage(payload)).toBe(payload);
  });

  it("round-trips a compressible UTF-8 message through a smaller envelope", async () => {
    const payload = `fvj1:${
      JSON.stringify({
        type: "session/effect",
        text: "compression likes repeated text 🌲 ".repeat(1_000),
      })
    }`;

    const encoded = await encodeCompressedMemoryMessage(payload);

    expect(encoded).toBeInstanceOf(Uint8Array);
    if (!(encoded instanceof Uint8Array)) throw new Error("Expected binary");
    expect(Array.from(encoded.subarray(0, 5))).toEqual([
      0x6d,
      0x63,
      0x6d,
      0x70,
      1,
    ]);
    expect(new DataView(encoded.buffer).getUint32(5)).toBe(
      new TextEncoder().encode(payload).byteLength,
    );
    expect(Array.from(encoded.subarray(9, 11))).toEqual([0x1f, 0x8b]);
    expect(encoded.byteLength).toBeLessThan(
      new TextEncoder().encode(payload).length,
    );
    expect(await decodeCompressedMemoryMessage(encoded)).toBe(payload);
  });

  it("rejects an envelope whose declared expansion is too small", async () => {
    const payload = "repeated memory message ".repeat(1_000);
    const encoded = await encodeCompressedMemoryMessage(payload);
    expect(encoded).toBeInstanceOf(Uint8Array);
    if (!(encoded instanceof Uint8Array)) throw new Error("Expected binary");
    const envelope = encoded.slice();
    new DataView(envelope.buffer).setUint32(5, 1);

    await expect(
      decodeCompressedMemoryMessage(envelope),
    ).rejects.toThrow("expands beyond its limit");
  });

  it("rejects an envelope declaring an expansion beyond the maximum", async () => {
    const payload = "repeated memory message ".repeat(1_000);
    const encoded = await encodeCompressedMemoryMessage(payload);
    expect(encoded).toBeInstanceOf(Uint8Array);
    if (!(encoded instanceof Uint8Array)) throw new Error("Expected binary");
    const envelope = encoded.slice();
    new DataView(envelope.buffer).setUint32(
      5,
      MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES + 1,
    );

    await expect(decodeCompressedMemoryMessage(envelope)).rejects.toThrow(
      "Invalid memory compression envelope",
    );
  });
});
