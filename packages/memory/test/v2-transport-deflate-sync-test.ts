import { describe, it } from "@std/testing/bdd";
import { assertEquals, assertThrows } from "@std/assert";
import {
  deflateWirePayload,
  inflateWirePayload,
} from "../v2/transport-deflate.ts";
import { isAuthBearingWireMessage } from "../v2.ts";
import {
  deflateWirePayloadSync,
  inflateWirePayloadSync,
} from "../v2/transport-deflate-sync.ts";

const PAYLOAD = "fvj1:" + JSON.stringify({
  upserts: Array.from({ length: 64 }, (_, index) => ({
    id: `of:entity-${index}`,
    doc: { value: { text: "x".repeat(120), index } },
  })),
});

describe("memory ws sync codec", () => {
  it("roundtrips synchronously", () => {
    assertEquals(
      inflateWirePayloadSync(deflateWirePayloadSync(PAYLOAD)),
      PAYLOAD,
    );
  });

  it("interoperates with the async codec in both directions", async () => {
    // Server compresses sync, client inflates async — and vice versa. Both
    // speak identical raw-deflate bytes.
    assertEquals(
      await inflateWirePayload(deflateWirePayloadSync(PAYLOAD)),
      PAYLOAD,
    );
    assertEquals(
      inflateWirePayloadSync(await deflateWirePayload(PAYLOAD)),
      PAYLOAD,
    );
  });

  it("accepts typed-array views and pre-encoded bytes", () => {
    const compressed = deflateWirePayloadSync(
      new TextEncoder().encode(PAYLOAD),
    );
    const padded = new Uint8Array(compressed.byteLength + 8);
    padded.set(compressed, 4);
    const view = new Uint8Array(padded.buffer, 4, compressed.byteLength);
    assertEquals(inflateWirePayloadSync(view), PAYLOAD);
  });

  it("enforces the inflate cap", () => {
    const bomb = deflateWirePayloadSync("z".repeat(1024 * 1024));
    assertThrows(() => inflateWirePayloadSync(bomb, 64 * 1024));
  });

  it("rejects malformed deflate data", () => {
    assertThrows(() =>
      inflateWirePayloadSync(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    );
  });
});

describe("auth-bearing wire message detection", () => {
  it("classifies handshake and credential frames", () => {
    assertEquals(isAuthBearingWireMessage({ type: "hello" } as never), true);
    assertEquals(isAuthBearingWireMessage({ type: "hello.ok" } as never), true);
    assertEquals(
      isAuthBearingWireMessage({ type: "session.open" } as never),
      true,
    );
    assertEquals(
      isAuthBearingWireMessage({
        type: "response",
        requestId: "open-1",
        ok: { sessionId: "s", sessionToken: "secret", serverSeq: 0 },
      }),
      true,
    );
    assertEquals(
      isAuthBearingWireMessage({
        type: "response",
        requestId: "open-1",
        ok: { sessionId: "s", sessionOpen: { audience: "did:key:z" } },
      }),
      true,
    );
  });

  it("leaves ordinary traffic compressible", () => {
    assertEquals(
      isAuthBearingWireMessage({
        type: "response",
        requestId: "tx-1",
        ok: { seq: 4 },
      }),
      false,
    );
    assertEquals(
      isAuthBearingWireMessage({ type: "session/effect" } as never),
      false,
    );
    // Values outside the message unions fail CLOSED (never compressed):
    // the classifier's default arm is unreachable for typed callers, and
    // never-compressing is always safe for untyped embedders.
    assertEquals(isAuthBearingWireMessage("fvj1:{}" as never), true);
    assertEquals(isAuthBearingWireMessage(null as never), true);
  });
});
