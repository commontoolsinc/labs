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
          schema: z.object({
            url: z.string().describe("The OAuth URL to redirect to"),
          }),
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

export type LoginRoute = typeof login;
