import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "@commonfabric/memory/v2";
import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  type MemoryMessageFrame,
} from "@commonfabric/memory/v2/message-compression";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { startFuseMemoryProxy } from "../../integration/fuse-memory-proxy.ts";

describe("fuse-memory-proxy", () => {
  it("relays binary frames and records their expanded text", async () => {
    const directory = await Deno.makeTempDir();
    const tracePath = `${directory}/memory-frames`;
    const upstream = StandaloneMemoryServer.start();
    const proxy = startFuseMemoryProxy(new URL(upstream.url), tracePath);
    const address = proxy.server.addr as Deno.NetAddr;
    const socket = new WebSocket(`ws://${address.hostname}:${address.port}`);
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

      const marker = "fuse-binary-trace-marker-".repeat(100);
      const response = nextMessage(socket);
      socket.send(
        await encodeCompressedMemoryMessage(encodeMemoryBoundary({
          type: "session.open",
          requestId: marker,
          space: "did:key:z6Mk-fuse-memory-proxy-test",
          session: {},
        })),
      );
      const responseFrame = await response;
      expect(responseFrame).toBeInstanceOf(ArrayBuffer);
      expect(
        decodeMemoryBoundary<{ requestId: string }>(
          await decodeCompressedMemoryMessage(responseFrame),
        ).requestId,
      ).toBe(marker);

      await proxy.idle();
      expect(await Deno.readTextFile(tracePath)).toContain(marker);
    } finally {
      await closeSocket(socket);
      await proxy.server.shutdown();
      await upstream.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
});

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("open failed")), {
      once: true,
    });
  });
}

function nextMessage(socket: WebSocket): Promise<MemoryMessageFrame> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      const frame = event.data;
      if (
        typeof frame === "string" || frame instanceof ArrayBuffer ||
        frame instanceof Uint8Array || frame instanceof Blob
      ) {
        resolve(frame);
      } else {
        reject(new Error("invalid memory frame"));
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("receive failed"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState >= WebSocket.CLOSING) return;
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  socket.close();
  await closed;
}
