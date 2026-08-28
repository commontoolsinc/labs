/** Tests compression negotiation on the standalone memory WebSocket host. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "../../v2.ts";
import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  type MemoryMessageFrame,
} from "../../v2/message-compression.ts";
import { StandaloneMemoryServer } from "../../v2/standalone.ts";

describe("standalone memory compression", () => {
  it("exchanges compressed messages after an ordinary hello", async () => {
    const server = StandaloneMemoryServer.start();
    const address = new URL(server.url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
    socket.binaryType = "arraybuffer";
    try {
      await opened(socket);

      const helloReply = nextMessage(socket);
      socket.send(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      }));
      const helloFrame = await helloReply;
      expect(typeof helloFrame).toBe("string");
      if (typeof helloFrame !== "string") {
        throw new Error("Expected text hello reply");
      }
      expect(decodeMemoryBoundary<{ type: string }>(helloFrame).type).toBe(
        "hello.ok",
      );

      const requestId = "standalone-compressed-session-open-".repeat(100);
      const response = nextMessage(socket);
      socket.send(
        await encodeCompressedMemoryMessage(encodeMemoryBoundary({
          type: "session.open",
          requestId,
          space: "did:key:z6Mk-standalone-compression-test",
          session: {},
        })),
      );
      const responseFrame = await response;
      expect(responseFrame).toBeInstanceOf(ArrayBuffer);
      expect(
        decodeMemoryBoundary<{ requestId: string }>(
          await decodeCompressedMemoryMessage(responseFrame),
        ).requestId,
      ).toBe(requestId);
    } finally {
      if (socket.readyState < WebSocket.CLOSING) {
        const closed = new Promise<void>((resolve) => {
          socket.addEventListener("close", () => resolve(), { once: true });
        });
        socket.close();
        await closed;
      }
      await server.close();
    }
  });
});

/** Resolves when `socket` opens and rejects if opening fails. */
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Standalone memory WebSocket failed to open")),
      { once: true },
    );
  });
}

/** Returns the next supported message from `socket`. */
function nextMessage(socket: WebSocket): Promise<MemoryMessageFrame> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      if (
        typeof event.data === "string" || event.data instanceof ArrayBuffer ||
        event.data instanceof Uint8Array || event.data instanceof Blob
      ) {
        resolve(event.data);
      } else {
        reject(new Error("Standalone memory WebSocket sent an invalid frame"));
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("Standalone memory WebSocket failed"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Standalone memory WebSocket closed before replying"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}
