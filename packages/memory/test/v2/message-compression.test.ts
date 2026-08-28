/** Tests the negotiated memory WebSocket compression envelope. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES,
  MEMORY_COMPRESSION_ENVELOPE_PREFIX,
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

    expect(encoded.startsWith(MEMORY_COMPRESSION_ENVELOPE_PREFIX)).toBe(true);
    expect(encoded.length).toBeLessThan(
      new TextEncoder().encode(payload).length,
    );
    expect(await decodeCompressedMemoryMessage(encoded)).toBe(payload);
  });

  it("rejects an envelope whose declared expansion is too small", async () => {
    const payload = "repeated memory message ".repeat(1_000);
    const encoded = await encodeCompressedMemoryMessage(payload);
    const envelope = JSON.parse(
      encoded.slice(MEMORY_COMPRESSION_ENVELOPE_PREFIX.length),
    );
    envelope.uncompressedBytes--;

    await expect(
      decodeCompressedMemoryMessage(
        MEMORY_COMPRESSION_ENVELOPE_PREFIX + JSON.stringify(envelope),
      ),
    ).rejects.toThrow("expands beyond its limit");
  });

  it("rejects an envelope declaring an expansion beyond the maximum", async () => {
    const encoded = MEMORY_COMPRESSION_ENVELOPE_PREFIX + JSON.stringify({
      encoding: "gzip",
      uncompressedBytes: MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES + 1,
      payload: "",
    });

    await expect(decodeCompressedMemoryMessage(encoded)).rejects.toThrow(
      "Invalid memory compression envelope",
    );
  });
});
