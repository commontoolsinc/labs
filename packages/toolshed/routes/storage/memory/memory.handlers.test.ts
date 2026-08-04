import { afterAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "@commonfabric/memory/v2";
import {
  attachMemorySocketPipeline,
  bufferTextMessagesUntilNegotiated,
} from "./memory.handlers.ts";
import { memoryServer } from "../memory.ts";

const HELLO = encodeMemoryBoundary({
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
});

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {}
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
      const reply = decodeMemoryBoundary<{ type: string }>(fake.sent[0]);
      expect(reply.type).toBe("hello.ok");
    });

    it("drops server messages once the socket has left OPEN", async () => {
      const fake = new FakeSocket();

      await runHelloThroughPipeline(fake, WebSocket.CLOSED);

      expect(fake.sent).toEqual([]);
    });
  });
});
