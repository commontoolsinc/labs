import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

/**
 * Create standard OAuth2 route definitions for a provider.
 * Paths follow the convention: /api/integrations/{provider}-oauth/{action}
 */
export function createOAuth2Routes(providerName: string) {
  const tags = [
    `${providerName[0].toUpperCase()}${
      providerName.slice(1)
    } OAuth Integration`,
  ];
  const basePath = `/api/integrations/${providerName}-oauth`;

  const login = createRoute({
    path: `${basePath}/login`,
    method: "post",
    tags,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                authCellId: z.string().describe("The authentication cell ID"),
                integrationPieceId: z
                  .string()
                  .describe("The piece ID of the integration piece"),
              })
              .openapi({
                example: {
                  authCellId:
                    '{"/" : {"link-v0.1" : {"id" : "of:bafe...", "space" : "did:key:bafe...", "path" : ["path", "to", "value"]}}}',
                  integrationPieceId: "integration-piece-123",
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
            schema: z.object({ error: z.string() }),
          },
        },
        description: "Invalid request parameters",
      },
    },
  });

  const callback = createRoute({
    path: `${basePath}/callback`,
    method: "get",
    tags,
    request: {
      query: z.object({
        code: z.string().optional().describe("Authorization code"),
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
              z.object({ error: z.string() }),
            ]),
          },
        },
        description: "OAuth callback response",
      },
      [HttpStatusCodes.BAD_REQUEST]: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string() }),
          },
          "text/html": {
            schema: z.any().describe("HTML response with error handling"),
          },
        },
        description: "Invalid callback parameters",
      },
    },
  });

  const refresh = createRoute({
    path: `${basePath}/refresh`,
    method: "post",
    tags,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                refreshToken: z.string().describe(
                  "The refresh token to use for obtaining new access tokens",
                ),
              })
              .openapi({
                example: { refreshToken: "1//0abc123..." },
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
              z.object({ error: z.string() }),
            ]),
          },
        },
        description: "Token refresh response",
      },
      [HttpStatusCodes.BAD_REQUEST]: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string() }),
          },
        },
        description: "Invalid request parameters or refresh token not found",
      },
      [HttpStatusCodes.UNAUTHORIZED]: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string() }),
          },
        },
        description: "Refresh token is invalid or expired",
      },
    },
  });

  const logout = createRoute({
    path: `${basePath}/logout`,
    method: "post",
    tags,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                authCellId: z.string().describe(
                  "The authentication cell ID to clear",
                ),
              })
              .openapi({
                example: {
                  authCellId:
                    '{"/" : {"link-v0.1" : {"id" : "of:bafe...", "space" : "did:key:bafe...", "path" : ["path", "to", "value"]}}}',
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
              z.object({ success: z.boolean(), message: z.string() }),
              z.object({ error: z.string() }),
            ]),
          },
        },
        description: "Logout response",
      },
      [HttpStatusCodes.BAD_REQUEST]: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string() }),
          },
        },
        description: "Invalid request parameters",
      },
      [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string() }),
          },
        },
        description: "Failed to clear authentication data",
      },
    },
  });

  // Background integration route is shared (not per-provider), kept in Google for backward compat
  const backgroundIntegration = createRoute({
    path: "/api/integrations/bg",
    method: "post",
    tags,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                pieceId: z.string().describe("The charm ID"),
                space: z.string().describe("The space DID"),
                integration: z.string().describe("The integration name"),
              })
              .openapi({
                example: {
                  pieceId: "bafy...",
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
              z.object({ success: z.boolean(), message: z.string() }),
              z.object({ error: z.string() }),
            ]),
          },
        },
        description: "Background integration response",
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

  return { login, callback, refresh, logout, backgroundIntegration };
}

export type OAuth2Routes = ReturnType<typeof createOAuth2Routes>;
export type OAuth2LoginRoute = OAuth2Routes["login"];
export type OAuth2CallbackRoute = OAuth2Routes["callback"];
export type OAuth2RefreshRoute = OAuth2Routes["refresh"];
export type OAuth2LogoutRoute = OAuth2Routes["logout"];
export type OAuth2BackgroundIntegrationRoute =
  OAuth2Routes["backgroundIntegration"];
