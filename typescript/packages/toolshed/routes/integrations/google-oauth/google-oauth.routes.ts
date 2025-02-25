import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Google OAuth Integration"];

export const login = createRoute({
  path: "/api/integrations/google-oauth/login",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              authCellId: z.string().describe("The authentication cell ID"),
            })
            .openapi({
              example: {
                authCellId: "auth-cell-123",
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
          schema: z.union([
            z.object({
              url: z.string().describe("The OAuth URL to redirect to"),
            }),
            z.object({
              error: z.string(),
            }),
          ]),
        },
      },
      description: "OAuth URL response",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export const callback = createRoute({
  path: "/api/integrations/google-oauth/callback",
  method: "get",
  tags,
  request: {
    query: z.object({
      code: z.string().optional().describe("Authorization code from Google"),
      state: z.string().optional().describe("State parameter containing the authCellId"),
      scope: z.string().optional().describe("Granted scopes"),
      error: z.string().optional().describe("Error message if authorization failed"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "text/html": {
          schema: z.any().describe("HTML response with callback handling"),
        },
        "application/json": {
          schema: z.union([
            z.object({
              success: z.boolean(),
              message: z.string(),
              details: z.record(z.unknown()).optional(),
            }),
            z.object({
              error: z.string(),
            }),
          ]),
        },
      },
      description: "OAuth callback response",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
        "text/html": {
          schema: z.any().describe("HTML response with error handling"),
        },
      },
      description: "Invalid callback parameters",
    },
  },
});

export type LoginRoute = typeof login;
export type CallbackRoute = typeof callback;
