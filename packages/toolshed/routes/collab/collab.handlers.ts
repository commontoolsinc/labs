import type { AppRouteHandler } from "@/lib/types.ts";
import type * as Routes from "./collab.routes.ts";
import { createSpan } from "@/middlewares/opentelemetry.ts";
import * as YjsServer from "./yjs-server.ts";
import * as HttpStatusCodes from "stoker/http-status-codes";

/**
 * Handle WebSocket upgrade for collaborative editing
 */
export const websocket: AppRouteHandler<typeof Routes.websocket> = (c) => {
  return createSpan("collab.websocket", (span) => {
    try {
      const { roomId } = c.req.valid("param");
      span.setAttribute("collab.roomId", roomId);
      span.setAttribute("collab.operation", "websocket_upgrade");

      // Upgrade to WebSocket
      const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
      span.setAttribute("websocket.upgrade", "success");

      // Handle the connection in the Yjs server
      YjsServer.handleConnection(socket, roomId);

      return response;
    } catch (error) {
      span.setAttribute("collab.status", "exception");
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

/**
 * Get collaboration service statistics
 */
export const stats: AppRouteHandler<typeof Routes.stats> = (c) => {
  return createSpan("collab.stats", (span) => {
    span.setAttribute("collab.operation", "stats");
    const stats = YjsServer.getStats();
    span.setAttribute("collab.rooms", stats.rooms);
    span.setAttribute("collab.clients", stats.totalClients);
    return c.json(stats, HttpStatusCodes.OK);
  });
};

/**
 * Initialize a room with content
 */
export const initialize: AppRouteHandler<typeof Routes.initialize> = async (
  c,
) => {
  return await createSpan("collab.initialize", async (span) => {
    try {
      const { roomId } = c.req.valid("param");
      const body = await c.req.valid("json");

      span.setAttribute("collab.roomId", roomId);
      span.setAttribute("collab.operation", "initialize");
      span.setAttribute("collab.contentType", body.type);

      YjsServer.initializeRoomContent(roomId, body.content, body.type);

      span.setAttribute("collab.status", "success");
      return c.json({ success: true, roomId }, HttpStatusCodes.OK);
    } catch (error) {
      span.setAttribute("collab.status", "exception");
      span.setAttribute(
        "error.message",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });
};
