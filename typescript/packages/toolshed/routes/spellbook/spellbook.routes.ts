import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import { jsonContent } from "stoker/openapi/helpers";
import * as HttpStatusCodes from "stoker/http-status-codes";

const tags = ["Spellbook"];

const SpellSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  ui: z.any(),
  publishedAt: z.string(),
  author: z.string(),
  data: z.any(),
  likes: z.array(z.string()),
  comments: z.array(z.object({
    id: z.string(),
    content: z.string(),
    author: z.string(),
    createdAt: z.string(),
  })),
  shares: z.number(),
});

const SpellListResponseSchema = z.object({
  spells: z.array(SpellSchema),
});

const CreateSpellRequestSchema = z.object({
  spellId: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  src: z.any(),
  spec: z.any(),
  parents: z.array(z.string()),
  ui: z.any().optional(),
});

const CreateSpellResponseSchema = z.object({
  success: z.boolean(),
});

export const createSpell = createRoute({
  method: "post",
  path: "/api/spellbook",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateSpellRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      CreateSpellResponseSchema,
      "Spell created successfully",
    ),
    [HttpStatusCodes.BAD_REQUEST]: {
      description: "Invalid request body",
    },
  },
});

export const listSpells = createRoute({
  method: "get",
  path: "/api/spellbook",
  tags,
  request: {
    query: z.object({
      search: z.string().optional(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      SpellListResponseSchema,
      "List of spells",
    ),
  },
});

export const getSpell = createRoute({
  method: "get",
  path: "/api/spellbook/{hash}",
  tags,
  request: {
    params: z.object({
      hash: z.string(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      SpellSchema,
      "Spell details",
    ),
    [HttpStatusCodes.NOT_FOUND]: {
      description: "Spell not found",
    },
  },
});
