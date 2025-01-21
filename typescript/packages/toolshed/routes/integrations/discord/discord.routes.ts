import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Discord Integration"];

export const sendMessage = createRoute({
  path: "/api/integrations/discord/messages",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              channel: z
                .string()
                .min(1)
                .describe("The channel name to send to"),
              message: z.string().min(1).describe("The message to send"),
              username: z
                .string()
                .optional()
                .describe("Optional username override"),
              avatar_url: z
                .string()
                .optional()
                .describe("Optional avatar URL override"),
            })
            .openapi({
              example: {
                channel: "general",
                message: "Hello Discord!",
                username: "Bot",
              },
            }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            channel_id: z.string(),
            timestamp: z.string(),
          }),
        },
      },
      description: "Message sent successfully",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Server error",
    },
  },
});
export type SendMessageRoute = typeof sendMessage;
