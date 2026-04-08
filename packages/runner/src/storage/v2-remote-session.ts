import { hashOf } from "@commonfabric/data-model/value-hash";
import { type MemorySpace, type Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { MEMORY_V2_PROTOCOL } from "@commonfabric/memory/v2";

export interface SessionFactory {
  create(space: MemorySpace, signer?: Signer): Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
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

class WebSocketTransport implements MemoryV2Client.Transport {
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
    socket.close();
    await new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.addEventListener("error", () => resolve(), { once: true });
    });
  }

  private async open(): Promise<WebSocket> {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      return this.#socket;
    }
    if (this.#opening) {
      return await this.#opening;
    }
    const address = toWebSocketAddress(this.address);
    this.#opening = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(address);
      socket.addEventListener("open", () => {
        this.#socket = socket;
        resolve(socket);
      }, { once: true });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          this.#receiver(event.data);
        }
      });
      socket.addEventListener("close", () => {
        this.#socket = null;
        this.#opening = null;
        this.#closeReceiver();
      });
      socket.addEventListener("error", (event) => {
        this.#socket = null;
        this.#opening = null;
        this.#closeReceiver(
          event instanceof ErrorEvent && event.error instanceof Error
            ? event.error
            : new Error("memory/v2 websocket transport error"),
        );
        reject(event);
      }, { once: true });
    });
    return await this.#opening;
  }
}

export class RemoteSessionFactory implements SessionFactory {
  constructor(
    private readonly address: URL,
    private readonly defaultSigner: Signer,
  ) {}

  async #createSessionOpenAuth(
    signer: Signer,
    space: MemorySpace,
    session: MemoryV2Client.MountOptions,
  ): Promise<MemoryV2Client.SessionOpenAuth> {
    const invocation = {
      iss: signer.did(),
      cmd: "session.open",
      sub: space,
      args: {
        protocol: MEMORY_V2_PROTOCOL,
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
    const client = await MemoryV2Client.connect({
      transport: new WebSocketTransport(this.address),
    });
    const session = await client.mount(
      space,
      {},
      (targetSpace: string, descriptor: MemoryV2Client.MountOptions) =>
        this.#createSessionOpenAuth(
          signer,
          targetSpace as MemorySpace,
          descriptor,
        ),
    );
    return { client, session };
  }
}
