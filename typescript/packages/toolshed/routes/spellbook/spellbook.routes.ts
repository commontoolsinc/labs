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
  authorAvatar: z.string(),
  data: z.any(),
  parents: z.array(z.string()).optional(),
  likes: z.array(z.string()),
  runs: z.number(),
  comments: z.array(z.object({
    id: z.string(),
    content: z.string(),
    author: z.string(),
    authorAvatar: z.string(),
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
  parents: z.array(z.string()).optional(),
  ui: z.any().optional(),
});

const CreateSpellResponseSchema = z.object({
  success: z.boolean(),
});

const LikeResponseSchema = z.object({
  success: z.boolean(),
  likes: z.array(z.string()),
  isLiked: z.boolean(),
});

const CommentRequestSchema = z.object({
  content: z.string(),
});

const CommentResponseSchema = z.object({
  success: z.boolean(),
  comment: z.object({
    id: z.string(),
    content: z.string(),
    author: z.string(),
    createdAt: z.string(),
  }),
});

const ShareResponseSchema = z.object({
  success: z.boolean(),
  shares: z.number(),
});

const RunResponseSchema = z.object({
  success: z.boolean(),
  runs: z.number(),
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
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      description: "Error fetching spells",
      content: {
        "application/json": {
          schema: SpellListResponseSchema,
        },
      },
    },
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

export const toggleLike = createRoute({
  method: "post",
  path: "/api/spellbook/{spellId}/like",
  tags,
  request: {
    params: z.object({
      spellId: z.string(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      LikeResponseSchema,
      "Spell like toggled successfully",
    ),
    [HttpStatusCodes.NOT_FOUND]: {
      description: "Spell not found",
    },
  },
});

export const createComment = createRoute({
  method: "post",
  path: "/api/spellbook/{spellId}/comment",
  tags,
  request: {
    params: z.object({
      spellId: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: CommentRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      CommentResponseSchema,
      "Comment created successfully",
    ),
    [HttpStatusCodes.NOT_FOUND]: {
      description: "Spell not found",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      description: "Invalid comment content",
    },
  },
});

export const shareSpell = createRoute({
  method: "post",
  path: "/api/spellbook/{spellId}/share",
  tags,
  request: {
    params: z.object({
      spellId: z.string(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      ShareResponseSchema,
      "Spell share count incremented successfully",
    ),
    [HttpStatusCodes.NOT_FOUND]: {
      description: "Spell not found",
    },
  },
});

export const trackRun = createRoute({
  method: "post",
  path: "/api/spellbook/{spellId}/run",
  tags,
  request: {
    params: z.object({
      spellId: z.string(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      RunResponseSchema,
      "Spell run count incremented successfully",
    ),
    [HttpStatusCodes.NOT_FOUND]: {
      description: "Spell not found",
    },
  },
});

export const deleteSpell = createRoute({
  method: "delete",
  path: "/api/spellbook/{spellId}",
  tags,
  request: {
    params: z.object({
      spellId: z.string(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        success: z.boolean(),
      }),
      "Spell deleted successfully",
    ),
    [HttpStatusCodes.NOT_FOUND]: {
      description: "Spell not found",
    },
  },
});
