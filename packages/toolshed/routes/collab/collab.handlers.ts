import type { AppRouteHandler } from "@/lib/types.ts";
import type * as Routes from "./collab.routes.ts";
import { createSpan } from "@/middlewares/opentelemetry.ts";
import * as YjsServer from "./yjs-server.ts";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { extractAuthToken, verifyCollabAuth } from "./collab.auth.ts";

/**
 * Handle WebSocket upgrade for collaborative editing
 */
export const websocket: AppRouteHandler<typeof Routes.websocket> = async (c) => {
  return await createSpan("collab.websocket", async (span) => {
    try {
      const { roomId } = c.req.valid("param");
      span.setAttribute("collab.roomId", roomId);
      span.setAttribute("collab.operation", "websocket_upgrade");

      // Extract and verify auth token if present
      const url = new URL(c.req.url);
      const token = extractAuthToken(url);

      let userIdentity: { userDid: string } | undefined;

      if (token) {
        const authResult = await verifyCollabAuth(token, roomId);
        if (authResult.error) {
          span.setAttribute("collab.auth.status", "failed");
          span.setAttribute("collab.auth.error", authResult.error.code);
          console.warn(`[collab] Auth failed for room ${roomId}: ${authResult.error.message}`);
          // For now, allow connection but log the failure
          // TODO: Return 401 when auth is required
        } else if (authResult.ok) {
          span.setAttribute("collab.auth.status", "success");
          span.setAttribute("collab.auth.userDid", authResult.ok.userDid);
          userIdentity = { userDid: authResult.ok.userDid };
          console.log(`[collab] Auth success for room ${roomId}: ${authResult.ok.userDid}`);
        }
      } else {
        span.setAttribute("collab.auth.status", "missing");
        console.warn(`[collab] No auth token for room ${roomId} - allowing anonymous connection`);
      }

      // Upgrade to WebSocket
      const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
      span.setAttribute("websocket.upgrade", "success");

      // Handle the connection in the Yjs server
      YjsServer.handleConnection(socket, roomId, userIdentity);

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
 * Initialize a Y.Text field in a room with content
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
      span.setAttribute("collab.field", body.field);

      const initialized = YjsServer.initializeTextField(roomId, body.field, body.content);

      span.setAttribute("collab.status", "success");
      span.setAttribute("collab.initialized", initialized);
      return c.json({ success: true, roomId, initialized }, HttpStatusCodes.OK);
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
