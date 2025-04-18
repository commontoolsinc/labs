import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { getAllBlobs, getAllMemories } from "../behavior/effects.ts";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { SearchSchemaRoute, SpellSearchRoute } from "../spell.routes.ts";
import { Spell } from "../spell.ts";
import { performSearch } from "../behavior/search.ts";
import { Logger } from "@/lib/prefixed-logger.ts";
import { FindSpellBySchemaRoute } from "@/routes/ai/spell/spell.routes.ts";
import { captureException } from "@sentry/deno";
import { FindSpellBySchemaRequest } from "@/routes/ai/spell/spell.handlers.ts";

import { checkSchemaMatch } from "@/lib/schema-match.ts";
import { isObject } from "@/routes/ai/spell/schema.ts";
import { Schema } from "jsonschema";
import { Recipe, RecipeSchema } from "../spell.ts";

export const findSpellBySchema: AppRouteHandler<FindSpellBySchemaRoute> =
  async (c) => {
    const logger: Logger = c.get("logger");
    const body = (await c.req.json()) as FindSpellBySchemaRequest;
    const startTime = performance.now();
    const tags = body.tags || [];

    try {
      const spells = await getAllBlobs({
        allWithData: true,
        prefix: "spell-",
      }) as Record<
        string,
        Record<string, unknown>
      >;
      const response = candidates(body.schema, spells, tags);

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

export interface SchemaCandidate {
  id: string;
  spell: Spell;
  similarity: number;
}

export interface SchemaAnalysis {
  argument: SchemaCandidate[];
  result: SchemaCandidate[];
}

function calculateTagScore(item: unknown, tags: string[]): number {
  // Convert item to string for searching
  const itemString = JSON.stringify(item).toLowerCase();

  // Count how many tags match (in hashtag form)
  const matchingTags = tags.filter((tag) =>
    itemString.includes(`#${tag.toLowerCase()}`)
  );

  // Return a score between 0 and 0.5 based on percentage of matching tags
  return matchingTags.length > 0
    ? (matchingTags.length / tags.length) * 0.5
    : 0;
}

function candidates(
  schema: Record<string, any>,
  spells: Record<string, any>,
  tags: string[],
): SchemaAnalysis {
  const data: SchemaCandidate[] = [];
  const argument: SchemaCandidate[] = [];
  const result: SchemaCandidate[] = [];

  console.log("Loaded", Object.keys(spells).length, "spells");
  console.log("Parsed", spells);

  // Parse spells using schema
  const validSpells: Record<string, Recipe> = {};
  for (const [key, spell] of Object.entries(spells)) {
    try {
      const parsed = RecipeSchema.parse(spell?.recipe);
      validSpells[key] = parsed;
    } catch (error: any) {
      console.log(`Invalid spell ${key}:`, error.message);
      continue;
    }
  }

  console.log("Parsed", Object.keys(validSpells).length, "spells");

  // Check spell schemas against our input schema
  for (const [key, spell] of Object.entries(validSpells)) {
    try {
      console.log("Checking spell:", key, spell);
      console.log("Input schema:", JSON.stringify(schema, null, 2));
      console.log(
        "Spell argument schema:",
        JSON.stringify(spell.argumentSchema, null, 2),
      );
      console.log(
        "Spell result schema:",
        JSON.stringify(spell.resultSchema, null, 2),
      );

      const tagScore = calculateTagScore(spell, tags);

      // Check how well our schema matches the spell's argument schema
      const argumentScore = schemaIntersection(
        schema,
        spell.argumentSchema,
      );
      console.log("Consumes match score:", argumentScore);
      if (argumentScore > 0) {
        argument.push({
          id: key.replace("spell-", ""),
          spell: spells[key] as Spell,
          similarity: argumentScore + tagScore,
        });
      }

      // Check how well our schema matches the spell's result schema
      const resultScore = schemaIntersection(
        schema,
        spell.resultSchema,
      );
      console.log("Produces match score:", resultScore);
      if (resultScore > 0) {
        result.push({
          id: key.replace("spell-", ""),
          spell: spells[key] as Spell,
          similarity: resultScore + tagScore,
        });
      }
    } catch (error) {
      console.error("Error checking spell:", key, error);
      continue;
    }
  }

  return {
    argument: argument.sort((a, b) => b.similarity - a.similarity),
    result: result.sort((a, b) => b.similarity - a.similarity),
  };
}

function schemaIntersection(
  schema1: Record<string, unknown> | null | undefined,
  schema2: Record<string, unknown> | null | undefined,
): number {
  // Early return if either schema is null or undefined
  if (!schema1 || !schema2) {
    return 0;
  }

  // Normalize by looking for properties or using the object directly
  const properties1 = (schema1.properties || schema1) as Record<
    string,
    unknown
  >;
  const properties2 = (schema2.properties || schema2) as Record<
    string,
    unknown
  >;

  // Handle edge case: invalid or empty schemas
  if (!properties1 || !properties2) {
    return 0;
  }

  const keys1 = Object.keys(properties1);
  const keys2 = Object.keys(properties2);

  if (keys1.length === 0 || keys2.length === 0) {
    return 0; // No properties to compare
  }

  // Get the union of all keys
  const allKeys = new Set([...keys1, ...keys2]);
  if (allKeys.size === 0) return 1; // Both schemas are empty

  let totalScore = 0;
  let possibleScore = allKeys.size;

  // Compare each property in either schema
  for (const key of allKeys) {
    const value1 = properties1[key];
    const value2 = properties2[key];

    // If property doesn't exist in one schema, no match for this property
    if (!value1 || !value2) continue;

    const type1 = (value1 as any).type;
    const type2 = (value2 as any).type;

    // If types don't match, no match for this property
    if (type1 !== type2) continue;

    // Handle arrays - check both type and items schema
    if (type1 === "array" && type2 === "array") {
      const items1 = (value1 as any).items;
      const items2 = (value2 as any).items;
      if (!items1 || !items2) continue;

      // Recursively check array item schemas and add partial score
      const arrayScore = schemaIntersection({ item: items1 }, { item: items2 });
      totalScore += arrayScore;
      continue;
    }

    // Handle nested objects
    if (type1 === "object" && type2 === "object") {
      // Recursively check nested schemas and add partial score
      const objectScore = schemaIntersection(value1 as any, value2 as any);
      totalScore += objectScore;
      continue;
    }

    // If we get here, the property types match
    totalScore += 1;
  }

  // Return percentage of matching properties
  return totalScore / possibleScore;
}
