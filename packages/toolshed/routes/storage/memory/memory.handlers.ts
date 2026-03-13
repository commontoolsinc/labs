import type { AppRouteHandler } from "@/lib/types.ts";
import type * as Routes from "./memory.routes.ts";
import { Memory, memory, memoryV2Server } from "../memory.ts";
import * as Codec from "@commontools/memory/codec";
import { createSpan } from "@/middlewares/opentelemetry.ts";
import * as HttpStatusCodes from "stoker/http-status-codes";

const readFirstSocketMessage = async (
  socket: WebSocket,
): Promise<string | undefined> => {
  return await new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      if (typeof event.data !== "string") {
        reject(new Error("Memory websocket expects text frames"));
        return;
      }
      resolve(event.data);
    };
    const onError = () => {
      cleanup();
      reject(new Error("Memory websocket failed before negotiation"));
    };
    const onClose = () => {
      cleanup();
      resolve(undefined);
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };

    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
};

const attachSocketPipeline = (
  socket: WebSocket,
  session: Memory.ProviderSession<Memory.Protocol>,
  firstMessages: readonly string[] = [],
) => {
  const { readable, writable } = Memory.Socket.fromWithPrefix<string, string>(
    socket,
    firstMessages,
  );

  readable
    .pipeThrough(Codec.UCAN.fromStringStream())
    .pipeThrough(session)
    .pipeThrough(Codec.Receipt.toStringStream())
    .pipeTo(writable);
};

const attachV1SocketPipeline = (socket: WebSocket, firstMessage: string) =>
  attachSocketPipeline(socket, memory.session(), [firstMessage]);

const attachV2SocketPipeline = async (
  socket: WebSocket,
  firstMessage: string,
): Promise<boolean> => {
  if (Memory.V2Server.parseClientMessage(firstMessage) === null) {
    return false;
  }

  const connection = memoryV2Server.connect((message) => {
    socket.send(JSON.stringify(message));
  });
  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") {
      socket.close(1003, "Memory websocket expects text frames");
      return;
    }
    void connection.receive(event.data);
  };
  const onClose = () => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onClose);
    connection.close();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose, { once: true });
  socket.addEventListener("error", onClose, { once: true });
  await connection.receive(firstMessage);

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
        const firstMessage = await readFirstSocketMessage(socket);
        if (firstMessage === undefined) {
          setupSpan.setAttribute("socket.setup", "closed-before-message");
          return;
        }

        if (await attachV2SocketPipeline(socket, firstMessage)) {
          setupSpan.setAttribute("socket.setup", "memory-v2");
          return;
        }

        attachV1SocketPipeline(socket, firstMessage);
        setupSpan.setAttribute("socket.setup", "memory-v1");
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

export const putBlob: AppRouteHandler<typeof Routes.putBlob> = async (c) => {
  return await createSpan("memory.blob.put", async (span) => {
    const { hash } = c.req.valid("param");
    const { space } = c.req.valid("query");
    const contentType = c.req.header("content-type") ??
      "application/octet-stream";
    const value = new Uint8Array(await c.req.raw.arrayBuffer());

    span.setAttribute("memory.operation", "blob.put");
    span.setAttribute("memory.space", space);

    try {
      const result = await memoryV2Server.putBlob(space, hash, {
        value,
        contentType,
      });
      span.setAttribute("memory.status", "success");
      return new Response(null, {
        status: result.created
          ? HttpStatusCodes.CREATED
          : HttpStatusCodes.OK,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      span.setAttribute("memory.status", "error");
      span.setAttribute("error.message", message);
      span.setAttribute(
        "error.type",
        cause instanceof Error ? cause.name : "BlobError",
      );
      return c.json(
        { error: { name: "BlobError", message } },
        HttpStatusCodes.BAD_REQUEST,
      );
    }
  });
};

export const getBlob: AppRouteHandler<typeof Routes.getBlob> = async (c) => {
  return await createSpan("memory.blob.get", async (span) => {
    const { hash } = c.req.valid("param");
    const { space } = c.req.valid("query");

    span.setAttribute("memory.operation", "blob.get");
    span.setAttribute("memory.space", space);

    const blob = await memoryV2Server.getBlob(space, hash);
    if (blob === null) {
      span.setAttribute("memory.status", "not_found");
      return new Response(null, { status: HttpStatusCodes.NOT_FOUND });
    }

    span.setAttribute("memory.status", "success");
    return new Response(new Blob([Uint8Array.from(blob.value)], {
      type: blob.contentType,
    }), {
      status: HttpStatusCodes.OK,
      headers: {
        "content-type": blob.contentType,
        "content-length": String(blob.size),
      },
    });
  });
};
