import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { type MemorySpace, type Signer } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { MEMORY_PROTOCOL } from "@commonfabric/memory/v2";

export interface SessionFactory {
  create(space: MemorySpace, signer?: Signer): Promise<{
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
 * Build the per-space storage-endpoint resolver: a space present in
 * `spaceHostMap` resolves against that host's base URL, everything else
 * against `defaultApiUrl`. Host selection lives here, next to the
 * websocket address builders, so the storage-endpoint join happens in
 * exactly one place.
 */
export const createStorageAddressResolver = (
  defaultApiUrl: URL,
  spaceHostMap?: Record<string, string>,
): (space: MemorySpace) => URL =>
(space) => new URL(MEMORY_STORAGE_PATH, spaceHostMap?.[space] ?? defaultApiUrl);

class WebSocketTransport implements MemoryClient.Transport {
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
  constructor(
    private readonly resolveAddress: (space: MemorySpace) => URL,
    private readonly defaultSigner: Signer,
  ) {}

  async #createSessionOpenAuth(
    signer: Signer,
    space: MemorySpace,
    session: MemoryClient.MountOptions,
  ): Promise<MemoryClient.SessionOpenAuth> {
    const invocation = {
      iss: signer.did(),
      cmd: "session.open",
      sub: space,
      args: {
        protocol: MEMORY_PROTOCOL,
        session,
      },
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

  async create(space: MemorySpace, signer = this.defaultSigner) {
    const client = await MemoryClient.connect({
      transport: new WebSocketTransport(
        toSpaceWebSocketAddress(this.resolveAddress(space), space),
      ),
    });
    const session = await client.mount(
      space,
      {},
      (targetSpace: string, descriptor: MemoryClient.MountOptions) =>
        this.#createSessionOpenAuth(
          signer,
          targetSpace as MemorySpace,
          descriptor,
        ),
    );
    return { client, session };
  }
}
