import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Webhooks"];

export const create = createRoute({
  path: "/api/webhooks",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().describe("Human-readable label for the webhook"),
              cellLink: z
                .string()
                .describe("Serialized cell link JSON for the target cell"),
              mode: z
                .enum(["replace", "append"])
                .default("replace")
                .describe("Write mode: replace cell value or append to array"),
            })
            .openapi({
              example: {
                name: "GitHub Push Events",
                cellLink:
                  '{"/" : {"link-v0.1" : {"id" : "of:bafe...", "space" : "did:key:bafe...", "path" : ["webhooks", "github"]}}}',
                mode: "append",
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
            url: z.string(),
            secret: z.string(),
            name: z.string(),
            mode: z.enum(["replace", "append"]),
          }),
        },
      },
      description: "Webhook created successfully. Secret is shown only once.",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export const ingest = createRoute({
  path: "/api/webhooks/:id",
  method: "post",
  tags,
  request: {
    params: z.object({
      id: z.string().describe("Webhook ID"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({ received: z.boolean() }),
        },
      },
      description: "Payload received and written to cell",
    },
    [HttpStatusCodes.UNAUTHORIZED]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Invalid or missing bearer token",
    },
    [HttpStatusCodes.NOT_FOUND]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Webhook not found",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Invalid payload",
    },
  },
});

export const list = createRoute({
  path: "/api/webhooks",
  method: "get",
  tags,
  request: {
    query: z.object({
      space: z.string().describe("Space DID to list webhooks for"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            webhooks: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                cellLink: z.string(),
                enabled: z.boolean(),
                mode: z.enum(["replace", "append"]),
                createdAt: z.string(),
                createdBy: z.string(),
                lastReceivedAt: z.string().optional(),
                deliveryCount: z.number(),
              }),
            ),
          }),
        },
      },
      description: "List of webhooks for the space",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Missing space parameter",
    },
  },
});

export const remove = createRoute({
  path: "/api/webhooks/:id",
  method: "delete",
  tags,
  request: {
    params: z.object({
      id: z.string().describe("Webhook ID to delete"),
    }),
    query: z.object({
      space: z.string().describe("Space DID the webhook belongs to"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.boolean() }),
        },
      },
      description: "Webhook deleted successfully",
    },
    [HttpStatusCodes.NOT_FOUND]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Webhook not found",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Missing space parameter",
    },
  },
});

export type CreateRoute = typeof create;
export type IngestRoute = typeof ingest;
export type ListRoute = typeof list;
export type RemoveRoute = typeof remove;
