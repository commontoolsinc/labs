import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  encodeMemoryBoundary,
  type HelloOkMessage,
  type ResponseMessage,
  type SessionOpenRequest,
  type V2Error,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  parseClientMessage,
  type Server,
} from "@commonfabric/memory/v2/server";
import type { BranchName } from "@commonfabric/memory/v2";
import { type Options, type SessionFactory, StorageManager } from "./v2.ts";

type ProviderPortMessage =
  | { type: "memory"; payload: string }
  | { type: "close"; message?: string };

export interface HostProviderChannelOptions {
  server: Server;
  space: MemorySpace;
  branch?: BranchName;
  /** Host-owned grant creation. This callback and its credentials never cross
   *  the MessagePort into the Worker. */
  authorizeSessionOpen: MemoryClient.SessionOpenAuthFactory;
}

export interface HostProviderChannel {
  /** Opaque endpoint transferred to the executor Worker. */
  readonly port: MessagePort;
  dispose(): Promise<void>;
}

const responseError = (
  requestId: string,
  name: string,
  message: string,
): ResponseMessage<never> => ({
  type: "response",
  requestId,
  error: { name, message },
});

const requestIdOf = (message: unknown): string =>
  typeof message === "object" && message !== null &&
    "requestId" in message &&
    typeof (message as { requestId?: unknown }).requestId === "string"
    ? (message as { requestId: string }).requestId
    : "host-provider";

const messageSpace = (message: ReturnType<typeof parseClientMessage>) =>
  message !== null && "space" in message ? message.space : undefined;

/**
 * Normalize every branch-bearing request onto the host-owned lane. Messages
 * without a branch surface (session lifecycle and SQLite v1) remain bound by
 * the exact space and authenticated connection.
 */
const pinBranch = (
  message: NonNullable<ReturnType<typeof parseClientMessage>>,
  branch: BranchName,
): NonNullable<ReturnType<typeof parseClientMessage>> => {
  switch (message.type) {
    case "transact":
      return {
        ...message,
        commit: { ...message.commit, branch },
      };
    case "graph.query":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "scheduler.snapshot.list":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "scheduler.writer.list":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "session.watch.set":
    case "session.watch.add":
      return {
        ...message,
        watches: message.watches.map((watch) => ({
          ...watch,
          query: { ...watch.query, branch },
        })),
      };
    default:
      return message;
  }
};

/**
 * Create the host half of an executor provider. All memory frames still enter
 * through Server.connect/Connection.receive, preserving handshake ordering,
 * session ownership, ACL/CFC/conflict checks, and post-commit hooks. The host
 * overwrites session.open authorization with its own grant callback.
 */
export function createHostProviderChannel(
  options: HostProviderChannelOptions,
): HostProviderChannel {
  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const branch = options.branch ?? "";
  let authContext: MemoryClient.SessionOpenAuthContext | null = null;
  let disposed = false;
  let receiving = Promise.resolve();

  const connection = options.server.connect((message) => {
    if (disposed) return;
    if (message.type === "hello.ok") {
      const hello = message as HelloOkMessage;
      if (hello.sessionOpen !== undefined) {
        authContext = hello.sessionOpen;
      }
    }
    hostPort.postMessage(
      {
        type: "memory",
        payload: encodeMemoryBoundary(message),
      } satisfies ProviderPortMessage,
    );
  });

  const closeHost = (message?: string) => {
    if (disposed) return;
    disposed = true;
    connection.close();
    if (message !== undefined) {
      try {
        hostPort.postMessage(
          { type: "close", message } satisfies ProviderPortMessage,
        );
      } catch {
        // The Worker may already have closed its transferred endpoint.
      }
    }
    hostPort.close();
  };

  const sendError = (requestId: string, error: V2Error) => {
    if (disposed) return;
    hostPort.postMessage(
      {
        type: "memory",
        payload: encodeMemoryBoundary(
          responseError(requestId, error.name, error.message),
        ),
      } satisfies ProviderPortMessage,
    );
  };

  const receive = async (payload: string): Promise<void> => {
    const parsed = parseClientMessage(payload);
    if (parsed === null) {
      // Let the canonical parser produce its normal InvalidMessageError.
      await connection.receive(payload);
      return;
    }
    const requestedSpace = messageSpace(parsed);
    if (requestedSpace !== undefined && requestedSpace !== options.space) {
      sendError(requestIdOf(parsed), {
        name: "AuthorizationError",
        message: `executor provider is bound to ${options.space}`,
      });
      return;
    }
    if (parsed.type === "session.open") {
      if (authContext === null) {
        sendError(parsed.requestId, {
          name: "ProtocolError",
          message: "executor provider has no active session challenge",
        });
        return;
      }
      let auth: MemoryClient.SessionOpenAuth | undefined;
      try {
        auth = await options.authorizeSessionOpen(
          parsed.space,
          parsed.session,
          authContext,
        );
      } catch (error) {
        sendError(parsed.requestId, {
          name: "AuthorizationError",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (auth === undefined) {
        sendError(parsed.requestId, {
          name: "AuthorizationError",
          message: "executor provider host did not grant the session",
        });
        return;
      }
      const authenticated: SessionOpenRequest = {
        ...parsed,
        invocation: auth.invocation,
        authorization: auth
          .authorization as SessionOpenRequest["authorization"],
      };
      await connection.receive(encodeMemoryBoundary(authenticated));
      return;
    }
    await connection.receive(encodeMemoryBoundary(pinBranch(parsed, branch)));
  };

  hostPort.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<ProviderPortMessage>;
    if (message.type === "close") {
      closeHost();
      return;
    }
    if (message.type !== "memory" || typeof message.payload !== "string") {
      closeHost("invalid executor provider message");
      return;
    }
    receiving = receiving.then(
      () => receive(message.payload!),
      () => receive(message.payload!),
    ).catch((error) => {
      closeHost(error instanceof Error ? error.message : String(error));
    });
  });
  hostPort.addEventListener("messageerror", () => {
    closeHost("executor provider message decoding failed");
  });
  hostPort.start();

  return {
    port: channel.port2,
    async dispose() {
      closeHost();
      await receiving.catch(() => undefined);
    },
  };
}

class MessagePortTransport implements MemoryClient.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #closed = false;

  constructor(private readonly port: MessagePort) {
    port.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data as Partial<ProviderPortMessage>;
      if (message.type === "memory" && typeof message.payload === "string") {
        this.#receiver(message.payload);
      } else if (message.type === "close") {
        this.closeFromHost(message.message);
      } else {
        this.closeFromHost("invalid host provider message");
      }
    });
    port.addEventListener("messageerror", () => {
      this.closeFromHost("host provider message decoding failed");
    });
    port.start();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("executor provider transport closed"));
    }
    this.port.postMessage(
      { type: "memory", payload } satisfies ProviderPortMessage,
    );
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    try {
      this.port.postMessage({ type: "close" } satisfies ProviderPortMessage);
    } finally {
      this.port.close();
    }
    return Promise.resolve();
  }

  private closeFromHost(message?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.port.close();
    this.#closeReceiver(new Error(message ?? "executor provider host closed"));
  }
}

class HostSessionFactory implements SessionFactory {
  constructor(
    private readonly port: MessagePort,
    private readonly space: MemorySpace,
  ) {}

  async create(
    space: MemorySpace,
    _signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    if (space !== this.space) {
      throw new Error(`executor provider is bound to ${this.space}`);
    }
    const client = await MemoryClient.connect({
      transport: new MessagePortTransport(this.port),
    });
    const session = await client.mount(space, mountOptions);
    return { client, session };
  }
}

const opaquePrincipal = (principal: MemorySpace): Signer => {
  const unavailable = () => ({
    error: new Error("executor provider principal has no Worker signing key"),
  });
  return {
    did: () => principal,
    sign: unavailable,
    verifier: {
      did: () => principal,
      verify: unavailable,
    },
  } as Signer;
};

export interface HostStorageManagerOptions {
  port: MessagePort;
  principal: MemorySpace;
  space: MemorySpace;
  id?: string;
  settings?: Options["settings"];
}

/** StorageManager construction available inside the executor Worker. */
export class HostStorageManager extends StorageManager {
  static connect(options: HostStorageManagerOptions): HostStorageManager {
    const as = opaquePrincipal(options.principal);
    return new HostStorageManager(
      {
        as,
        id: options.id,
        settings: options.settings,
        // The host channel is already pinned to the memory Server.
        memoryHost: new URL("memory://executor-provider"),
      },
      new HostSessionFactory(options.port, options.space),
    );
  }
}
