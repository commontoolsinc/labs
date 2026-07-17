import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { type MemorySpace, type Signer } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { MEMORY_PROTOCOL } from "@commonfabric/memory/v2";
import {
  deflateWirePayload,
  inflateWirePayload,
  MEMORY_WS_DEFLATE_MIN_BYTES,
  MEMORY_WS_DEFLATE_SUBPROTOCOL,
  MEMORY_WS_MAX_PENDING_INFLATE_BYTES,
  memoryWsDeflateEnabled,
  memoryWsDeflateSupported,
  SerialTaskQueue,
} from "@commonfabric/memory/v2/transport-deflate";

const TEXT_ENCODER = new TextEncoder();

export interface SessionFactory {
  /** Opt in to StorageManager's ACL genesis handshake. Scripted factories used
   *  by lower-level replica tests omit this because they intentionally model
   *  only the messages under test. */
  readonly supportsAclBootstrap?: boolean;
  create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions?: MemoryClient.MountOptions,
  ): Promise<{
    client: MemoryClient.Client;
    session: MemoryClient.SpaceSession;
  }>;
}

export const toWebSocketAddress = (address: URL): URL => {
  const next = new URL(address);
  if (next.protocol === "https:") {
    next.protocol = "wss:";
  } else if (next.protocol === "http:") {
    next.protocol = "ws:";
  }
  return next;
};

export const toSpaceWebSocketAddress = (
  address: URL,
  space: MemorySpace,
): URL => {
  const next = toWebSocketAddress(address);
  next.searchParams.set("space", space);
  return next;
};

/** Path every memory host serves its storage endpoint under. */
export const MEMORY_STORAGE_PATH = "/api/storage/memory";

/**
 * Validity window stamped onto each signed `session.open`.
 * `session.open` is a live handshake sent when a connection opens, so a few
 * minutes covers clock skew and round-trip time while bounding replay.
 */
export const SESSION_OPEN_TTL_SECONDS = 300;

/**
 * Build the per-space storage-endpoint resolver: a space present in
 * `spaceHostMap` resolves against that host's base URL, everything else
 * against `defaultHost`. Host selection lives here, next to the
 * websocket address builders, so the storage-endpoint join happens in
 * exactly one place.
 *
 * Map entries are validated eagerly so a malformed host fails at
 * configuration time with the offending space named, not later inside
 * session creation as a bare `Invalid URL`.
 */
export const createStorageAddressResolver = (
  defaultHost: URL,
  spaceHostMap?: Record<string, string>,
  /**
   * Late-bound host hints (space DID → host base URL) learned at
   * runtime, e.g. from the home-space site table. Consulted AFTER the
   * seed map and BEFORE the default. The caller owns mutation rules
   * (a hint must never re-point an already-opened space).
   */
  dynamicHosts?: ReadonlyMap<string, string>,
): (space: MemorySpace) => URL => {
  const overrides = new Map<string, URL>();
  for (const [space, host] of Object.entries(spaceHostMap ?? {})) {
    try {
      overrides.set(space, new URL(MEMORY_STORAGE_PATH, host));
    } catch (cause) {
      throw new Error(
        `Invalid spaceHostMap entry for ${space}: "${host}"`,
        { cause },
      );
    }
  }
  const fallback = new URL(MEMORY_STORAGE_PATH, defaultHost);
  return (space) => {
    const seeded = overrides.get(space);
    if (seeded) return new URL(seeded);
    const dynamic = dynamicHosts?.get(space);
    if (dynamic) return new URL(MEMORY_STORAGE_PATH, dynamic);
    return new URL(fallback);
  };
};

export class WebSocketTransport implements MemoryClient.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #socket: WebSocket | null = null;
  #opening: Promise<WebSocket> | null = null;
  // SPIKE: outbound ordering queue for the async deflate hop on a negotiated
  // connection. One queue per transport is safe across reconnects because
  // each task captures its own socket and no-ops once that socket closes.
  #outbound = new SerialTaskQueue();
  // SPIKE: while a closed socket's queued frames drain toward the close
  // notification, a re-dial must wait — otherwise a send() could open a new
  // socket before the consumer learns the old one closed, a window the
  // synchronous pre-spike path never had.
  #draining: Promise<void> | null = null;
  // SPIKE: once close() is called nothing may dial again. Without this latch
  // an open() parked on #draining could resume after close() returned and
  // leak a brand-new live socket.
  #closed = false;

  constructor(private readonly address: URL) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  async send(
    payload: string,
    hints?: MemoryClient.TransportSendHints,
  ): Promise<void> {
    if (this.#draining !== null) {
      // The connection is turning over: its close notification is still
      // queued behind pending inflates, so the caller does not yet know the
      // socket dropped. Sending now would dial the next socket and put a
      // stale payload ahead of the client's fresh handshake. Callers treat
      // this like any other transport failure and replay via the reconnect
      // machinery (which only runs after the close notification lands, when
      // the drain is already cleared).
      const error = new Error(
        "memory websocket transport reconnected during send",
      );
      error.name = "ConnectionError";
      throw error;
    }
    const socket = await this.open();
    if (socket.protocol !== MEMORY_WS_DEFLATE_SUBPROTOCOL) {
      socket.send(payload);
      return;
    }
    // Negotiated: every send funnels through the queue — a small text frame
    // must not overtake an earlier payload still being compressed. Frames
    // with the noCompress hint (auth-bearing) stay text but keep their
    // position in the same order.
    await this.#outbound.enqueue(async () => {
      const bytes = TEXT_ENCODER.encode(payload).byteLength;
      if (
        hints?.noCompress === true || bytes < MEMORY_WS_DEFLATE_MIN_BYTES
      ) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
        return;
      }
      const compressed = await deflateWirePayload(payload);
      // Mirrors the uncompressed path: sending on a socket that closed
      // after open() resolved is a silent drop, recovered by reconnect.
      if (socket.readyState === WebSocket.OPEN) socket.send(compressed);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#opening = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      // A drain may still be delivering frames from an already-closed socket;
      // close() returning must mean nothing fires afterwards.
      if (this.#draining !== null) await this.#draining;
      return;
    }
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.addEventListener("error", () => resolve(), { once: true });
    });
    if (
      socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN
    ) {
      socket.close();
    }
    await closed;
    if (this.#draining !== null) await this.#draining;
  }

  private async open(): Promise<WebSocket> {
    if (this.#closed) {
      const error = new Error("memory websocket transport is closed");
      error.name = "ConnectionError";
      throw error;
    }
    if (this.#socket?.readyState === WebSocket.OPEN) {
      return this.#socket;
    }
    if (this.#opening) {
      return await this.#opening;
    }
    if (this.#draining !== null) {
      await this.#draining;
      // Drain completion may have raced another open() or a close(); re-enter
      // to observe the current state (including the closed latch).
      return await this.open();
    }
    const address = toWebSocketAddress(this.address);
    const opening = new Promise<WebSocket>((resolve, reject) => {
      // SPIKE: offer the deflate subprotocol when this runtime can actually
      // inflate (offering is a commitment) and it is not opted out via
      // CF_MEMORY_WS_DEFLATE=0. Servers that predate the subprotocol will
      // fail this connection per RFC 6455, so server support deploys first.
      const socket = new WebSocket(
        address,
        memoryWsDeflateEnabled() && memoryWsDeflateSupported()
          ? [MEMORY_WS_DEFLATE_SUBPROTOCOL]
          : [],
      );
      socket.binaryType = "arraybuffer";
      this.#socket = socket;
      let opened = false;
      // SPIKE: inbound ordering queue, per socket — async inflation must not
      // let a later text frame overtake an earlier compressed frame. A failed
      // inflate poisons the queue: delivering frames past a transport-level
      // gap would let the session ack and resume beyond messages it never
      // saw. Only the close notification may follow a poisoned frame.
      const inbound = new SerialTaskQueue();
      let poisoned = false;
      let pendingInflateBytes = 0;
      const deliver = (payload: string) => {
        if (poisoned) return;
        try {
          this.#receiver(payload);
        } catch (error) {
          // Receiver failures are the consumer's problem, not a transport
          // gap: log and keep delivering (same as the non-negotiated path).
          console.error("memory websocket receiver failed", error);
        }
      };
      socket.addEventListener("open", () => {
        opened = true;
        resolve(socket);
      }, { once: true });
      socket.addEventListener("message", (event) => {
        const data: unknown = event.data;
        if (typeof data === "string") {
          if (socket.protocol !== MEMORY_WS_DEFLATE_SUBPROTOCOL) {
            deliver(data);
            return;
          }
          void inbound.enqueue(() => deliver(data));
          return;
        }
        if (
          socket.protocol === MEMORY_WS_DEFLATE_SUBPROTOCOL &&
          (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
        ) {
          if (
            pendingInflateBytes + data.byteLength >
              MEMORY_WS_MAX_PENDING_INFLATE_BYTES
          ) {
            // The server outpaced local inflation past any legitimate burst:
            // treat it as a transport failure rather than buffering without
            // bound.
            poisoned = true;
            try {
              socket.close();
            } catch {
              // Ignore close races with the peer.
            }
            return;
          }
          pendingInflateBytes += data.byteLength;
          void inbound.enqueue(async () => {
            try {
              if (poisoned) return;
              let payload: string;
              try {
                payload = await inflateWirePayload(data);
              } catch (error) {
                poisoned = true;
                throw error;
              }
              deliver(payload);
            } finally {
              pendingInflateBytes -= data.byteLength;
            }
          }).catch(() => {
            // A malformed compressed frame is a transport failure: close so
            // the client's reconnect machinery takes over and replays.
            try {
              socket.close();
            } catch {
              // Ignore close races with the peer.
            }
          });
          return;
        }
        // Non-negotiated binary frames stay ignored (historical behavior).
      });
      socket.addEventListener("close", () => {
        if (this.#socket === socket) {
          this.#socket = null;
        }
        if (this.#opening === opening) {
          this.#opening = null;
        }
        // SPIKE: the close notification queues behind pending inflates so
        // every frame that arrived before the close is delivered first —
        // the client's reconnect must not race a stale frame (and nothing
        // may be delivered after the close notification).
        const drained = inbound.enqueue(() => {
          // Dial-able again the instant the consumer learns of the close:
          // clear before notifying so a reconnect issued inside the
          // notification is not rejected by the draining guard.
          if (this.#draining === drained) this.#draining = null;
          this.#closeReceiver();
        })
          .catch(() => {})
          .finally(() => {
            if (this.#draining === drained) this.#draining = null;
          });
        this.#draining = drained;
        if (!opened) {
          reject(new Error("memory websocket transport closed before opening"));
        }
      });
      socket.addEventListener("error", (event) => {
        if (this.#socket === socket) {
          this.#socket = null;
        }
        if (this.#opening === opening) {
          this.#opening = null;
        }
        const error =
          event instanceof ErrorEvent && event.error instanceof Error
            ? event.error
            : new Error("memory websocket transport error");
        const drained = inbound.enqueue(() => {
          if (this.#draining === drained) this.#draining = null;
          this.#closeReceiver(error);
        })
          .catch(() => {})
          .finally(() => {
            if (this.#draining === drained) this.#draining = null;
          });
        this.#draining = drained;
        reject(event);
      }, { once: true });
    });
    this.#opening = opening;
    return await this.#opening;
  }
}

export class RemoteSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;

  constructor(
    private readonly resolveAddress: (space: MemorySpace) => URL,
    private readonly defaultSigner: Signer,
  ) {}

  async #createSessionOpenAuth(
    signer: Signer,
    space: MemorySpace,
    session: MemoryClient.MountOptions,
    context: MemoryClient.SessionOpenAuthContext,
  ): Promise<MemoryClient.SessionOpenAuth> {
    const iat = Math.floor(Date.now() / 1000);
    const invocation = {
      iss: signer.did(),
      cmd: "session.open",
      sub: space,
      aud: context.audience,
      args: {
        protocol: MEMORY_PROTOCOL,
        session,
      },
      challenge: context.challenge.value,
      iat,
      exp: iat + SESSION_OPEN_TTL_SECONDS,
    };
    const signature = await signer.sign(hashOf(invocation).bytes);
    if (signature.error) {
      throw signature.error;
    }
    return {
      invocation,
      authorization: {
        // The signature travels as a `FabricBytes` -- the proper fabric form
        // for a byte sequence, which serializes to a compact `/Bytes@1` wire
        // form and round-trips faithfully. The server's `toByteArray` accepts
        // it.
        signature: new FabricBytes(signature.ok),
      },
    };
  }

  async create(
    space: MemorySpace,
    signer = this.defaultSigner,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const client = await MemoryClient.connect({
      transport: new WebSocketTransport(
        toSpaceWebSocketAddress(this.resolveAddress(space), space),
      ),
    });
    const session = await client.mount(
      space,
      mountOptions,
      (
        targetSpace: string,
        descriptor: MemoryClient.MountOptions,
        context: MemoryClient.SessionOpenAuthContext,
      ) =>
        this.#createSessionOpenAuth(
          signer,
          targetSpace as MemorySpace,
          descriptor,
          context,
        ),
    );
    return { client, session };
  }
}
