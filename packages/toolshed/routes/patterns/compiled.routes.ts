import { createRoute, z } from "@hono/zod-openapi";

/**
 * OpenAPI route definition for retrieving compiled pattern files.
 * Returns pre-compiled JavaScript instead of TypeScript source.
 */
export const getCompiledPattern = createRoute({
  method: "get",
  path: "/api/patterns/compiled/:filename{.+}",
  request: {
    params: z.object({
      filename: z.string().describe(
        "The pattern file path to compile (e.g., system/default-app.tsx)",
      ),
    }),
  },
  responses: {
    200: {
      description: "Compiled JavaScript bundle with inline source map",
      content: {
        "application/javascript": {
          schema: z.string(),
        },
      },
    },
    304: {
      description: "Not modified (ETag match)",
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
      description: "Pattern not found",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Compilation error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
            details: z.string().optional(),
          }),
        },
      },
    },
  },
});
