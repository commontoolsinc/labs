import { expect } from "@std/expect";
import { afterAll, describe, it } from "@std/testing/bdd";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "@commonfabric/memory/v2";
import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  type EncodedMemoryMessage,
} from "@commonfabric/memory/v2/message-compression";

import {
  attachMemorySocketPipeline,
  bufferTextMessagesUntilNegotiated,
  warnOnOversizedOutboundFrame,
} from "./memory.handlers.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

const HELLO = encodeMemoryBoundary({
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
});

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  binaryType: BinaryType = "blob";
  readonly sent: EncodedMemoryMessage[] = [];
  closedWith: { code?: number; reason?: string } | undefined;
  #sentWaiters: Array<{ count: number; resolve: () => void }> = [];

  send(payload: EncodedMemoryMessage): void {
    this.sent.push(payload);
    this.#sentWaiters = this.#sentWaiters.filter((waiter) => {
      if (this.sent.length >= waiter.count) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  /** Resolves once the socket has sent `count` messages. */
  whenSent(count: number): Promise<void> {
    if (this.sent.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#sentWaiters.push({ count, resolve });
    });
  }
}

// Runs the pipeline the way `subscribe` does: deliver the first message
// through the socket while it is OPEN, set the readyState the send callback
// will observe, attach, and resolve once the pipeline hands the negotiated
// socket off. The hello reply is sent while the pipeline awaits
// `connection.receive(firstMessage)`, so it has been attempted by the time
// the handoff happens. Closing the socket afterwards releases the pipeline's
// memory-server connection.
const runHelloThroughPipeline = async (
  fake: FakeSocket,
  readyStateAtReply: number,
): Promise<void> => {
  const socket = fake as unknown as WebSocket;
  const negotiation = bufferTextMessagesUntilNegotiated(socket);
  const handedOff = Promise.withResolvers<void>();
  const handoff = negotiation.handoff;
  negotiation.handoff = (handlers) => {
    handoff(handlers);
    handedOff.resolve();
  };

  fake.dispatchEvent(new MessageEvent("message", { data: HELLO }));
  const firstMessage = await negotiation.firstMessage;
  expect(firstMessage).toBe(HELLO);

  fake.readyState = readyStateAtReply;
  expect(attachMemorySocketPipeline(socket, negotiation, firstMessage!)).toBe(
    true,
  );
  await handedOff.promise;
  fake.dispatchEvent(new CloseEvent("close"));
};

describe("memory.handlers", () => {
  // The toolshed `memoryServer` is a module-level singleton constructed when
  // memory.ts is imported. Deno isolates each test file's module graph, so
  // this instance is owned by this file alone. Closing it releases its
  // resources.
  afterAll(async () => {
    await memoryServer.close();
  });

  describe("attachMemorySocketPipeline", () => {
    it("sends the hello reply while the socket is OPEN", async () => {
      const fake = new FakeSocket();

      await runHelloThroughPipeline(fake, WebSocket.OPEN);

      expect(fake.sent.length).toBe(1);
      const frame = fake.sent[0];
      expect(typeof frame).toBe("string");
      if (typeof frame !== "string") throw new Error("Expected text hello");
      const reply = decodeMemoryBoundary<{ type: string }>(frame);
      expect(reply.type).toBe("hello.ok");
    });

    it("drops server messages once the socket has left OPEN", async () => {
      const fake = new FakeSocket();

      await runHelloThroughPipeline(fake, WebSocket.CLOSED);

      expect(fake.sent).toEqual([]);
    });

    it("exchanges compressed messages after the uncompressed hello", async () => {
      const fake = new FakeSocket();
      const socket = fake as unknown as WebSocket;
      const negotiation = bufferTextMessagesUntilNegotiated(socket);
      const handedOff = Promise.withResolvers<void>();
      const handoff = negotiation.handoff;
      negotiation.handoff = (handlers) => {
        handoff(handlers);
        handedOff.resolve();
      };

      fake.dispatchEvent(new MessageEvent("message", { data: HELLO }));
      const firstMessage = await negotiation.firstMessage;
      const requestId = "compressed-session-open-".repeat(100);
      const request = encodeMemoryBoundary({
        type: "session.open",
        requestId,
        space: "did:key:z6Mk-compression-test",
        session: {},
      });
      fake.dispatchEvent(
        new MessageEvent("message", {
          data: await encodeCompressedMemoryMessage(request),
        }),
      );
      expect(attachMemorySocketPipeline(
        socket,
        negotiation,
        firstMessage!,
      )).toBe(true);
      await handedOff.promise;
      expect(typeof fake.sent[0]).toBe("string");
      await fake.whenSent(2);

      expect(fake.sent[1]).toBeInstanceOf(Uint8Array);
      const response = decodeMemoryBoundary<{ requestId: string }>(
        await decodeCompressedMemoryMessage(fake.sent[1]),
      );
      expect(response.requestId).toBe(requestId);
      fake.dispatchEvent(new CloseEvent("close"));
    });

    it("closes with 1003 for binary data without negotiated compression", async () => {
      const fake = new FakeSocket();
      const socket = fake as unknown as WebSocket;
      const negotiation = bufferTextMessagesUntilNegotiated(socket);
      const handedOff = Promise.withResolvers<void>();
      const handoff = negotiation.handoff;
      negotiation.handoff = (handlers) => {
        handoff(handlers);
        handedOff.resolve();
      };
      fake.dispatchEvent(
        new MessageEvent("message", {
          data: encodeMemoryBoundary({
            type: "hello",
            protocol: MEMORY_PROTOCOL,
            flags: {
              ...getMemoryProtocolFlags(),
              messageCompressionV1: false,
            },
          }),
        }),
      );
      const firstMessage = await negotiation.firstMessage;
      expect(attachMemorySocketPipeline(
        socket,
        negotiation,
        firstMessage!,
      )).toBe(true);
      await handedOff.promise;

      fake.dispatchEvent(
        new MessageEvent("message", {
          data: await encodeCompressedMemoryMessage(
            "binary request ".repeat(200),
          ),
        }),
      );

      expect(fake.closedWith?.code).toBe(1003);
    });
  });

  describe("warnOnOversizedOutboundFrame", () => {
    const captureWarn = () => {
      const calls: { key: string; args: unknown[] }[] = [];
      const warn = (key: string, lazyArgs: () => unknown[]) => {
        calls.push({ key, args: lazyArgs() });
      };
      return { calls, warn };
    };

    it("stays silent for a frame at or under the byte threshold", () => {
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame("a".repeat(30), {}, 30, warn);

      expect(calls).toEqual([]);
    });

    it("measures a binary frame by its compressed wire bytes", () => {
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame(new Uint8Array(30), {}, 30, warn);
      expect(calls).toEqual([]);

      warnOnOversizedOutboundFrame(new Uint8Array(31), {}, 30, warn);
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toContain(31);
    });

    it("warns past the threshold with the byte size, type, and space", () => {
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame(
        "a".repeat(31),
        { type: "session/effect", space: "did:key:zExample" },
        30,
        warn,
      );

      expect(calls.length).toBe(1);
      expect(calls[0].key).toBe("oversized-outbound-frame");
      expect(calls[0].args).toContain(31);
      expect(calls[0].args).toContain("session/effect");
      expect(calls[0].args).toContain("did:key:zExample");
    });

    it("measures bytes, not code units, for non-ASCII content", () => {
      // Eight emoji are 16 code units but 32 UTF-8 bytes: under a
      // code-unit reading of the 30-byte threshold, over a byte reading.
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame("😀".repeat(8), {}, 30, warn);

      expect(calls.length).toBe(1);
      expect(calls[0].args).toContain(32);
    });

    it("names an absent type and space as unknown", () => {
      const { calls, warn } = captureWarn();

      warnOnOversizedOutboundFrame("a".repeat(31), {}, 30, warn);

      expect(calls.length).toBe(1);
      expect(calls[0].args).toContain("unknown");
    });
  });
});
