import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import {
  CasterRequestSchema,
  CasterResponseSchema,
  ProcessSchemaRequestSchema,
  ProcessSchemaResponseSchema,
  SearchSchemaRequestSchema,
  SearchSchemaResponseSchema,
  SpellSearchRequestSchema,
  SpellSearchResponseSchema,
} from "./spell.handlers.ts";
import { z } from "zod";

const tags = ["Spellcaster"];

const ErrorResponseSchema = z.object({
  error: z.string(),
});

export const fulfill = createRoute({
  path: "/ai/spell/fulfill",
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

export type ProcessSchemaRoute = typeof fulfill;

export const search = createRoute({
  path: "/ai/spell/smart-search",
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

export const caster = createRoute({
  path: "/ai/spell/caster",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: CasterRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      CasterResponseSchema,
      "The caster results",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      ErrorResponseSchema,
      "An error occurred",
    ),
  },
});

export type CasterSchemaRoute = typeof caster;

export const spellSearch = createRoute({
  path: "/ai/spell/search",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: SpellSearchRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      SpellSearchResponseSchema,
      "The spell search results",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      ErrorResponseSchema,
      "An error occurred",
    ),
  },
});

export type SpellSearchRoute = typeof spellSearch;
