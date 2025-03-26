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
              integrationCharmId: z
                .string()
                .describe("The charm ID of the integration charm"),
            })
            .openapi({
              example: {
                authCellId: "auth-cell-123",
                integrationCharmId: "integration-charm-123",
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
      state: z.string().optional().describe(
        "State parameter containing the authCellId",
      ),
      scope: z.string().optional().describe("Granted scopes"),
      error: z.string().optional().describe(
        "Error message if authorization failed",
      ),
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

export const refresh = createRoute({
  path: "/api/integrations/google-oauth/refresh",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              authCellId: z
                .string()
                .describe(
                  "The authentication cell ID containing the refresh token",
                ),
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
              success: z.boolean(),
              message: z.string(),
              tokenInfo: z
                .object({
                  expiresAt: z.number(),
                  hasRefreshToken: z.boolean(),
                })
                .optional(),
            }),
            z.object({
              error: z.string(),
            }),
          ]),
        },
      },
      description: "Token refresh response",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters or refresh token not found",
    },
    [HttpStatusCodes.UNAUTHORIZED]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Refresh token is invalid or expired",
    },
  },
});

export const logout = createRoute({
  path: "/api/integrations/google-oauth/logout",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              authCellId: z
                .string()
                .describe(
                  "The authentication cell ID to clear",
                ),
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
              success: z.boolean(),
              message: z.string(),
            }),
            z.object({
              error: z.string(),
            }),
          ]),
        },
      },
      description: "Logout response",
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
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Failed to clear authentication data",
    },
  },
});

export const backgroundIntegration = createRoute({
  path: "/api/integrations/bg",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              charmId: z.string().describe("The charm ID"),
              space: z.string().describe("The space DID"),
              integration: z.string().describe("The integration name"),
            })
            .openapi({
              example: {
                charmId: "bafy...",
                space: "did:",
                integration: "rss",
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
              success: z.boolean(),
              message: z.string(),
            }),
            z.object({
              error: z.string(),
            }),
          ]),
        },
      },
      description: "Background integration response",
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

export type LoginRoute = typeof login;
export type CallbackRoute = typeof callback;
export type RefreshRoute = typeof refresh;
export type LogoutRoute = typeof logout;
export type BackgroundIntegrationRoute = typeof backgroundIntegration;
