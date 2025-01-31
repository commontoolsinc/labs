import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import { jsonContent } from "stoker/openapi/helpers";
import * as HttpStatusCodes from "stoker/http-status-codes";

export const tags = ["Memory Storage"];

export const transact = createRoute({
  method: "patch",
  path: "/api/storage/memory",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.any(),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({}), "Successful transaction"),
    [HttpStatusCodes.CONFLICT]: jsonContent(z.object({}), "Conflict occurred"),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(z.object({}), "Storage error"),
  },
});

export const subscribe = createRoute({
  method: "get",
  path: "/api/storage/memory",
  tags,
  request: {
    headers: z.object({
      connection: z.literal("upgrade"),
      upgrade: z.literal("websocket"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      headers: z.object({
        connection: z.literal("upgrade"),
        upgrade: z.literal("websocket"),
        "sec-websocket-accept": z.string(),
        date: z.string(),
      }),
      description: "WebSocket upgrade",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      description: "Upgrade to websocket failed",
    },
  },
});
