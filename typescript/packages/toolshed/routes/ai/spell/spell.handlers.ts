import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { getAllBlobs, getBlob } from "./behavior/effects.ts";

import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  ProcessSchemaRoute,
  SearchSchemaRoute,
  SpellSearchRoute,
} from "./spell.routes.ts";
import { performSearch } from "./behavior/search.ts";
import { Logger } from "@/lib/prefixed-logger.ts";
import { processSchema } from "@/routes/ai/spell/fulfill.ts";
import { candidates } from "@/routes/ai/spell/caster.ts";
import { CasterSchemaRoute } from "@/routes/ai/spell/spell.routes.ts";
import { processSpellSearch } from "@/routes/ai/spell/behavior/spell-search.ts";

export const ProcessSchemaRequestSchema = z.object({
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
  many: z.boolean().optional(),
  prompt: z.string().optional(),
  options: z
    .object({
      format: z.enum(["json", "yaml"]).optional(),
      validate: z.boolean().optional(),
      maxExamples: z.number().default(5).optional(),
      exact: z.boolean().optional(),
    })
    .optional(),
});

export const ProcessSchemaResponseSchema = z.object({
  result: z.union([z.record(z.any()), z.array(z.record(z.any()))]),
  metadata: z.object({
    processingTime: z.number(),
    schemaFormat: z.string(),
    fragments: z.array(
      z.object({
        matches: z.array(
          z.object({
            key: z.string(),
            data: z.record(z.any()),
            similarity: z.number(),
          }),
        ),
        path: z.array(z.string()),
        schema: z.record(z.any()),
      }),
    ),
    reassembledExample: z.record(z.any()),
    tagMatchInfo: z.object({
      usedTags: z.any(),
      matchRanks: z.array(z.object({
        path: z.any(),
        matches: z.any(),
      })),
    }),
  }),
});

export type ProcessSchemaRequest = z.infer<typeof ProcessSchemaRequestSchema>;
export type ProcessSchemaResponse = z.infer<typeof ProcessSchemaResponseSchema>;

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

export const CasterRequestSchema = z.object({
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
  prompt: z.string().optional(),
});

export type CasterRequest = z.infer<typeof CasterRequestSchema>;

export const CasterResponseSchema = z.object({
  data: z.array(z.string()),
  consumes: z.array(z.string()),
  produces: z.array(z.string()),
});

export type CasterResponse = z.infer<typeof CasterResponseSchema>;

export const SpellSearchRequestSchema = z.object({
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

export const fulfill: AppRouteHandler<ProcessSchemaRoute> = async (c) => {
  const logger: Logger = c.get("logger");
  const body = (await c.req.json()) as ProcessSchemaRequest;
  const startTime = performance.now();

  try {
    const response = await processSchema(body, logger, startTime);

    logger.info(
      { processingTime: response.metadata.processingTime },
      "Request completed",
    );
    return c.json(response, HttpStatusCodes.OK);
  } catch (error) {
    logger.error({ error }, "Error processing schema");
    return c.json(
      { error: "Failed to process schema" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

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
    return c.json(
      { error: "Failed to process search" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const caster: AppRouteHandler<CasterSchemaRoute> = async (c) => {
  const logger: Logger = c.get("logger");
  const body = (await c.req.json()) as ProcessSchemaRequest;
  const startTime = performance.now();
  const tags = body.tags || [];

  try {
    const blobContents = await getAllBlobs({ allWithData: true }) as Record<
      string,
      Record<string, unknown>
    >;
    const spells = await getAllBlobs({
      allWithData: true,
      prefix: "spell-",
    }) as Record<
      string,
      Record<string, unknown>
    >;
    const response = await candidates(body.schema, blobContents, spells, tags);

    return c.json(
      response,
      HttpStatusCodes.OK,
    );
  } catch (error) {
    logger.error({ error }, "Error processing schema");
    return c.json(
      { error: "Failed to process schema" },
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

    const blobContents = await getAllBlobs({
      allWithData: true,
    }) as Record<string, Record<string, unknown>>;

    const results = await processSpellSearch({
      query: body.query,
      referencedKeys,
      spells,
      blobs: blobContents,
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
    return c.json(
      { error: "Failed to process spell search" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
