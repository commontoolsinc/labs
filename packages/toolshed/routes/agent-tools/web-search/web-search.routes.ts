import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Agent Tools"];

// Web search request schema
const WebSearchRequestSchema = z.object({
  query: z.string().min(1).describe("The search query"),
  max_results: z.number().min(1).max(10).default(5)
    .describe("Maximum number of search results to return"),
});

// Web search result schema
const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
});

// Web search endpoint
export const webSearch = createRoute({
  path: "/api/agent-tools/web-search",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: WebSearchRequestSchema.openapi({
            example: {
              query: "What is the population of Paris?",
              max_results: 5,
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
            results: z.array(WebSearchResultSchema),
            query: z.string(),
            total_results: z.number(),
          }),
        },
      },
      description: "Search results",
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
      description: "Error performing search",
    },
  },
});

export type WebSearchRoute = typeof webSearch;
