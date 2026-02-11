/**
 * Memory v2 HTTP and WebSocket Handlers
 *
 * Handles transact, query, and WebSocket subscribe commands for the v2
 * memory protocol. Commands use plain JSON (no UCAN wrapping for MVP).
 *
 * @module v2-memory.handlers
 */

import type { AppRouteHandler } from "@/lib/types.ts";
import type * as Routes from "./v2-memory.routes.ts";
import { v2MemoryService } from "./v2-memory-service.ts";
import type {
  InvocationId,
  QueryCommand,
  SubscribeCommand,
  TransactCommand,
  UnsubscribeCommand,
} from "@commontools/memory/v2-protocol";
import type { TransactArgs } from "./v2-memory-service.ts";
import { createSpan } from "@/middlewares/opentelemetry.ts";

// ---------------------------------------------------------------------------
// HTTP: transact
// ---------------------------------------------------------------------------

export const transact: AppRouteHandler<typeof Routes.transact> = async (c) => {
  return await createSpan("v2.memory.transact", async (span) => {
    try {
      const body = await c.req.valid("json");
      const spaceId = body.sub;

      span.setAttribute("memory.v2.operation", "transact");
      span.setAttribute("memory.v2.space", spaceId);
      span.setAttribute(
        "memory.v2.operations_count",
        body.args.operations.length,
      );

      const result = v2MemoryService.transact(
        spaceId,
        body.args as unknown as TransactArgs,
      );

      if ("ok" in result) {
        span.setAttribute("memory.v2.status", "success");
        span.setAttribute("memory.v2.version", result.ok.version);
        return c.json({ ok: result.ok }, 200);
      } else {
        span.setAttribute("memory.v2.status", "conflict");
        return c.json(
          {
            error: {
              name: "ConflictError" as const,
              conflicts: result.error.conflicts,
              message: result.error.message,
            },
          },
          409,
        );
      }
    } catch (cause) {
      const { message, stack, name } = (cause ?? new Error()) as Error;
      span.setAttribute("memory.v2.status", "exception");
      span.setAttribute("error.message", message);
      span.setAttribute("error.type", name);
      return c.json({ error: { name, message, stack } }, 500);
    }
  });
};

// ---------------------------------------------------------------------------
// HTTP: query
// ---------------------------------------------------------------------------

export const query: AppRouteHandler<typeof Routes.query> = async (c) => {
  return await createSpan("v2.memory.query", async (span) => {
    try {
      const body = await c.req.valid("json");
      const spaceId = body.sub;

      span.setAttribute("memory.v2.operation", "query");
      span.setAttribute("memory.v2.space", spaceId);

      const result = v2MemoryService.query(spaceId, {
        select: body.args.select,
        since: body.args.since,
        branch: body.args.branch,
      });

      span.setAttribute("memory.v2.status", "success");
      span.setAttribute(
        "memory.v2.result_count",
        Object.keys(result).length,
      );
      return c.json({ ok: result }, 200);
    } catch (cause) {
      const { message, stack, name } = (cause ?? new Error()) as Error;
      span.setAttribute("memory.v2.status", "exception");
      span.setAttribute("error.message", message);
      span.setAttribute("error.type", name);
      return c.json({ error: { name, message, stack } }, 500);
    }
  });
};

// ---------------------------------------------------------------------------
// WebSocket: subscribe
// ---------------------------------------------------------------------------

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = (c) => {
  return createSpan("v2.memory.subscribe", (span) => {
    try {
      span.setAttribute("memory.v2.operation", "subscribe");

      const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

      // Track the space ID for this socket. Set on first command.
      let currentSpaceId: string | undefined;

      socket.onopen = () => {
        span.setAttribute("websocket.v2.status", "open");
      };

      socket.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);
          handleWebSocketCommand(socket, msg, (spaceId) => {
            if (!currentSpaceId) {
              currentSpaceId = spaceId;
              v2MemoryService.registerClient(spaceId, socket);
            }
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          socket.send(
            JSON.stringify({
              error: { name: "ParseError", message: errorMsg },
            }),
          );
        }
      };

      socket.onclose = () => {
        if (currentSpaceId) {
          v2MemoryService.removeClient(currentSpaceId, socket);
        }
      };

      socket.onerror = (event) => {
        span.setAttribute("websocket.v2.error", String(event));
        if (currentSpaceId) {
          v2MemoryService.removeClient(currentSpaceId, socket);
        }
      };

      return response;
    } catch (error) {
      span.setAttribute("memory.v2.status", "exception");
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

// ---------------------------------------------------------------------------
// WebSocket command dispatch
// ---------------------------------------------------------------------------

function handleWebSocketCommand(
  ws: WebSocket,
  msg: Record<string, unknown>,
  onSpace: (spaceId: string) => void,
): void {
  // Support both bare commands and UCAN-wrapped commands
  const cmd = msg.invocation
    ? (msg.invocation as Record<string, unknown>)
    : msg;

  const ability = cmd.cmd as string;
  const spaceId = cmd.sub as string;
  // Preserve the envelope id for response correlation
  const requestId = msg.id as string | undefined;

  if (!ability || !spaceId) {
    ws.send(
      JSON.stringify({
        error: {
          name: "InvalidCommand",
          message: "Missing cmd or sub field",
        },
      }),
    );
    return;
  }

  onSpace(spaceId);

  switch (ability) {
    case "/memory/transact":
      handleWsTransact(
        ws,
        spaceId,
        cmd as unknown as TransactCommand,
        requestId,
      );
      break;
    case "/memory/query":
      handleWsQuery(ws, spaceId, cmd as unknown as QueryCommand, requestId);
      break;
    case "/memory/query/subscribe":
      handleWsSubscribe(ws, spaceId, cmd as unknown as SubscribeCommand);
      break;
    case "/memory/query/unsubscribe":
      handleWsUnsubscribe(
        ws,
        spaceId,
        cmd as unknown as UnsubscribeCommand,
        requestId,
      );
      break;
    default:
      ws.send(
        JSON.stringify({
          error: {
            name: "UnknownCommand",
            message: `Unknown command: ${ability}`,
          },
        }),
      );
  }
}

// ---------------------------------------------------------------------------
// WebSocket command handlers
// ---------------------------------------------------------------------------

function handleWsTransact(
  ws: WebSocket,
  spaceId: string,
  cmd: TransactCommand,
  requestId?: string,
): void {
  try {
    const result = v2MemoryService.transact(spaceId, {
      reads: cmd.args.reads,
      operations: cmd.args.operations,
      branch: cmd.args.branch,
      codeCID: cmd.args.codeCID,
    });

    if ("ok" in result) {
      ws.send(JSON.stringify({ id: requestId, ok: result.ok }));
    } else {
      ws.send(
        JSON.stringify({
          id: requestId,
          error: {
            name: "ConflictError",
            conflicts: result.error.conflicts,
            message: result.error.message,
          },
        }),
      );
    }
  } catch (err) {
    ws.send(
      JSON.stringify({
        id: requestId,
        error: {
          name: err instanceof Error ? err.name : "UnknownError",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }
}

function handleWsQuery(
  ws: WebSocket,
  spaceId: string,
  cmd: QueryCommand,
  requestId?: string,
): void {
  try {
    const result = v2MemoryService.query(spaceId, {
      select: cmd.args.select,
      since: cmd.args.since,
      branch: cmd.args.branch,
    });
    ws.send(JSON.stringify({ id: requestId, ok: result }));
  } catch (err) {
    ws.send(
      JSON.stringify({
        id: requestId,
        error: {
          name: "QueryError",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }
}

function handleWsSubscribe(
  ws: WebSocket,
  spaceId: string,
  cmd: SubscribeCommand,
): void {
  try {
    // Derive invocation ID from nonce or generate one
    const subId: InvocationId = (cmd.nonce
      ? `job:${cmd.nonce}`
      : `job:${crypto.randomUUID()}`) as InvocationId;

    const initialState = v2MemoryService.subscribe(
      spaceId,
      {
        id: subId,
        select: cmd.args.select,
        since: cmd.args.since,
        branch: cmd.args.branch,
      },
      ws,
    );

    // Send initial state as a task/return
    ws.send(
      JSON.stringify({
        the: "task/return",
        of: subId,
        is: { ok: initialState },
      }),
    );
  } catch (err) {
    ws.send(
      JSON.stringify({
        error: {
          name: "SubscribeError",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }
}

function handleWsUnsubscribe(
  ws: WebSocket,
  spaceId: string,
  cmd: UnsubscribeCommand,
  requestId?: string,
): void {
  try {
    const sourceId = cmd.args.source;
    const removed = v2MemoryService.unsubscribe(spaceId, sourceId);
    ws.send(
      JSON.stringify({
        id: requestId,
        ok: { removed },
      }),
    );
  } catch (err) {
    ws.send(
      JSON.stringify({
        id: requestId,
        error: {
          name: "UnsubscribeError",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }
}
