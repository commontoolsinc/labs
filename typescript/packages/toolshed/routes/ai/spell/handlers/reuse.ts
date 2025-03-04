import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import {
  getAllBlobs,
  getBlob,
  getMemory,
} from "@/routes/ai/spell/behavior/effects.ts";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { ReuseRoute } from "@/routes/ai/spell/spell.routes.ts";
import { Spell } from "@/routes/ai/spell/spell.ts";
import { Logger } from "@/lib/prefixed-logger.ts";
import { captureException } from "@sentry/deno";
import { areSchemaCompatible } from "@/routes/ai/spell/schema-compatibility.ts";

export const ReuseRequestSchema = z.object({
  charmId: z.string().describe("The ID of the charm to reuse data from"),
  replica: z.string().describe("The space the charm is stored in"),
});

export const ReuseResponseSchema = z.object({
  charm: z.record(z.any()),
  schema: z.record(z.any()),
  argument: z.record(z.any()),
  compatibleSpells: z.record(z.any()),
});

export type ReuseRequest = z.infer<typeof ReuseRequestSchema>;
export type ReuseResponse = z.infer<typeof ReuseResponseSchema>;

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
