/**
 * WebSocketTransport behavior on a connection that negotiated the
 * `cf-memory.deflate.v1` subprotocol — threshold framing, strict ordering across the
 * async compression hops, and unchanged behavior when not negotiated.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  deflateWirePayload,
  inflateWirePayload,
  MEMORY_WS_DEFLATE_MIN_BYTES,
  MEMORY_WS_DEFLATE_SUBPROTOCOL,
} from "@commonfabric/memory/v2/transport-deflate";
import { WebSocketTransport } from "../src/storage/v2-remote-session.ts";

class DeflatingWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: DeflatingWebSocket[] = [];
  readyState = DeflatingWebSocket.OPEN;
  binaryType = "blob";
  protocol: string;
  sent: (string | Uint8Array)[] = [];
  constructor(readonly url: string | URL, protocols?: string[]) {
    super();
    this.protocol = protocols?.[0] ?? "";
    DeflatingWebSocket.instances.push(this);
  }
  send(payload: string | Uint8Array): void {
    this.sent.push(payload);
  }
  close(): void {
    this.readyState = DeflatingWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }
}

function withTransport(
  body: (
    transport: WebSocketTransport,
    socket: () => DeflatingWebSocket,
  ) => Promise<void>,
): Promise<void> {
  const realWebSocket = globalThis.WebSocket;
  DeflatingWebSocket.instances.length = 0;
  (globalThis as { WebSocket: unknown }).WebSocket = DeflatingWebSocket;
  const transport = new WebSocketTransport(
    new URL("wss://memory.test/api/storage/memory"),
  );
  return body(transport, () => DeflatingWebSocket.instances.at(-1)!)
    .finally(() => {
      (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    });
}

const openSocket = (socket: DeflatingWebSocket) => {
  socket.readyState = DeflatingWebSocket.OPEN;
  socket.dispatchEvent(new Event("open"));
};

const SMALL = "small";
// The transport treats payloads as opaque text; this only needs to be
// compressible and above the threshold.
const LARGE = "large-payload ".repeat(MEMORY_WS_DEFLATE_MIN_BYTES / 2);

describe("WebSocketTransport deflate framing", () => {
  it("offers the deflate subprotocol when opening", async () => {
    await withTransport(async (transport, socket) => {
      const send = transport.send(SMALL);
      openSocket(socket());
      await send;
      expect(socket().protocol).toBe(MEMORY_WS_DEFLATE_SUBPROTOCOL);
      expect(socket().binaryType).toBe("arraybuffer");
    });
  });

  it("sends small payloads as text and large payloads compressed", async () => {
    await withTransport(async (transport, socket) => {
      const first = transport.send(SMALL);
      openSocket(socket());
      await first;
      await transport.send(LARGE);

      expect(socket().sent.length).toBe(2);
      expect(socket().sent[0]).toBe(SMALL);
      const compressed = socket().sent[1];
      expect(typeof compressed).not.toBe("string");
      expect(await inflateWirePayload(compressed as Uint8Array)).toBe(LARGE);
    });
  });

  it("keeps outbound order when a small send follows a large one", async () => {
    await withTransport(async (transport, socket) => {
      const warmup = transport.send(SMALL);
      openSocket(socket());
      await warmup;

      // Issue both without awaiting: the small text frame must not overtake
      // the large frame that is still inside the async deflate hop.
      const large = transport.send(LARGE);
      const small = transport.send(SMALL);
      await Promise.all([large, small]);

      expect(socket().sent.length).toBe(3);
      expect(typeof socket().sent[1]).not.toBe("string");
      expect(await inflateWirePayload(socket().sent[1] as Uint8Array))
        .toBe(LARGE);
      expect(socket().sent[2]).toBe(SMALL);
    });
  });

  it("keeps inbound order when text arrives behind a compressed frame", async () => {
    await withTransport(async (transport, socket) => {
      const received: string[] = [];
      let sawBoth: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        sawBoth = () => {
          if (received.length === 2) resolve();
        };
      });
      transport.setReceiver((payload) => {
        received.push(payload);
        sawBoth();
      });

      const send = transport.send(SMALL);
      openSocket(socket());
      await send;

      const compressed = await deflateWirePayload(LARGE);
      // Dispatch a binary frame immediately followed by a text frame; the
      // text frame must wait for the inflate ahead of it.
      socket().dispatchEvent(
        new MessageEvent("message", { data: compressed.buffer }),
      );
      socket().dispatchEvent(new MessageEvent("message", { data: SMALL }));

      await done;
      expect(received).toEqual([LARGE, SMALL]);
    });
  });

  it("delivers frames that arrived before close ahead of the close signal", async () => {
    await withTransport(async (transport, socket) => {
      const events: string[] = [];
      let done: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        done = resolve;
      });
      transport.setReceiver((payload) => events.push(`msg:${payload}`));
      transport.setCloseReceiver(() => {
        events.push("close");
        done();
      });

      const send = transport.send(SMALL);
      openSocket(socket());
      await send;

      // A compressed frame arrives, then the socket drops while the inflate
      // is still in flight. The frame must be delivered BEFORE the close
      // notification — never after it, and never dropped.
      socket().dispatchEvent(
        new MessageEvent("message", {
          data: (await deflateWirePayload(LARGE)).buffer,
        }),
      );
      socket().dispatchEvent(new CloseEvent("close"));

      await closed;
      expect(events).toEqual([`msg:${LARGE}`, "close"]);
    });
  });

  it("stops delivering after a failed inflate so a gap cannot be acked past", async () => {
    await withTransport(async (transport, socket) => {
      const received: string[] = [];
      transport.setReceiver((payload) => received.push(payload));
      let closed = false;
      const sawClose = new Promise<void>((resolve) => {
        transport.setCloseReceiver(() => {
          closed = true;
          resolve();
        });
      });

      const send = transport.send(SMALL);
      openSocket(socket());
      await send;

      // A corrupt compressed frame followed by a valid text frame: the valid
      // frame arrived AFTER the gap, so it must NOT be delivered — otherwise
      // the session would ack past the missing message and resume beyond it.
      socket().dispatchEvent(
        new MessageEvent("message", {
          data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer,
        }),
      );
      socket().dispatchEvent(new MessageEvent("message", { data: SMALL }));

      await sawClose;
      expect(received).toEqual([]);
      expect(closed).toBe(true);
    });
  });

  it("refuses to dial again after close() resolves", async () => {
    await withTransport(async (transport, socket) => {
      const send = transport.send(SMALL);
      openSocket(socket());
      await send;

      // Drop the socket with a compressed frame still inflating, then close
      // the transport while the drain is pending. A send in that window must
      // reject — never dial a fresh socket that nothing owns — and a send
      // after close() must reject with the closed error.
      socket().dispatchEvent(
        new MessageEvent("message", {
          data: (await deflateWirePayload(LARGE)).buffer,
        }),
      );
      const socketCount = DeflatingWebSocket.instances.length;
      socket().close();
      const parked = transport.send(SMALL);
      await expect(parked).rejects.toThrow(
        "memory websocket transport reconnected during send",
      );
      await transport.close();
      await expect(transport.send(SMALL)).rejects.toThrow(
        "memory websocket transport is closed",
      );
      expect(DeflatingWebSocket.instances.length).toBe(socketCount);
    });
  });

  it("closes the socket when the receiver fails to apply a frame", async () => {
    await withTransport(async (transport, socket) => {
      const received: string[] = [];
      transport.setReceiver((payload) => {
        received.push(payload);
        if (received.length === 1) {
          throw new Error("consumer failed to apply this frame");
        }
      });

      const send = transport.send(SMALL);
      openSocket(socket());
      await send;

      const closed = new Promise<void>((resolve) => {
        socket().addEventListener("close", () => resolve(), { once: true });
      });
      // First frame throws in the receiver: the transport must treat the
      // unapplied frame as a gap and close rather than deliver frame two
      // (which the session would ack from inconsistent state).
      socket().dispatchEvent(
        new MessageEvent("message", {
          data: (await deflateWirePayload(LARGE)).buffer,
        }),
      );
      socket().dispatchEvent(new MessageEvent("message", { data: SMALL }));

      await closed;
      expect(received).toEqual([LARGE]);
    });
  });

  it("tolerates a close() that throws while poisoning", async () => {
    await withTransport(async (transport, socket) => {
      const received: string[] = [];
      transport.setReceiver((payload) => received.push(payload));
      const send = transport.send(SMALL);
      openSocket(socket());
      await send;

      // Force the poison path's socket.close() to throw: the failure must
      // stay contained (no unhandled rejection, no delivery past the gap).
      socket().close = () => {
        throw new Error("close raced the peer");
      };
      socket().dispatchEvent(
        new MessageEvent("message", {
          data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer,
        }),
      );
      socket().dispatchEvent(new MessageEvent("message", { data: SMALL }));

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toEqual([]);
    });
  });

  it("ignores binary frames when the socket did not negotiate deflate", async () => {
    await withTransport(async (transport, socket) => {
      const received: string[] = [];
      transport.setReceiver((payload) => received.push(payload));

      const send = transport.send(SMALL);
      openSocket(socket());
      await send;
      socket().protocol = "";

      const compressed = await deflateWirePayload(LARGE);
      socket().dispatchEvent(
        new MessageEvent("message", { data: compressed.buffer }),
      );
      socket().dispatchEvent(new MessageEvent("message", { data: SMALL }));

      // Give any stray async work a tick before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received).toEqual([SMALL]);
    });
  });

  it("keeps noCompress frames as text in outbound order", async () => {
    await withTransport(async (transport, socket) => {
      const warmup = transport.send(SMALL);
      openSocket(socket());
      await warmup;

      // A large compressed frame followed by a large auth frame: the auth
      // frame must stay text AND must not overtake the compressed frame
      // still in the async deflate hop.
      const large = transport.send(LARGE);
      const auth = transport.send(LARGE, { noCompress: true });
      await Promise.all([large, auth]);

      expect(socket().sent.length).toBe(3);
      expect(typeof socket().sent[1]).not.toBe("string");
      expect(socket().sent[2]).toBe(LARGE);
    });
  });

  it("rejects a send parked across a reconnect instead of leaking it", async () => {
    await withTransport(async (transport, socket) => {
      const warmup = transport.send(SMALL);
      openSocket(socket());
      await warmup;

      // Drop the socket with an inflate pending so the drain window is open,
      // then issue a send inside that window. The payload must not ride the
      // next socket ahead of the client's fresh handshake — and once the
      // drain completes, a new send may dial again normally.
      socket().dispatchEvent(
        new MessageEvent("message", {
          data: (await deflateWirePayload(LARGE)).buffer,
        }),
      );
      const socketCount = DeflatingWebSocket.instances.length;
      const drained = new Promise<void>((resolve) => {
        transport.setCloseReceiver(() => resolve());
      });
      socket().close();
      const parked = transport.send(SMALL);
      await expect(parked).rejects.toThrow(
        "memory websocket transport reconnected during send",
      );
      expect(DeflatingWebSocket.instances.length).toBe(socketCount);

      // After the close notification lands (drain cleared), sends dial
      // fresh — the reconnect path is not blocked.
      await drained;
      const redial = transport.send(SMALL);
      openSocket(socket());
      await redial;
      expect(DeflatingWebSocket.instances.length).toBe(socketCount + 1);
    });
  });

  it("closes the socket when the inflate backlog exceeds its bound", async () => {
    await withTransport(async (transport, socket) => {
      const received: string[] = [];
      transport.setReceiver((payload) => received.push(payload));
      const send = transport.send(SMALL);
      openSocket(socket());
      await send;

      const closed = new Promise<void>((resolve) => {
        socket().addEventListener("close", () => resolve(), { once: true });
      });
      // Two 9 MiB frames dispatched back-to-back breach the 16 MiB pending
      // bound before the first inflate task can run.
      const nineMiB = new ArrayBuffer(9 * 1024 * 1024);
      socket().dispatchEvent(new MessageEvent("message", { data: nineMiB }));
      socket().dispatchEvent(new MessageEvent("message", { data: nineMiB }));

      await closed;
      expect(received).toEqual([]);
    });
  });

  it("sends everything as plain text when the server declined the offer", async () => {
    await withTransport(async (transport, socket) => {
      const first = transport.send(SMALL);
      openSocket(socket());
      socket().protocol = "";
      await first;
      await transport.send(LARGE);
      expect(socket().sent).toEqual([SMALL, LARGE]);
    });
  });
});
