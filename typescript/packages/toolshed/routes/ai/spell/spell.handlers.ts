import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import {
  getAllBlobs,
  getAllMemories,
  getBlob,
  getMemory,
} from "./behavior/effects.ts";

import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  ProcessSchemaRoute,
  RecastRoute,
  ReuseRoute,
  SearchSchemaRoute,
  SpellSearchRoute,
} from "./spell.routes.ts";
import { Spell } from "./spell.ts";
import { performSearch } from "./behavior/search.ts";
import { Logger } from "@/lib/prefixed-logger.ts";
import { processSchema } from "@/routes/ai/spell/fulfill.ts";
import { candidates } from "@/routes/ai/spell/caster.ts";
import { CasterSchemaRoute } from "@/routes/ai/spell/spell.routes.ts";
import { processSpellSearch } from "@/routes/ai/spell/behavior/spell-search.ts";
import { captureException } from "@sentry/deno";
import { areSchemaCompatible } from "./schema-compatibility.ts";

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
  replica: z.string(),
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
    captureException(error);
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
    captureException(error);
    return c.json(
      { error: "Failed to process search" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

export const caster: AppRouteHandler<CasterSchemaRoute> = async (c) => {
  const logger: Logger = c.get("logger");
  const body = (await c.req.json()) as CasterRequest;
  const startTime = performance.now();
  const tags = body.tags || [];

  try {
    const memories = await getAllMemories(body.replica);

    const spells = await getAllBlobs({
      allWithData: true,
      prefix: "spell-",
    }) as Record<
      string,
      Record<string, unknown>
    >;
    const response = await candidates(body.schema, memories, spells, tags);

    return c.json(
      response,
      HttpStatusCodes.OK,
    );
  } catch (error) {
    logger.error({ error }, "Error processing schema");
    captureException(error);
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
export const RecastRequestSchema = z.object({
  charmId: z.string(),
  replica: z.string(),
});

export const ReuseRequestSchema = z.object({
  charmId: z.string(),
  replica: z.string(),
});

const CharmDataSchema = z.object({
  id: z.string(),
  data: z.record(z.any()),
  spell: z.record(z.any()),
  schema: z.record(z.any()),
});

export const RecastResponseSchema = z.object({
  spellId: z.string(),
  cells: z.record(z.any()),
});

export const ReuseResponseSchema = z.object({
  charm: z.record(z.any()),
  schema: z.record(z.any()),
  argument: z.record(z.any()),
  compatibleSpells: z.record(z.any()),
});

export type RecastRequest = z.infer<typeof RecastRequestSchema>;
export type ReuseRequest = z.infer<typeof ReuseRequestSchema>;
export type RecastResponse = z.infer<typeof RecastResponseSchema>;
export type ReuseResponse = z.infer<typeof ReuseResponseSchema>;

export const recast: AppRouteHandler<RecastRoute> = async (c) => {
  const logger: Logger = c.get("logger");
  const body = (await c.req.json()) as RecastRequest;
  const startTime = performance.now();

  try {
    const response = await processRecast(body.charmId, body.replica, logger);
    return c.json(response, HttpStatusCodes.OK);
  } catch (error) {
    logger.error({ error }, "Error processing recast");
    captureException(error);
    return c.json(
      { error: "Failed to process recast" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

async function processReuse(
  charmId: string,
  replica: string,
  logger: Logger,
): Promise<ReuseResponse> {
  const charm = await getMemory(charmId, replica);
  logger.info(
    { charmId, replica },
    "Retrieved charm",
  );

  const source = await getMemory(charm.source["/"], replica);
  logger.info({ sourceId: charm.source["/"] }, "Retrieved source charm");

  const argument = source.value.argument;
  const type = source.value.$TYPE;
  logger.debug({ type, argument }, "Extracted argument and type from source");

  const spellId = "spell-" + type;
  logger.info({ spellId }, "Looking up spell");

  const spell = await getBlob<Spell>(spellId);
  logger.info({ spellId }, "Retrieved spell");

  const schema = spell.recipe.argumentSchema;
  logger.debug({ schema }, "Extracted argument schema from spell");

  const spells = await getAllBlobs<Spell>({
    prefix: "spell-",
    allWithData: true,
  });

  if (Array.isArray(spells)) {
    throw new Error("Unexpected response format");
  }
  const spellEntries = Object.entries(spells)
    .filter(([id]) => id !== spellId);

  const compatibilityChecks = await Promise.all(
    spellEntries.map(async ([id, spell]) => {
      const spellSchema = spell.recipe.argumentSchema;
      const isCompatible = await areSchemaCompatible(schema, spellSchema);
      return isCompatible ? id : null;
    }),
  );

  const candidates = compatibilityChecks.filter((id): id is string =>
    id !== null
  );

  const compatibleSpells = candidates.reduce((acc, id) => {
    acc[id] = spells[id];
    return acc;
  }, {} as Record<string, any>);

  return {
    charm,
    schema,
    argument,
    compatibleSpells,
  };
}

async function processRecast(
  charmId: string,
  replica: string,
  logger: Logger,
): Promise<RecastResponse> {
  const charm = await getMemory(charmId, replica);
  logger.info(
    { charmId, replica },
    "Retrieved charm",
  );

  const source = await getMemory(charm.source["/"], replica);
  logger.info({ sourceId: charm.source["/"] }, "Retrieved source charm");

  const argument = source.value.argument;
  const type = source.value.$TYPE;
  logger.debug({ type, argument }, "Extracted argument and type from source");
  const spellId = "spell-" + type;
  logger.info({ spellId }, "Looking up spell");

  const spell = await getBlob<Spell>(spellId);
  logger.info({ spellId }, "Retrieved spell");
  if (!spell) {
    throw new Error("No spell found for id: " + spellId);
  }

  const schema = spell.recipe.argumentSchema;
  logger.debug({ schema }, "Extracted argument schema from spell");

  const cells = await getAllMemories(replica);
  // First get all charms that have a $TYPE and their IDs
  const typedCharms = Object.entries(cells)
    .filter(([_, cell]) => cell?.value?.$TYPE)
    .map(([id, cell]) => ({ id, cell }));
  // Then filter to matching schemas and build record
  const matchingCharms = await typedCharms.reduce(
    async (accPromise, { id, cell }) => {
      const acc = await accPromise;
      const charmSpellId = "spell-" + cell.value.$TYPE;
      try {
        const charmSpell = await getBlob<Spell>(charmSpellId);
        const charmSchema = charmSpell.recipe.argumentSchema;
        if (await areSchemaCompatible(schema, charmSchema)) {
          acc[id] = cell.value;
        }
      } catch (e) {
        logger.error({ error: e, charmSpellId }, "Error loading spell");
        // Skip charms where we can't load the spell
      }
      return acc;
    },
    Promise.resolve({} as Record<string, any>),
  );

  return {
    spellId: spellId.replace("spell-", ""),
    cells: matchingCharms,
  };
}

export const reuse: AppRouteHandler<ReuseRoute> = async (c) => {
  const logger: Logger = c.get("logger");
  const body = (await c.req.json()) as ReuseRequest;
  const startTime = performance.now();

  try {
    const response = await processReuse(body.charmId, body.replica, logger);
    return c.json(response, HttpStatusCodes.OK);
  } catch (error) {
    logger.error({ error }, "Error processing reuse");
    captureException(error);
    return c.json(
      { error: "Failed to process reuse" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
