/**
 * Real-websocket coverage for the negotiated `fvj1.deflate` memory
 * transport: negotiation via subprotocol, synchronous server codec both
 * directions, the auth-frame compression exemption, the env kill switch,
 * and byte-identical behavior for clients that do not offer the
 * subprotocol.
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
  MEMORY_WS_DEFLATE_MIN_BYTES,
  MEMORY_WS_DEFLATE_SUBPROTOCOL,
} from "@commonfabric/memory/v2/transport-deflate";
import {
  deflateWirePayloadSync,
  inflateWirePayloadSync,
} from "@commonfabric/memory/v2/transport-deflate-sync";
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
    message: decodeMemoryBoundary<Message>(inflateWirePayloadSync(data)),
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

/** hello (compressed — servers must accept any framing) → hello.ok →
 *  session.open (text, matching the real client's auth exemption). */
const negotiateSession = async (
  socket: WebSocket,
  identity: Identity,
  space: string,
): Promise<{ sessionId: string; helloWasBinary: boolean }> => {
  socket.send(deflateWirePayloadSync(encodeMemoryBoundary(HELLO)));
  const hello = await readWireMessage<HelloOkWithSessionOpen>(socket);
  assertEquals(hello.message.type, "hello.ok");
  assertEquals(hello.message.protocol, MEMORY_PROTOCOL);

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
    ok: { sessionId: string };
  }>(socket);
  assertEquals(opened.message.type, "response");
  assert(opened.message.ok.sessionId.length > 0);
  // The session.open response carries the bearer session token and the next
  // challenge: auth-bearing frames are never compressed, regardless of size.
  assertEquals(
    opened.wasBinary,
    false,
    "session.open response must never be compressed (auth exemption)",
  );
  return {
    sessionId: opened.message.ok.sessionId,
    helloWasBinary: hello.wasBinary,
  };
};

/** Writes a document large enough that its watch.add sync response crosses
 *  the compression threshold, then watches it. Returns the response frame's
 *  framing plus decoded response. The transact itself is sent COMPRESSED to
 *  exercise synchronous server-side inflation of a large frame. */
const transactAndWatchFatDoc = async (
  socket: WebSocket,
  space: string,
  sessionId: string,
  ownerDid: string,
): Promise<{ watchWasBinary: boolean; fatValue: string }> => {
  // Fresh spaces demand an ACL-only genesis commit before ordinary writes.
  socket.send(encodeMemoryBoundary({
    type: "transact",
    requestId: "tx-genesis",
    space,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space}`,
        value: { value: { [ownerDid]: "OWNER" } },
      }],
    },
  }));
  const genesis = await readWireMessage<{
    type: "response";
    requestId: string;
    error?: { name: string; message: string };
  }>(socket);
  assertEquals(genesis.message.requestId, "tx-genesis");
  assertEquals(genesis.message.error, undefined);

  const fatValue = "lunch-".repeat(200);
  socket.send(deflateWirePayloadSync(encodeMemoryBoundary({
    type: "transact",
    requestId: "tx-1",
    space,
    sessionId,
    commit: {
      localSeq: 2,
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
    requestId: string;
    ok?: Record<string, unknown>;
    error?: { name: string; message: string };
  }>(socket);
  assertEquals(committed.message.requestId, "tx-1");
  assertEquals(committed.message.error, undefined);

  socket.send(encodeMemoryBoundary({
    type: "session.watch.add",
    requestId: "watch-1",
    space,
    sessionId,
    watches: [{
      id: "fat-doc",
      kind: "graph",
      query: {
        roots: [{ id: "of:doc:fat", selector: { path: [], schema: false } }],
      },
    }],
  }));
  const watched = await readWireMessage<{
    type: "response";
    requestId: string;
    ok?: { sync?: { upserts?: Array<{ doc?: { value?: { fat?: string } } }> } };
    error?: { name: string; message: string };
  }>(socket);
  assertEquals(watched.message.requestId, "watch-1");
  assertEquals(watched.message.error, undefined);
  const roundtripped = watched.message.ok?.sync?.upserts?.[0]?.doc?.value?.fat;
  assertEquals(roundtripped, fatValue);
  assert(
    encodeMemoryBoundary(watched.message).length >=
      MEMORY_WS_DEFLATE_MIN_BYTES,
    "watch response must cross the compression threshold for this test",
  );
  return { watchWasBinary: watched.wasBinary, fatValue };
};

const closeSocket = async (socket: WebSocket): Promise<void> => {
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  socket.close();
  await closed;
};

Deno.test("memory websocket compresses large frames both ways but never auth frames", async () => {
  const identity = await Identity.fromPassphrase("memory-ws-deflate-test");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  const space = identity.did();

  try {
    const socket = await openSocket(address, [MEMORY_WS_DEFLATE_SUBPROTOCOL]);
    assertEquals(socket.protocol, MEMORY_WS_DEFLATE_SUBPROTOCOL);

    const { sessionId, helloWasBinary } = await negotiateSession(
      socket,
      identity,
      space,
    );
    // hello.ok carries the session-open challenge: auth frames are exempt
    // from compression even though hello.ok exceeds the size threshold.
    assertEquals(
      helloWasBinary,
      false,
      "hello.ok must never be compressed (auth exemption)",
    );

    // Large non-auth traffic compresses in both directions: the transact
    // goes up compressed, and the watch response comes down compressed.
    const { watchWasBinary } = await transactAndWatchFatDoc(
      socket,
      space,
      sessionId,
      identity.did(),
    );
    assertEquals(
      watchWasBinary,
      true,
      "large non-auth server frames must be compressed",
    );

    await closeSocket(socket);
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

    await closeSocket(socket);
  } finally {
    await server.shutdown();
  }
});

Deno.test("env kill switch keeps negotiation but stops outbound compression", async () => {
  const identity = await Identity.fromPassphrase("memory-ws-deflate-kill");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  const space = identity.did();

  Deno.env.set("CF_MEMORY_WS_DEFLATE", "0");
  try {
    const socket = await openSocket(address, [MEMORY_WS_DEFLATE_SUBPROTOCOL]);
    // The subprotocol is still selected — refusing an offer would fail the
    // connection for clients (like browsers) that cannot read the env.
    assertEquals(socket.protocol, MEMORY_WS_DEFLATE_SUBPROTOCOL);

    // Compressed inbound frames are still accepted...
    const { sessionId } = await negotiateSession(socket, identity, space);
    // ...but even large non-auth outbound stays text.
    const { watchWasBinary } = await transactAndWatchFatDoc(
      socket,
      space,
      sessionId,
      identity.did(),
    );
    assertEquals(
      watchWasBinary,
      false,
      "kill switch must stop outbound compression",
    );

    await closeSocket(socket);
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
    socket.send(deflateWirePayloadSync(encodeMemoryBoundary(HELLO)));
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

Deno.test("stats recorder captures negotiated compression per connection", async () => {
  const identity = await Identity.fromPassphrase("memory-ws-deflate-stats");
  const statsFile = await Deno.makeTempFile({ suffix: ".jsonl" });
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  const space = identity.did();

  Deno.env.set("CF_MEMORY_WS_DEFLATE_STATS_FILE", statsFile);
  try {
    const socket = await openSocket(address, [MEMORY_WS_DEFLATE_SUBPROTOCOL]);
    const { sessionId } = await negotiateSession(socket, identity, space);
    await transactAndWatchFatDoc(socket, space, sessionId, identity.did());
    await closeSocket(socket);

    // The recorder appends on the server's close event; poll briefly.
    let lines: string[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      const content = await Deno.readTextFile(statsFile).catch(() => "");
      lines = content.split("\n").filter((line) => line.length > 0);
      if (lines.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(lines.length, 1, "one closed connection, one stats line");
    const record = JSON.parse(lines[0]) as {
      negotiated: boolean;
      kind: string;
      cpuMs: number;
      inbound: {
        wireBytes: number;
        logicalBytes: number;
        frames: number;
        compressedFrames: number;
      };
      outbound: {
        wireBytes: number;
        logicalBytes: number;
        frames: number;
        compressedFrames: number;
      };
    };
    assertEquals(record.negotiated, true);
    assertEquals(record.kind, "runtime");
    // The fat transact went up compressed and the fat watch response came
    // down compressed, so both directions must show savings.
    assert(record.inbound.compressedFrames >= 1);
    assert(record.outbound.compressedFrames >= 1);
    assert(record.inbound.wireBytes < record.inbound.logicalBytes);
    assert(record.outbound.wireBytes < record.outbound.logicalBytes);
    assert(record.inbound.frames > record.inbound.compressedFrames);
    assert(record.cpuMs >= 0);
  } finally {
    Deno.env.delete("CF_MEMORY_WS_DEFLATE_STATS_FILE");
    await server.shutdown();
    await Deno.remove(statsFile).catch(() => {});
  }
});
