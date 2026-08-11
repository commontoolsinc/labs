import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { type MemorySpace, type Signer } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { MEMORY_PROTOCOL } from "@commonfabric/memory/v2";
import { normalizeSpaceHost, SpaceHostValidationError } from "../space-host.ts";

export interface SessionFactory {
  /** Opt in to StorageManager's ACL genesis handshake. Scripted factories used
   *  by lower-level replica tests omit this because they intentionally model
   *  only the messages under test. */
  readonly supportsAclBootstrap?: boolean;
  create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions?: MemoryClient.MountOptions,
    signal?: AbortSignal,
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
 * Resolves a shared HTTP or HTTPS space host to the memory storage endpoint.
 * Space hosts also serve compute requests, so WebSocket-only URLs are not
 * valid routes.
 */
export const storageAddressForHost = (host: string | URL): URL => {
  return new URL(MEMORY_STORAGE_PATH, normalizeSpaceHost(host));
};

const storageAddressForMemoryHost = (host: URL): URL => {
  const parsed = new URL(host);
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:"
  ) {
    throw new TypeError(
      `Unsupported memory host protocol: ${parsed.protocol}`,
    );
  }
  return new URL(MEMORY_STORAGE_PATH, parsed);
};

/**
 * Validity window stamped onto each signed `session.open`.
 * `session.open` is a live handshake sent when a connection opens, so a few
 * minutes covers clock skew and round-trip time while bounding replay.
 */
export const SESSION_OPEN_TTL_SECONDS = 300;

/**
 * Builds the per-space storage-endpoint resolver: a space present in
 * `spaceHostMap` resolves against that host's origin, everything else
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
   * Late-bound host hints mapping a space DID to an HTTP or HTTPS origin.
   * Learned at runtime, e.g. from the home-space site table. Consulted AFTER the
   * seed map and BEFORE the default. The caller keeps the first accepted
   * hint stable, including after the space opens.
   */
  dynamicHosts?: ReadonlyMap<string, string>,
): (space: MemorySpace) => URL => {
  const overrides = new Map<string, URL>();
  for (const [space, host] of Object.entries(spaceHostMap ?? {})) {
    let route: URL;
    try {
      route = normalizeSpaceHost(host);
    } catch (cause) {
      if (!(cause instanceof SpaceHostValidationError)) throw cause;
      throw new Error(
        `Invalid spaceHostMap entry for ${space}`,
        { cause },
      );
    }
    overrides.set(space, new URL(MEMORY_STORAGE_PATH, route));
  }
  const fallback = storageAddressForMemoryHost(defaultHost);
  return (space) => {
    const seeded = overrides.get(space);
    if (seeded) return new URL(seeded);
    const dynamic = dynamicHosts?.get(space);
    if (dynamic) return storageAddressForHost(dynamic);
    return new URL(fallback);
  };
};

export class WebSocketTransport implements MemoryClient.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #socket: WebSocket | null = null;
  #opening: Promise<WebSocket> | null = null;

  constructor(private readonly address: URL) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  async send(payload: string): Promise<void> {
    const socket = await this.open();
    socket.send(payload);
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#opening = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
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
  }

  private async open(): Promise<WebSocket> {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      return this.#socket;
    }
    if (this.#opening) {
      return await this.#opening;
    }
    const address = toWebSocketAddress(this.address);
    const opening = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(address);
      this.#socket = socket;
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        resolve(socket);
      }, { once: true });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          this.#receiver(event.data);
        }
      });
      socket.addEventListener("close", () => {
        if (this.#socket === socket) {
          this.#socket = null;
        }
        if (this.#opening === opening) {
          this.#opening = null;
        }
        this.#closeReceiver();
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
        this.#closeReceiver(
          event instanceof ErrorEvent && event.error instanceof Error
            ? event.error
            : new Error("memory websocket transport error"),
        );
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
    signal?: AbortSignal,
  ) {
    const transport = new WebSocketTransport(
      toSpaceWebSocketAddress(this.resolveAddress(space), space),
    );
    let client: MemoryClient.Client | undefined;
    const abortError = (): Error =>
      signal?.reason instanceof Error
        ? signal.reason
        : new Error("memory replica route replaced");

    try {
      if (signal?.aborted) throw abortError();
      client = await MemoryClient.connect({ transport, signal });
      const closeForAbort = (): void => {
        void client?.close().catch(() => {});
      };
      signal?.addEventListener("abort", closeForAbort, { once: true });
      if (signal?.aborted) throw abortError();
      try {
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
          signal,
        );
        if (signal?.aborted) throw abortError();
        return { client, session };
      } finally {
        signal?.removeEventListener("abort", closeForAbort);
      }
    } catch (error) {
      await (client?.close() ?? transport.close()).catch(() => {});
      throw signal?.aborted ? abortError() : error;
    }
  }
}
