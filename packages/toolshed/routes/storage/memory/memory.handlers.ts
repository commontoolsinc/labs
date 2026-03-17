import type { AppRouteHandler } from "@/lib/types.ts";
import * as MemoryV2Server from "@commontools/memory/v2/server";
import type * as Routes from "./memory.routes.ts";
import { Memory, memory, memoryV2Server } from "../memory.ts";
import * as Codec from "@commonfabric/memory/codec";
import { createSpan } from "@/middlewares/opentelemetry.ts";

type NegotiatedSocket = {
  firstMessage: string | undefined;
  readable: ReadableStream<string>;
  writable: WritableStream<string>;
};

const openNegotiatedSocket = async (
  socket: WebSocket,
): Promise<NegotiatedSocket> => {
  const channel = Memory.Socket.from<string, string>(socket);
  const reader = channel.readable.getReader();
  let first;
  try {
    first = await reader.read();
  } catch (_error) {
    throw new Error("Memory websocket failed before negotiation");
  }

  if (first.done) {
    return {
      firstMessage: undefined,
      readable: new ReadableStream<string>({
        start(controller) {
          controller.close();
        },
      }),
      writable: channel.writable,
    };
  }

  if (typeof first.value !== "string") {
    throw new Error("Memory websocket expects text frames");
  }

  const readable = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(first.value);
      void (async () => {
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              break;
            }
            if (typeof next.value !== "string") {
              throw new Error("Memory websocket expects text frames");
            }
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      })();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return {
    firstMessage: first.value,
    readable,
    writable: channel.writable,
  };
};

const attachSocketPipeline = (
  channel: Pick<NegotiatedSocket, "readable" | "writable">,
  session: Memory.ProviderSession<Memory.Protocol>,
) => {
  channel.readable
    .pipeThrough(Codec.UCAN.fromStringStream())
    .pipeThrough(session)
    .pipeThrough(Codec.Receipt.toStringStream())
    .pipeTo(channel.writable);
};

const attachV1SocketPipeline = (
  channel: Pick<NegotiatedSocket, "readable" | "writable">,
) => attachSocketPipeline(channel, memory.session());

const attachV2SocketPipeline = (
  socket: WebSocket,
  channel: Pick<NegotiatedSocket, "readable">,
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
    socket.send(JSON.stringify(message));
  });
  const onClose = () => {
    readable.cancel().catch(() => {});
    connection.close();
  };
  socket.addEventListener("close", onClose, { once: true });
  socket.addEventListener("error", onClose, { once: true });
  const readable = channel.readable.getReader();
  void (async () => {
    try {
      while (true) {
        const next = await readable.read();
        if (next.done) {
          break;
        }
        await connection.receive(next.value);
      }
    } catch {
      safeSocketClose(1011, "Memory websocket receive failure");
    } finally {
      onClose();
    }
  })().catch(() => {
    safeSocketClose(1011, "Memory websocket setup failure");
    onClose();
  });

  return true;
};

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
      const { message, stack, name } = (cause ?? new Error()) as Error;
      span.setAttribute("memory.status", "exception");
      span.setAttribute("error.message", message);
      span.setAttribute("error.type", name);
      return c.json({ error: { message, name, stack } }, 500);
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
      const { message, stack, name } = (cause ?? new Error()) as Error;
      span.setAttribute("memory.status", "exception");
      span.setAttribute("error.message", message);
      span.setAttribute("error.type", name);
      return c.json({ error: { message, name, stack } }, 500);
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
        const channel = await openNegotiatedSocket(socket);
        const firstMessage = channel.firstMessage;
        if (firstMessage === undefined) {
          setupSpan.setAttribute("socket.setup", "closed-before-message");
          return;
        }

        if (attachV2SocketPipeline(socket, channel, firstMessage)) {
          setupSpan.setAttribute("socket.setup", "memory-v2");
          return;
        }

        attachV1SocketPipeline(channel);
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
