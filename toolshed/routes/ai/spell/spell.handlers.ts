import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { getAllBlobs, getAllMemories } from "./behavior/effects.ts";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { SearchSchemaRoute, SpellSearchRoute } from "./spell.routes.ts";
import { Spell } from "./spell.ts";
import { performSearch } from "./behavior/search.ts";
import { Logger } from "@/lib/prefixed-logger.ts";

import { processSpellSearch } from "@/routes/ai/spell/behavior/spell-search.ts";
import { captureException } from "@sentry/deno";
import { areSchemaCompatible } from "./schema-compatibility.ts";

export const SearchSchemaRequestSchema = z.object({
  query: z.string(),
  options: z
    .object({
      limit: z.number().optional().default(10),
      offset: z.number().optional().default(0),
    })
    .optional(),
});

export const SearchSchemaResponseSchema = z.object({
  results: z.array(
    z.object({
      source: z.string(),
      results: z.array(
        z.object({
          key: z.string(),
          data: z.record(z.any()),
        }),
      ),
    }),
  ),
  metadata: z.object({
    totalDuration: z.number(),
    stepDurations: z.record(z.number()),
    logs: z.array(z.any()),
  }),
});

export type SearchSchemaRequest = z.infer<typeof SearchSchemaRequestSchema>;
export type SearchSchemaResponse = z.infer<typeof SearchSchemaResponseSchema>;

export const FindSpellBySchemaRequestSchema = z.object({
  schema: z.record(
    z
      .string()
      .or(
        z.number().or(z.boolean().or(z.array(z.any()).or(z.record(z.any())))),
      ),
  ).openapi({
    example: {
      title: { type: "string" },
      url: { type: "string" },
    },
  }),
  tags: z.array(z.string()).optional(),
});

export type FindSpellBySchemaRequest = z.infer<
  typeof FindSpellBySchemaRequestSchema
>;

export const FindSpellBySchemaResponseSchema = z.object({
  argument: z.array(
    z.object({ id: z.string(), spell: z.any(), similarity: z.number() }),
  ),
  result: z.array(
    z.object({ id: z.string(), spell: z.any(), similarity: z.number() }),
  ),
});

export type FindSpellBySchemaResponse = z.infer<
  typeof FindSpellBySchemaResponseSchema
>;

export const SpellSearchRequestSchema = z.object({
  replica: z.string(),
  query: z.string(),
  tags: z.array(z.string()).optional(),
  options: z.object({
    limit: z.number().optional().default(10),
    includeCompatibility: z.boolean().optional().default(true),
  }).optional(),
});

export const SpellSearchResponseSchema = z.object({
  spells: z.array(z.object({
    key: z.string(),
    name: z.string(),
    description: z.string(),
    matchType: z.enum(["reference", "text-match"]),
    compatibleBlobs: z.array(z.object({
      key: z.string(),
      snippet: z.string(),
    })),
  })),
  blobs: z.array(z.object({
    key: z.string(),
    snippet: z.string(),
    matchType: z.enum(["reference", "text-match"]),
    compatibleSpells: z.array(z.object({
      key: z.string(),
      name: z.string(),
      description: z.string(),
    })),
  })),
  metadata: z.object({
    processingTime: z.number(),
    matchedKeys: z.array(z.string()),
    totalSpellMatches: z.number(),
    totalBlobMatches: z.number(),
  }),
});

export type SpellSearchRequest = z.infer<typeof SpellSearchRequestSchema>;
export type SpellSearchResponse = z.infer<typeof SpellSearchResponseSchema>;

export const search: AppRouteHandler<SearchSchemaRoute> = async (c) => {
  const logger: Logger = c.get("logger");
  const startTime = performance.now();
  const body = (await c.req.json()) as SearchSchemaRequest;

  try {
    logger.info({ query: body.query }, "Processing search request");

    const result = await performSearch(body.query, logger);

    const response = result;

    return c.json(response, HttpStatusCodes.OK);
  } catch (error) {
    logger.error({ error }, "Error processing search");
    captureException(error);
    return c.json(
      { error: "Failed to process search" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const spellSearch: AppRouteHandler<SpellSearchRoute> = async (c) => {
  const logger: Logger = c.get("logger");
  const startTime = performance.now();
  const body = (await c.req.json()) as SpellSearchRequest;

  try {
    const keyMatches = body.query.match(/@[\w-]+/g) || [];
    const referencedKeys = keyMatches.map((k) => k.substring(1));

    const spells = await getAllBlobs({
      allWithData: true,
      prefix: "spell-",
    }) as Record<string, Record<string, unknown>>;

    const memories = await getAllMemories(body.replica);

    const results = processSpellSearch({
      query: body.query,
      referencedKeys,
      spells,
      blobs: memories,
      options: body.options,
      tags: body.tags,
    });

    const response = {
      ...results,
      metadata: {
        processingTime: performance.now() - startTime,
        matchedKeys: referencedKeys,
        totalSpellMatches: results.spells.length,
        totalBlobMatches: results.blobs.length,
      },
    };

    logger.info({
      spellMatches: results.spells.length,
      blobMatches: results.blobs.length,
      processingTime: response.metadata.processingTime,
    }, "Spell search completed");

    return c.json(response, HttpStatusCodes.OK);
  } catch (error) {
    logger.error({ error }, "Error processing spell search");
    captureException(error);
    return c.json(
      { error: "Failed to process spell search" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
