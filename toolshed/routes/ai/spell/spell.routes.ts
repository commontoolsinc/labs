import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import {
  CasterRequestSchema,
  CasterResponseSchema,
  SearchSchemaRequestSchema,
  SearchSchemaResponseSchema,
  SpellSearchRequestSchema,
  SpellSearchResponseSchema,
} from "@/routes/ai/spell/spell.handlers.ts";
import { z } from "zod";
import {
  FulfillSchemaRequestSchema,
  FulfillSchemaResponseSchema,
} from "@/routes/ai/spell/handlers/fulfill.ts";
import {
  ImagineDataRequestSchema,
  ImagineDataResponseSchema,
} from "@/routes/ai/spell/handlers/imagine.ts";
import {
  RecastRequestSchema,
  RecastResponseSchema,
} from "@/routes/ai/spell/handlers/recast.ts";
import {
  ReuseRequestSchema,
  ReuseResponseSchema,
} from "@/routes/ai/spell/handlers/reuse.ts";

const tags = ["Spellcaster"];

const ErrorResponseSchema = z.object({
  error: z.string(),
});

export const fulfill = createRoute({
  description:
    "Search blobs to find real data fragments that can be stitched together to fulfill the passed schema. Extremely slow.",
  path: "/api/ai/spell/fulfill",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: FulfillSchemaRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      FulfillSchemaResponseSchema,
      "The processed schema result",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      ErrorResponseSchema,
      "An error occurred",
    ),
  },
});

export type FulfillSchemaRoute = typeof fulfill;

export const imagine = createRoute({
  description:
    "Hallucinate JSON data that conforms to a JSON schema, using an LLM.",
  path: "/api/ai/spell/imagine",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: ImagineDataRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      ImagineDataResponseSchema,
      "The processed schema result",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      ErrorResponseSchema,
      "An error occurred",
    ),
  },
});

export type ImagineDataRoute = typeof imagine;

export const search = createRoute({
  description: "OBSELETE: will be removed.",
  path: "/api/ai/spell/smart-search",
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
  description: "OBSELETE: will be removed.",
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
  description: "OBSELETE: will be removed.",
  path: "/api/ai/spell/search",
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

export const recast = createRoute({
  description:
    "Cast the spell of a given charm on a (compatible) candidate cell.",
  path: "/api/ai/spell/recast",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: RecastRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      RecastResponseSchema,
      "The recast result",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      ErrorResponseSchema,
      "An error occurred",
    ),
  },
});

export const reuse = createRoute({
  description: "Cast a compatible spell using this charm's data.",
  path: "/api/ai/spell/reuse",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: ReuseRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      ReuseResponseSchema,
      "The reuse result",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      ErrorResponseSchema,
      "An error occurred",
    ),
  },
});

export type RecastRoute = typeof recast;
export type ReuseRoute = typeof reuse;
