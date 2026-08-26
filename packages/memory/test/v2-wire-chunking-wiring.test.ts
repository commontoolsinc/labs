/**
 * The chunk codec as the hosts and the client wire it up, mostly over a real
 * socket pair: the standalone host (`v2/standalone.ts`) on one end, the memory
 * client (`v2/client.ts`) on the other. The chunk size is forced down to one
 * an ordinary commit crosses, so a payload a test can hold in memory exercises
 * the framing that the 64 MiB per-frame ceiling calls for on a real board.
 *
 * The last case reaches the client through a stub transport instead, which is
 * the only way to hand it a frame no host of this build would send.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricPlainObject } from "@commonfabric/api";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { hashOf } from "@commonfabric/data-model/value-hash";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type WireMemoryProtocolFlags,
} from "../v2.ts";
import {
  connect,
  type SessionOpenAuthFactory,
  type SpaceSession,
  type Transport,
} from "../v2/client.ts";
import { StandaloneMemoryServer } from "../v2/standalone.ts";
import {
  resetWireChunkingConfig,
  setWireChunkingConfig,
} from "../v2/wire-chunking.ts";
import { alice } from "./principal.ts";

/** Small enough that a commit of {@link BLOB} and its sync both cross it. */
const CHUNK_SIZE = 128;

/** A value no frame of {@link CHUNK_SIZE} code units can carry. */
const BLOB = "chunk-me-".repeat(400);

const webSocketAddress = (url: URL): URL => {
  const address = new URL(url.href);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  return address;
};

const closeSocket = (socket: WebSocket): Promise<void> => {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  socket.close();
  return closed;
};

/** The `type` a whole (unchunked) frame carries. */
const messageTypeOf = (frame: string): string | undefined =>
  decodeMemoryBoundary<{ type?: string }>(frame).type;

/** Signs a `session.open` the way the production client does. */
const signedSessionOpen = async (
  space: string,
  session: Record<string, never>,
  context: { audience: string; challenge: { value: string } },
) => {
  const iat = Math.floor(Date.now() / 1000);
  const invocation = {
    iss: alice.did(),
    cmd: "session.open",
    sub: space,
    aud: context.audience,
    args: { protocol: MEMORY_PROTOCOL, session },
    challenge: context.challenge.value,
    iat,
    exp: iat + 300,
  };
  const signature = await alice.sign(hashOf(invocation).bytes);
  if (signature.error) throw signature.error;
  return {
    invocation,
    authorization: { signature: new FabricBytes(signature.ok) },
  };
};

const sessionOpenAuthFactory: SessionOpenAuthFactory = (
  space,
  _session,
  context,
) => signedSessionOpen(space, {}, context);

type SocketTransport = {
  transport: Transport;
  /** Every frame the client handed to the socket, in order. */
  sent: string[];
  /** Every frame the socket delivered to the client, in order. */
  received: string[];
};

/**
 * A transport over a real WebSocket that keeps a copy of every frame each way,
 * so a test can say what actually crossed the wire rather than what the client
 * made of it.
 */
const socketTransport = (url: URL): SocketTransport => {
  const socket = new WebSocket(webSocketAddress(url));
  const sent: string[] = [];
  const received: string[] = [];
  let receiver = (_payload: string) => {};
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("memory test socket failed to open")),
      { once: true },
    );
  });
  opened.catch(() => undefined);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    received.push(event.data);
    receiver(event.data);
  });
  return {
    sent,
    received,
    transport: {
      async send(payload: string) {
        await opened;
        sent.push(payload);
        socket.send(payload);
      },
      close: () => closeSocket(socket),
      setReceiver(next) {
        receiver = next;
      },
      setCloseReceiver() {},
    },
  };
};

type RawPeer = {
  /** Sends one whole frame, the way a peer that never chunks would. */
  send(message: FabricPlainObject): void;
  /** Sends frame text verbatim, whatever the framing contract says of it. */
  sendFrame(frame: string): void;
  /** Resolves with frame `index` once it has arrived. */
  frame(index: number): Promise<string>;
  /** Resolves with the close the host sends this peer. */
  closed: Promise<CloseEvent>;
  close(): Promise<void>;
};

/**
 * A hand-rolled peer that advertises exactly `flags`. The real client always
 * advertises this build's, so a client without the capability has to be
 * spoken for by hand.
 */
const rawPeer = async (
  url: URL,
  flags: WireMemoryProtocolFlags,
): Promise<RawPeer> => {
  const socket = new WebSocket(webSocketAddress(url));
  const frames: string[] = [];
  const waiting = new Set<
    { index: number; resolve: (frame: string) => void }
  >();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    frames.push(event.data);
    for (const waiter of [...waiting]) {
      if (waiter.index < frames.length) {
        waiting.delete(waiter);
        waiter.resolve(frames[waiter.index]);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("memory test socket failed to open")),
      { once: true },
    );
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event), { once: true });
  });
  const peer: RawPeer = {
    send(message) {
      socket.send(encodeMemoryBoundary(message));
    },
    sendFrame(frame) {
      socket.send(frame);
    },
    closed,
    frame(index) {
      if (index < frames.length) return Promise.resolve(frames[index]);
      return new Promise<string>((resolve) => {
        waiting.add({ index, resolve });
      });
    },
    close: () => closeSocket(socket),
  };
  peer.send({ type: "hello", protocol: MEMORY_PROTOCOL, flags });
  return peer;
};

/**
 * A transport under the test's control: it answers each frame the client sends
 * with whatever `respond` returns for it, which is the only way to hand the
 * client a frame no host of this build would send.
 */
const stubTransport = (respond: (payload: string) => string | undefined) => {
  let receiver = (_payload: string) => {};
  const state = { closed: false };
  const transport: Transport = {
    send(payload: string) {
      const reply = respond(payload);
      if (reply !== undefined) queueMicrotask(() => receiver(reply));
      return Promise.resolve();
    },
    close() {
      state.closed = true;
      return Promise.resolve();
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver() {},
  };
  return { transport, state };
};

/** The `hello.ok` a stub transport answers the handshake with. */
const stubHelloOk = (): string =>
  encodeMemoryBoundary({
    type: "hello.ok",
    protocol: MEMORY_PROTOCOL,
    flags: getMemoryProtocolFlags(),
    sessionOpen: {
      audience: "did:key:z6Mk-wire-chunking-stub-audience",
      challenge: {
        value: "stub-challenge",
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      },
    },
  });

/** A frame that opens a stream at an index no receiver can be waiting for. */
const BROKEN_FRAME = "fvc1:0:3:4:nonsense";

const commitBlob = (session: SpaceSession, id: string) =>
  session.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id, value: { value: { blob: BLOB } } }],
  });

const watchBlob = async (session: SpaceSession, id: string) => {
  const view = await session.watchSet([{
    id,
    kind: "graph",
    query: { roots: [{ id, selector: { path: [], schema: false } }] },
  }]);
  return view.entities.find((entity) => entity.id === id)?.document;
};

describe("wire-chunking wiring", () => {
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    setWireChunkingConfig({ chunkSize: CHUNK_SIZE });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
    resetWireChunkingConfig();
  });

  const startServer = (): StandaloneMemoryServer => {
    const server = StandaloneMemoryServer.start();
    cleanups.push(() => server.close());
    return server;
  };

  const connectClient = async (server: StandaloneMemoryServer) => {
    const socket = socketTransport(server.url);
    cleanups.push(() => socket.transport.close());
    const client = await connect({ transport: socket.transport });
    cleanups.push(() => client.close());
    return { ...socket, client };
  };

  it("delivers an over-threshold response as chunks the client reassembles", async () => {
    const server = startServer();
    const { client, received } = await connectClient(server);
    const session = await client.mount(
      "did:key:z6Mk-wire-chunking-socket-inbound",
      {},
      sessionOpenAuthFactory,
    );

    await commitBlob(session, "of:inbound");
    expect(await watchBlob(session, "of:inbound")).toEqual({
      value: { blob: BLOB },
    });

    expect(received.some((frame) => frame.startsWith("fvc1:"))).toBe(true);
    // Nothing but the exempt handshake crossed the wire whole and oversized:
    // the sync carrying the blob is several times the chunk size, so an
    // unwired server would show up here as a second entry.
    const whole = received.filter((frame) => !frame.startsWith("fvc1:"));
    expect(
      whole.filter((frame) => frame.length > CHUNK_SIZE).map(messageTypeOf),
    ).toEqual(["hello.ok"]);
  });

  it("sends an over-threshold response whole to a client whose `hello` omits the capability", async () => {
    const server = startServer();
    const { wireChunking: _absent, ...flags } = getMemoryProtocolFlags();
    const peer = await rawPeer(server.url, flags);
    cleanups.push(() => peer.close());

    const helloOk = decodeMemoryBoundary<HelloOkMessage>(await peer.frame(0));
    expect(helloOk.type).toBe("hello.ok");
    const space = "did:key:z6Mk-wire-chunking-socket-unchunked";
    peer.send({
      type: "session.open",
      requestId: "req:1",
      space,
      session: {},
      ...await signedSessionOpen(
        space,
        {},
        helloOk.sessionOpen as SessionOpenAuthMetadata,
      ),
    });

    const frame = await peer.frame(1);
    const response = decodeMemoryBoundary<ResponseMessage<SessionOpenResult>>(
      frame,
    );
    expect(response.error).toBe(undefined);
    expect(typeof response.ok?.sessionId).toBe("string");
    // The response is past the threshold, and still arrived as one whole
    // frame: this peer never advertised that it reassembles chunks.
    expect(frame.length).toBeGreaterThan(CHUNK_SIZE);
    expect(frame.startsWith("fvj1:")).toBe(true);
  });

  it("chunks an over-threshold request the server reassembles", async () => {
    const server = startServer();
    const { client, sent } = await connectClient(server);
    const session = await client.mount(
      "did:key:z6Mk-wire-chunking-socket-outbound",
      {},
      sessionOpenAuthFactory,
    );

    await commitBlob(session, "of:outbound");

    expect(sent.some((frame) => frame.startsWith("fvc1:"))).toBe(true);
    // The server put the frames back together: it accepted the commit above,
    // and the value it stored is the one that was split.
    expect(await watchBlob(session, "of:outbound")).toEqual({
      value: { blob: BLOB },
    });
  });

  it("closes with 1002 on a client frame that breaks the framing", async () => {
    const server = startServer();
    const peer = await rawPeer(server.url, getMemoryProtocolFlags());
    cleanups.push(() => peer.close());
    // The handshake completed, so the frame below reaches the host's
    // reassembler rather than its first-message path.
    expect(decodeMemoryBoundary<HelloOkMessage>(await peer.frame(0)).type)
      .toBe("hello.ok");

    peer.sendFrame(BROKEN_FRAME);

    expect((await peer.closed).code).toBe(1002);
  });

  it("fails the connection on a server frame that breaks the framing", async () => {
    // The sizes decide nothing here: a stream that opens at index 3 is a
    // violation whatever the chunk size is.
    resetWireChunkingConfig();
    const stub = stubTransport((payload) =>
      messageTypeOf(payload) === "hello" ? stubHelloOk() : BROKEN_FRAME
    );
    const client = await connect({ transport: stub.transport });
    cleanups.push(() => client.close());

    const mounting = client.mount(
      "did:key:z6Mk-wire-chunking-stub",
      {},
      sessionOpenAuthFactory,
    );
    const failure = await mounting.then(() => null, (error: Error) => error);

    // The pending request failed as a lost connection — the client's ordinary
    // reconnect path — and the transport was dropped rather than kept open on
    // a stream that can no longer be read.
    expect(failure?.name).toBe("ConnectionError");
    expect(stub.state.closed).toBe(true);
  });
});
