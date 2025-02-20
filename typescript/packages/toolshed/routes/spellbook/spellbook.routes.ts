import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import { jsonContent } from "stoker/openapi/helpers";
import * as HttpStatusCodes from "stoker/http-status-codes";

const tags = ["Spellbook"];

const SpellSchema = z.object({
  hash: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  ui: z.any(),
  publishedAt: z.string(),
  author: z.string(),
  data: z.any(),
});

const SpellListResponseSchema = z.object({
  spells: z.array(SpellSchema),
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