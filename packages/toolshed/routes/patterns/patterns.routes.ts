import { createRoute, z } from "@hono/zod-openapi";

/**
 * OpenAPI route definition for retrieving pattern files.
 * Serves TSX/TS files from the patterns directory.
 */
export const getPattern = createRoute({
  method: "get",
  path: "/api/patterns/{filename}",
  request: {
    params: z.object({
      filename: z.string().describe("The pattern file name to retrieve"),
    }),
  },
  responses: {
    200: {
      description: "Pattern file content",
      content: {
        "text/typescript-jsx": {
          schema: z.string(),
        },
      },
    },
    400: {
      description: "Invalid file path",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    404: {
      description: "File not found",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});
