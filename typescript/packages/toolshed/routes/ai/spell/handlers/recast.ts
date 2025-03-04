import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import {
  getAllMemories,
  getBlob,
  getMemory,
} from "@/routes/ai/spell/behavior/effects.ts";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { RecastRoute } from "@/routes/ai/spell/spell.routes.ts";
import { Spell } from "@/routes/ai/spell/spell.ts";
import { Logger } from "@/lib/prefixed-logger.ts";
import { captureException } from "@sentry/deno";
import { areSchemaCompatible } from "@/routes/ai/spell/schema-compatibility.ts";

export const RecastRequestSchema = z.object({
  charmId: z.string().describe("The ID of the charm to reuse the spell from"),
  replica: z.string().describe("The space the charm is stored in"),
});

export const RecastResponseSchema = z.object({
  spellId: z.string(),
  cells: z.record(z.any()),
});

export type RecastRequest = z.infer<typeof RecastRequestSchema>;
export type RecastResponse = z.infer<typeof RecastResponseSchema>;

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
