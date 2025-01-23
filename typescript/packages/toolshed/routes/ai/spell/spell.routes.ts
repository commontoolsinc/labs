import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import {
  ProcessSchemaRequestSchema,
  ProcessSchemaResponseSchema,
  SearchSchemaRequestSchema,
  SearchSchemaResponseSchema,
} from "./spell.handlers.ts";
import { z } from "zod";

const tags = ["Spellcaster"];

const ErrorResponseSchema = z.object({
  error: z.string(),
});

export const imagine = createRoute({
  path: "/ai/spell/imagine",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: ProcessSchemaRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      ProcessSchemaResponseSchema,
      "The processed schema result",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      ErrorResponseSchema,
      "An error occurred",
    ),
  },
});

export type ProcessSchemaRoute = typeof imagine;

export const search = createRoute({
  path: "/ai/spell/search",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: SearchSchemaRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      SearchSchemaResponseSchema,
      "The search results",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      ErrorResponseSchema,
      "An error occurred",
    ),
  },
});

export type SearchSchemaRoute = typeof search;
