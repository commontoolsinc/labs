import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Agent Tools"];

// Advanced options schema for POST endpoint
const WebReaderOptionsSchema = z.object({
  url: z.string().url().describe("The URL to extract content from"),
  include_images: z.boolean().default(false)
    .describe("Include image descriptions in the output"),
  include_tables: z.boolean().default(false)
    .describe("Include table content in the output"),
  include_code: z.boolean().default(true)
    .describe("Include code blocks in the output"),
  max_tokens: z.number().min(100).max(10000).default(4000)
    .describe("Maximum number of tokens to extract"),
});

// Simple GET endpoint
export const readWebPage = createRoute({
  path: "/api/agent-tools/web-read/:url{.+}",
  method: "get",
  tags,
  request: {
    params: z.object({
      url: z.string().describe("URL encoded web page URL to read").openapi({
        example: "https://metar-taf.com/KAFF",
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            content: z.string(),
            metadata: z.object({
              title: z.string().optional(),
              author: z.string().optional(),
              date: z.string().optional(),
              word_count: z.number(),
            }),
          }),
        },
      },
      description: "Extracted web page content",
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
      description: "Error extracting content",
    },
  },
});

// Advanced POST endpoint
export const readWebPageAdvanced = createRoute({
  path: "/api/agent-tools/web-read",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: WebReaderOptionsSchema.openapi({
            example: {
              url: "https://example.com/article",
              include_images: true,
              include_tables: true,
              max_tokens: 4000,
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
            content: z.string(),
            metadata: z.object({
              title: z.string().optional(),
              author: z.string().optional(),
              date: z.string().optional(),
              word_count: z.number(),
              images: z.array(z.string()).optional(),
              tables: z.array(z.string()).optional(),
            }),
          }),
        },
      },
      description: "Extracted web page content with advanced options",
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
      description: "Error extracting content",
    },
  },
});

export type ReadWebPageRoute = typeof readWebPage;
export type ReadWebPageAdvancedRoute = typeof readWebPageAdvanced;
