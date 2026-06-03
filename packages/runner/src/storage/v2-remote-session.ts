import { hashOf } from "@commonfabric/data-model/value-hash";
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

/**
 * Opt-in session resume hook. When provided, the factory mounts with a
 * client-supplied `sessionId` so server-side `perSession` state persists
 * across separate client lifecycles (e.g. separate CLI invocations).
 *
 * The server rotates `sessionToken` on every mount and throws `revokedError`
 * if a still-live `sessionId` is reused without the matching token, so the
 * resumed token must be persisted via `onToken` and replayed via `getToken`.
 */
export interface SessionResume {
  id: string;
  getToken?: () => string | undefined;
  onToken?: (token: string | undefined) => void;
}

export class RemoteSessionFactory implements SessionFactory {
  constructor(
    private readonly address: URL,
    private readonly defaultSigner: Signer,
    private readonly resume?: SessionResume,
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
        signature: signature.ok,
      },
    };
  }

  async create(space: MemorySpace, signer = this.defaultSigner) {
    const client = await MemoryClient.connect({
      transport: new WebSocketTransport(
        toSpaceWebSocketAddress(this.address, space),
      ),
    });
    // Default behavior (no resume hook): mount with empty options so the
    // server mints a fresh session id per client lifecycle.
    let mountOptions: MemoryClient.MountOptions = {};
    if (this.resume) {
      const sessionToken = this.resume.getToken?.();
      mountOptions = {
        sessionId: this.resume.id,
        ...(sessionToken !== undefined ? { sessionToken } : {}),
      };
    }
    const session = await client.mount(
      space,
      mountOptions,
      (targetSpace: string, descriptor: MemoryClient.MountOptions) =>
        this.#createSessionOpenAuth(
          signer,
          targetSpace as MemorySpace,
          descriptor,
        ),
    );
    // Persist the rotated token so the next mount with the same sessionId can
    // replay it and avoid the server's revokedError.
    this.resume?.onToken?.(session.sessionToken);
    return { client, session };
  }
}
