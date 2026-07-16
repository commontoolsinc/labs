/**
 * SPIKE: real-websocket coverage for the negotiated `fvj1.deflate` memory
 * transport — negotiation via subprotocol, compressed frames both directions,
 * mixed text/binary on one connection, and byte-identical behavior for
 * clients that do not offer the subprotocol.
 */
import { assert, assertEquals } from "@std/assert";
import app from "../../../app.ts";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type SessionOpenChallenge,
} from "@commonfabric/memory/v2";
import {
  deflateWirePayload,
  inflateWirePayload,
  MEMORY_WS_DEFLATE_MIN_BYTES,
  MEMORY_WS_DEFLATE_SUBPROTOCOL,
} from "@commonfabric/memory/v2/transport-deflate";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

type HelloOkWithSessionOpen = {
  type: "hello.ok";
  protocol: string;
  flags: ReturnType<typeof getMemoryProtocolFlags>;
  sessionOpen: {
    audience: string;
    challenge: SessionOpenChallenge;
  };
};

const openSocket = async (
  url: URL,
  protocols?: string[],
): Promise<WebSocket> => {
  const socket = new WebSocket(url, protocols);
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
    message: decodeMemoryBoundary<Message>(await inflateWirePayload(data)),
    wasBinary: true,
  };
};

const createSessionOpenAuth = async (
  identity: Identity,
  space: string,
  sessionOpen: { audience: string; challenge: SessionOpenChallenge },
) => {
  const iat = Math.floor(Date.now() / 1000);
  const invocation = {
    iss: identity.did(),
    cmd: "session.open",
    sub: space,
    aud: sessionOpen.audience,
    args: { protocol: MEMORY_PROTOCOL, session: {} },
    challenge: sessionOpen.challenge.value,
    iat,
    exp: iat + 300,
  };
  const signature = await identity.sign(hashOf(invocation).bytes);
  if (signature.error) {
    throw signature.error;
  }
  return {
    invocation,
    // Mirror the production producer (`v2-remote-session.ts`): send the
    // signature as a `FabricBytes`.
    authorization: { signature: new FabricBytes(signature.ok) },
  };
};

Deno.test("memory websocket negotiates deflate and speaks compressed frames both directions", async () => {
  const identity = await Identity.fromPassphrase("memory-ws-deflate-test");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  const space = identity.did();

  try {
    const socket = await openSocket(address, [MEMORY_WS_DEFLATE_SUBPROTOCOL]);
    assertEquals(socket.protocol, MEMORY_WS_DEFLATE_SUBPROTOCOL);

    // Send the hello COMPRESSED even though it is small: the server must
    // inflate a binary first frame before protocol sniffing.
    socket.send(await deflateWirePayload(encodeMemoryBoundary(HELLO)));

    const hello = await readWireMessage<HelloOkWithSessionOpen>(socket);
    assertEquals(hello.message.type, "hello.ok");
    assertEquals(hello.message.protocol, MEMORY_PROTOCOL);
    assertEquals(hello.message.flags, getMemoryProtocolFlags());
    // hello.ok (flags + audience + challenge) is above the compression
    // threshold, so a negotiated server ships it as a binary frame.
    assert(hello.wasBinary, "expected hello.ok as a compressed binary frame");

    // Mixed framing: a plain-text frame is still valid after negotiation.
    const auth = await createSessionOpenAuth(
      identity,
      space,
      hello.message.sessionOpen,
    );
    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      ...auth,
    }));

    const opened = await readWireMessage<{
      type: "response";
      requestId: string;
      ok: { sessionId: string; serverSeq: number };
    }>(socket);
    assertEquals(opened.message.type, "response");
    assertEquals(opened.message.requestId, "open-1");
    assertEquals(opened.message.ok.serverSeq, 0);
    assert(opened.message.ok.sessionId.length > 0);
    // Framing must follow the threshold: payloads at or above the minimum
    // ship compressed, smaller ones stay text.
    const encodedBytes = new TextEncoder().encode(
      encodeMemoryBoundary(opened.message),
    ).byteLength;
    assertEquals(
      opened.wasBinary,
      encodedBytes >= MEMORY_WS_DEFLATE_MIN_BYTES,
      `framing must match threshold for a ${encodedBytes}-byte payload`,
    );

    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close();
    await closed;
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket without the subprotocol stays text-only", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const socket = await openSocket(address);
    assertEquals(socket.protocol, "");

    socket.send(encodeMemoryBoundary(HELLO));
    const hello = await readWireMessage<HelloOkWithSessionOpen>(socket);
    assertEquals(hello.message.type, "hello.ok");
    assertEquals(
      hello.wasBinary,
      false,
      "non-negotiated connections must never receive binary frames",
    );

    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close();
    await closed;
  } finally {
    await server.shutdown();
  }
});

Deno.test("env kill switch keeps negotiation but stops outbound compression", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  Deno.env.set("CF_MEMORY_WS_DEFLATE", "0");
  try {
    const socket = await openSocket(address, [MEMORY_WS_DEFLATE_SUBPROTOCOL]);
    // The subprotocol is still selected — refusing an offer would fail the
    // connection for clients (like browsers) that cannot read the env.
    assertEquals(socket.protocol, MEMORY_WS_DEFLATE_SUBPROTOCOL);

    // Compressed inbound frames are still accepted...
    socket.send(await deflateWirePayload(encodeMemoryBoundary(HELLO)));
    const hello = await readWireMessage<HelloOkWithSessionOpen>(socket);
    assertEquals(hello.message.type, "hello.ok");
    // ...but the server's outbound stays text.
    assertEquals(hello.wasBinary, false);

    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close();
    await closed;
  } finally {
    Deno.env.delete("CF_MEMORY_WS_DEFLATE");
    await server.shutdown();
  }
});

Deno.test("memory websocket closes on a malformed compressed frame", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const socket = await openSocket(address, [MEMORY_WS_DEFLATE_SUBPROTOCOL]);
    socket.send(await deflateWirePayload(encodeMemoryBoundary(HELLO)));
    const hello = await readWireMessage<HelloOkWithSessionOpen>(socket);
    assertEquals(hello.message.type, "hello.ok");

    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event), {
        once: true,
      });
    });
    socket.send(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const event = await closed;
    assertEquals(event.code, 1007);
  } finally {
    await server.shutdown();
  }
});
