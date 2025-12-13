import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

const tags = ["Collaboration"];

/**
 * WebSocket endpoint for collaborative editing
 *
 * Room ID format: space:entityId or just entityId
 * The room ID identifies the Cell/document being collaboratively edited.
 */
export const websocket = createRoute({
  method: "get",
  path: "/api/collab/:roomId",
  tags,
  request: {
    params: z.object({
      roomId: z.string().min(1).describe("Room ID (typically Cell entity ID)"),
    }),
    headers: z.object({
      // Connection header is a list of values that must include Upgrade
      connection: z.string().regex(/(^|\s*,\s*)Upgrade(\s*,\s*|$)/i),
      // Upgrade header is a list of values that must include websocket
      upgrade: z.string().regex(/(^|\s*,\s*)websocket(\/[^,]+)?(\s*,\s*|$)/i),
    }),
  },
  responses: {
    [HttpStatusCodes.SWITCHING_PROTOCOLS]: {
      headers: z.object({
        connection: z.literal("Upgrade"),
        upgrade: z.literal("websocket"),
        "sec-websocket-accept": z.string(),
      }),
      description: "WebSocket upgrade successful",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      description: "Invalid room ID or missing WebSocket headers",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      description: "WebSocket upgrade failed",
    },
  },
});

/**
 * Health/stats endpoint for collaboration service
 */
export const stats = createRoute({
  method: "get",
  path: "/api/collab/stats",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        rooms: z.number().describe("Number of active rooms"),
        totalClients: z.number().describe("Total connected clients"),
      }),
      "Collaboration service statistics",
    ),
  },
});

/**
 * Initialize a Y.Text field in a room with content.
 *
 * NOTE: Most clients should handle initialization on sync instead.
 * This endpoint exists for cases where content must be pre-populated
 * before any client connects.
 */
export const initialize = createRoute({
  method: "post",
  path: "/api/collab/:roomId/init",
  tags,
  request: {
    params: z.object({
      roomId: z.string().min(1).describe("Room ID"),
    }),
    body: jsonContent(
      z.object({
        field: z.string().min(1).describe("Y.Text field name to initialize"),
        content: z.string().describe("Initial text content"),
      }),
      "Field and content to initialize",
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        success: z.boolean(),
        roomId: z.string(),
        initialized: z.boolean().describe("True if content was inserted, false if field already had content"),
      }),
      "Room field initialization result",
    ),
    [HttpStatusCodes.BAD_REQUEST]: {
      description: "Invalid request",
    },
  },
});
