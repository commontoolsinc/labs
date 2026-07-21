/**
 * Real-socket coverage for the standalone harness server's `cf-memory.deflate.v1`
 * support: negotiation, synchronous inflate/deflate both directions, the
 * auth-frame exemption, and frame-error close codes — mirroring toolshed's
 * behavior so `cf test` multi-user harnesses exercise the same transport.
 */
import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type SessionOpenChallenge,
} from "../v2.ts";
import { StandaloneMemoryServer } from "../v2/standalone.ts";
import {
  MEMORY_WS_DEFLATE_MIN_BYTES,
  MEMORY_WS_DEFLATE_SUBPROTOCOL,
} from "../v2/transport-deflate.ts";
import {
  deflateWirePayloadSync,
  inflateWirePayloadSync,
} from "../v2/transport-deflate-sync.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

type HelloOk = {
  type: "hello.ok";
  sessionOpen: { audience: string; challenge: SessionOpenChallenge };
};

const openSocket = async (
  url: URL,
  protocols?: string[],
): Promise<WebSocket> => {
  const address = new URL(url);
  address.protocol = "ws:";
  const socket = new WebSocket(address, protocols);
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", (event) => reject(event), { once: true });
  });
  return socket;
};

const readWireMessage = async <Message extends FabricValue>(
  socket: WebSocket,
): Promise<{ message: Message; wasBinary: boolean }> => {
  const data = await new Promise<string | ArrayBuffer>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
        resolve(event.data);
        return;
      }
      reject(new Error("Unexpected websocket frame type"));
    }, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket error before message")),
      { once: true },
    );
  });
  if (typeof data === "string") {
    return { message: decodeMemoryBoundary<Message>(data), wasBinary: false };
  }
  return {
    message: decodeMemoryBoundary<Message>(inflateWirePayloadSync(data)),
    wasBinary: true,
  };
};

const closeSocket = async (socket: WebSocket): Promise<void> => {
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  socket.close();
  await closed;
};

describe("standalone memory server deflate transport", () => {
  it("negotiates and compresses non-auth frames in both directions", async () => {
    const identity = await Identity.fromPassphrase("standalone-deflate");
    const server = StandaloneMemoryServer.start();
    const space = identity.did();

    try {
      const socket = await openSocket(server.url, [
        MEMORY_WS_DEFLATE_SUBPROTOCOL,
      ]);
      assertEquals(socket.protocol, MEMORY_WS_DEFLATE_SUBPROTOCOL);

      // Compressed hello: the server must inflate a binary first frame.
      socket.send(deflateWirePayloadSync(encodeMemoryBoundary(HELLO)));
      const hello = await readWireMessage<HelloOk>(socket);
      assertEquals(hello.message.type, "hello.ok");
      // hello.ok exceeds the threshold but carries the challenge: exempt.
      assertEquals(hello.wasBinary, false);

      const iat = Math.floor(Date.now() / 1000);
      const invocation = {
        iss: identity.did(),
        cmd: "session.open",
        sub: space,
        aud: hello.message.sessionOpen.audience,
        args: { protocol: MEMORY_PROTOCOL, session: {} },
        challenge: hello.message.sessionOpen.challenge.value,
        iat,
        exp: iat + 300,
      };
      const signature = await identity.sign(hashOf(invocation).bytes);
      if (signature.error) throw signature.error;
      socket.send(encodeMemoryBoundary({
        type: "session.open",
        requestId: "open-1",
        space,
        session: {},
        invocation,
        authorization: { signature: new FabricBytes(signature.ok) },
      }));
      const opened = await readWireMessage<{
        type: "response";
        ok: { sessionId: string };
      }>(socket);
      assertEquals(opened.message.type, "response");
      // The session.open response carries the bearer token: exempt.
      assertEquals(opened.wasBinary, false);

      // A large transact goes up compressed; its watch response comes back
      // compressed (the standalone server has no ACL genesis requirement).
      const fatValue = "standalone-".repeat(120);
      socket.send(deflateWirePayloadSync(encodeMemoryBoundary({
        type: "transact",
        requestId: "tx-1",
        space,
        sessionId: opened.message.ok.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:fat",
            value: { value: { fat: fatValue } },
          }],
        },
      })));
      const committed = await readWireMessage<{
        type: "response";
        error?: { name: string };
      }>(socket);
      assertEquals(committed.message.error, undefined);

      socket.send(encodeMemoryBoundary({
        type: "session.watch.add",
        requestId: "watch-1",
        space,
        sessionId: opened.message.ok.sessionId,
        watches: [{
          id: "fat",
          kind: "graph",
          query: {
            roots: [{
              id: "of:doc:fat",
              selector: { path: [], schema: false },
            }],
          },
        }],
      }));
      const watched = await readWireMessage<{
        type: "response";
        ok?: {
          sync?: { upserts?: Array<{ doc?: { value?: { fat?: string } } }> };
        };
      }>(socket);
      assertEquals(
        watched.message.ok?.sync?.upserts?.[0]?.doc?.value?.fat,
        fatValue,
      );
      assert(
        encodeMemoryBoundary(watched.message).length >=
          MEMORY_WS_DEFLATE_MIN_BYTES,
      );
      assertEquals(
        watched.wasBinary,
        true,
        "large non-auth standalone frames must be compressed",
      );

      await closeSocket(socket);
    } finally {
      await server.close();
    }
  });

  it("closes 1007 on malformed compressed frames and 1003 on unexpected binary", async () => {
    const server = StandaloneMemoryServer.start();
    try {
      const negotiated = await openSocket(server.url, [
        MEMORY_WS_DEFLATE_SUBPROTOCOL,
      ]);
      const closed1007 = new Promise<CloseEvent>((resolve) => {
        negotiated.addEventListener("close", (event) => resolve(event), {
          once: true,
        });
      });
      negotiated.send(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
      assertEquals((await closed1007).code, 1007);

      const plain = await openSocket(server.url);
      assertEquals(plain.protocol, "");
      const closed1003 = new Promise<CloseEvent>((resolve) => {
        plain.addEventListener("close", (event) => resolve(event), {
          once: true,
        });
      });
      plain.send(new Uint8Array([1, 2, 3]));
      assertEquals((await closed1003).code, 1003);
    } finally {
      await server.close();
    }
  });
});
