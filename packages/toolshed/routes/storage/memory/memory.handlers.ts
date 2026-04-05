import type { AppRouteHandler } from "@/lib/types.ts";
import { encodeMemoryV2Boundary } from "@commonfabric/memory/v2";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type * as Routes from "./memory.routes.ts";
import { Memory, memory, memoryV2Server } from "../memory.ts";
import * as Codec from "@commonfabric/memory/codec";
import { createSpan } from "@/middlewares/opentelemetry.ts";

type NegotiatedSocketHandlers = {
  onMessage: (message: string) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
};

type NegotiationOptions = {
  maxBufferedBytes?: number;
};

const NEGOTIATION_BUFFER_MAX_BYTES = 1_048_576;
const TEXT_ENCODER = new TextEncoder();

export const bufferTextMessagesUntilNegotiated = (
  socket: WebSocket,
  options: NegotiationOptions = {},
): {
  firstMessage: Promise<string | undefined>;
  handoff: (handlers: NegotiatedSocketHandlers) => void;
  dispose: () => void;
} => {
  const maxBufferedBytes = options.maxBufferedBytes ??
    NEGOTIATION_BUFFER_MAX_BYTES;
  let settled = false;
  let bufferedMessages: string[] = [];
  let bufferedBytes = 0;
  let cleanup = () => {};
  let handlers: NegotiatedSocketHandlers | null = null;
  let negotiationError: Error | null = null;

  const forwardMessage = (message: string) => {
    if (handlers === null) {
      if (negotiationError !== null) {
        return;
      }
      const messageBytes = TEXT_ENCODER.encode(message).byteLength;
      if (bufferedBytes + messageBytes > maxBufferedBytes) {
        negotiationError = new Error(
          "Memory websocket negotiation buffer exceeded",
        );
        bufferedMessages = [];
        bufferedBytes = 0;
        try {
          socket.close(1009, negotiationError.message);
        } catch {
          // Ignore close races with the peer.
        }
        return;
      }
      bufferedBytes += messageBytes;
      bufferedMessages.push(message);
      return;
    }
    handlers.onMessage(message);
  };

  const firstMessage = new Promise<string | undefined>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        if (!settled) {
          cleanup();
          reject(new Error("Memory websocket expects text frames"));
        } else {
          handlers?.onError?.(
            new Error("Memory websocket expects text frames"),
          );
        }
        return;
      }

      if (!settled) {
        settled = true;
        resolve(event.data);
        return;
      }

      forwardMessage(event.data);
    };

    const onClose = () => {
      cleanup();
      if (!settled) {
        settled = true;
        resolve(undefined);
        return;
      }
      handlers?.onClose?.();
    };

    const onError = () => {
      cleanup();
      if (!settled) {
        reject(new Error("Memory websocket failed before negotiation"));
        return;
      }
      handlers?.onError?.(new Error("Memory websocket receive failure"));
    };

    cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });

  return {
    firstMessage,
    handoff(nextHandlers) {
      handlers = nextHandlers;
      if (negotiationError !== null) {
        nextHandlers.onError?.(negotiationError);
        return;
      }
      const queued = bufferedMessages;
      bufferedMessages = [];
      bufferedBytes = 0;
      for (const message of queued) {
        nextHandlers.onMessage(message);
      }
    },
    dispose: cleanup,
  };
};

const attachSocketPipeline = (
  channel: TransformStream<string, string>,
  session: Memory.ProviderSession<Memory.Protocol>,
) => {
  channel.readable
    .pipeThrough(Codec.UCAN.fromStringStream())
    .pipeThrough(session)
    .pipeThrough(Codec.Receipt.toStringStream())
    .pipeTo(channel.writable);
};

const attachV1SocketPipeline = (
  socket: WebSocket,
  negotiation: ReturnType<typeof bufferTextMessagesUntilNegotiated>,
  firstMessage: string,
) =>
  attachSocketPipeline(
    createTextSocketChannel(socket, negotiation, [firstMessage]),
    memory.session(),
  );

const attachV2SocketPipeline = (
  socket: WebSocket,
  negotiation: ReturnType<typeof bufferTextMessagesUntilNegotiated>,
  firstMessage: string,
): boolean => {
  if (MemoryV2Server.parseClientMessage(firstMessage) === null) {
    return false;
  }

  const safeSocketClose = (code: number, reason: string) => {
    if (
      socket.readyState === WebSocket.CLOSING ||
      socket.readyState === WebSocket.CLOSED
    ) {
      return;
    }
    try {
      socket.close(code, reason);
    } catch {
      // Ignore close races with the peer.
    }
  };
  const connection = memoryV2Server.connect((message) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(encodeMemoryV2Boundary(message));
  });
  const closeConnection = () => {
    connection.close();
  };
  void (async () => {
    try {
      await connection.receive(firstMessage);
      negotiation.handoff({
        onMessage(message) {
          void connection.receive(message).catch(() => {
            safeSocketClose(1011, "Memory websocket receive failure");
            closeConnection();
          });
        },
        onClose: closeConnection,
        onError(error) {
          safeSocketClose(
            error.message === "Memory websocket expects text frames"
              ? 1003
              : 1011,
            error.message,
          );
          closeConnection();
        },
      });
    } catch {
      safeSocketClose(1011, "Memory websocket setup failure");
      closeConnection();
    }
  })();

  return true;
};

const waitForSocketOpen = async (socket: WebSocket): Promise<void> => {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Memory websocket failed to open")),
      { once: true },
    );
  });
};

const createTextSocketChannel = (
  socket: WebSocket,
  negotiation: ReturnType<typeof bufferTextMessagesUntilNegotiated>,
  prefix: readonly string[],
): TransformStream<string, string> => ({
  readable: new ReadableStream({
    start(controller) {
      for (const item of prefix) {
        controller.enqueue(item);
      }
      negotiation.handoff({
        onMessage(message) {
          controller.enqueue(message);
        },
        onClose() {
          controller.close();
        },
        onError(error) {
          controller.error(error);
        },
      });
    },
    cancel() {
      try {
        socket.close();
      } catch {
        // Ignore close races with the peer.
      }
    },
  }),
  writable: new WritableStream({
    async write(data) {
      await waitForSocketOpen(socket);
      socket.send(data);
    },
    close() {
      try {
        socket.close();
      } catch {
        // Ignore close races with the peer.
      }
    },
    abort() {
      try {
        socket.close();
      } catch {
        // Ignore close races with the peer.
      }
    },
  }),
});

export const transact: AppRouteHandler<typeof Routes.transact> = async (c) => {
  return await createSpan("memory.transact", async (span) => {
    try {
      const ucan = (await c.req.valid("json")) as Memory.UCAN<
        Memory.ConsumerInvocationFor<"/memory/transact", Memory.Protocol>
      >;

      span.setAttribute("memory.operation", "transact");

      const result = await createSpan("memory.invoke", async (invokeSpan) => {
        invokeSpan.setAttribute("memory.operation_type", "transact");
        return await memory.invoke(ucan);
      });

      if (result.ok) {
        span.setAttribute("memory.status", "success");
        return c.json(result, 200);
      } else {
        // This is ugly but without this TS inference is failing to infer that
        // types are correct
        const { error } = result;
        span.setAttribute("memory.status", "error");
        span.setAttribute("memory.error_type", error.name);
        if (error.name === "ConflictError") {
          return c.json({ error }, 409);
        } else if (error.name === "AuthorizationError") {
          return c.json({ error }, 401);
        } else {
          return c.json({ error }, 503);
        }
      }
    } catch (cause) {
      const { message, name } = (cause ?? new Error()) as Error;
      span.setAttribute("memory.status", "exception");
      span.setAttribute("error.message", message);
      span.setAttribute("error.type", name);
      return c.json(
        Memory.Provider.jsonErrorBody(cause, "Transaction failed"),
        500,
      );
    }
  });
};

export const query: AppRouteHandler<typeof Routes.query> = async (c) => {
  return await createSpan("memory.query", async (span) => {
    try {
      const ucan = (await c.req.valid("json")) as Memory.UCAN<
        Memory.ConsumerInvocationFor<"/memory/query", Memory.Protocol>
      >;

      span.setAttribute("memory.operation", "query");

      const result = await createSpan("memory.invoke", async (invokeSpan) => {
        invokeSpan.setAttribute("memory.operation_type", "query");
        return await memory.invoke(ucan);
      });

      if (result.ok) {
        span.setAttribute("memory.status", "success");
        return c.json({ ok: result.ok }, 200);
      } else {
        span.setAttribute("memory.status", "error");
        span.setAttribute("memory.error_type", result.error.name);
        if (result.error.name === "AuthorizationError") {
          return c.json({ error: result.error }, 401);
        } else {
          return c.json({ error: result.error }, 503);
        }
      }
    } catch (cause) {
      const { message, name } = (cause ?? new Error()) as Error;
      span.setAttribute("memory.status", "exception");
      span.setAttribute("error.message", message);
      span.setAttribute("error.type", name);
      return c.json(
        Memory.Provider.jsonErrorBody(cause, "Query failed"),
        500,
      );
    }
  });
};

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = (c) => {
  return createSpan("memory.subscribe", (span) => {
    try {
      span.setAttribute("memory.operation", "subscribe");

      const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
      span.setAttribute("websocket.upgrade", "success");

      void createSpan("memory.socket.setup", async (setupSpan) => {
        const negotiation = bufferTextMessagesUntilNegotiated(socket);
        const firstMessage = await negotiation.firstMessage;
        if (firstMessage === undefined) {
          negotiation.dispose();
          setupSpan.setAttribute("socket.setup", "closed-before-message");
          return;
        }

        if (attachV2SocketPipeline(socket, negotiation, firstMessage)) {
          setupSpan.setAttribute("socket.setup", "memory-v2");
          return;
        }

        attachV1SocketPipeline(socket, negotiation, firstMessage);
        setupSpan.setAttribute("socket.setup", "memory-v1");
      }).catch(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.close(1011, "Memory websocket setup failure");
          } catch {
            // Ignore close races with the peer.
          }
        }
      });

      return response;
    } catch (error) {
      span.setAttribute("memory.status", "exception");
      span.setAttribute(
        "error.message",
        error instanceof Error ? error.message : String(error),
      );
      span.setAttribute(
        "error.type",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw error;
    }
  });
};
