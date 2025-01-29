import { checkSchemaMatch } from "@/lib/schema-match.ts";
import { isObject } from "@/routes/ai/spell/schema.ts";
import { Schema } from "jsonschema";
import { z } from "zod";

export interface SchemaCandidate {
  key: string;
  similarity: number;
}

export const SpellSchema = z.object({
  src: z.string(),
  recipe: z.object({
    argumentSchema: z.record(z.unknown()),
    resultSchema: z.record(z.unknown()),
    initial: z.record(z.unknown()),
    result: z.object({
      $NAME: z.string(),
      $UI: z.object({
        type: z.string(),
        name: z.string(),
        props: z.record(z.unknown()),
        children: z.array(z.unknown()),
      }),
    }),
    nodes: z.array(z.unknown()),
  }),
  spec: z.string(),
  parents: z.array(z.string()),
  recipeName: z.string(),
  blobCreatedAt: z.string(),
  blobAuthor: z.string(),
});

export type Spell = z.infer<typeof SpellSchema>;
export interface SchemaAnalysis {
  data: string[];
  consumes: string[];
  produces: string[];
}

export function candidates(
  schema: Record<string, unknown>,
  blobContents: Record<string, Record<string, unknown>>,
  spells: Record<string, unknown>,
): SchemaAnalysis {
  const data: SchemaCandidate[] = [];
  const consumes: SchemaCandidate[] = [];
  const produces: SchemaCandidate[] = [];

  // Parse spells using schema
  const validSpells: Record<string, Spell> = {};
  for (const [key, spell] of Object.entries(spells)) {
    try {
      const parsed = SpellSchema.parse(spell);
      validSpells[key] = parsed;
    } catch (error) {
      continue;
    }
  }

  // Check direct schema matches in blobs
  for (const [key, blobData] of Object.entries(blobContents)) {
    try {
      // Check if the entire blob matches the schema
      if (checkSchemaMatch(blobData, schema)) {
        data.push({
          key,
          similarity: 1.0,
        });
        continue;
      }

      // Look for matching objects at the root level of arrays
      if (Array.isArray(blobData)) {
        const hasMatchingItems = blobData.some((item) =>
          isObject(item) &&
          checkSchemaMatch(item as Record<string, unknown>, schema)
        );
        if (hasMatchingItems) {
          data.push({
            key,
            similarity: 1.0,
          });
          continue;
        }
      }

      // Check immediate properties for matching objects
      for (const value of Object.values(blobData)) {
        if (
          isObject(value) &&
          checkSchemaMatch(value as Record<string, unknown>, schema)
        ) {
          data.push({
            key,
            similarity: 0.9,
          });
          break;
        }

        if (Array.isArray(value)) {
          const hasMatchingItems = value.some((item) =>
            isObject(item) &&
            checkSchemaMatch(item as Record<string, unknown>, schema)
          );
          if (hasMatchingItems) {
            data.push({
              key,
              similarity: 0.9,
            });
            break;
          }
        }
      }
    } catch (error) {
      continue;
    }
  }

  console.log("Total spells:", Object.keys(validSpells).length);

  // Check spell schemas against our input schema
  for (const [key, spell] of Object.entries(validSpells)) {
    try {
      console.log("Checking spell:", key);
      console.log("Input schema:", JSON.stringify(schema, null, 2));
      console.log(
        "Spell argument schema:",
        JSON.stringify(spell.recipe.argumentSchema, null, 2),
      );
      console.log(
        "Spell result schema:",
        JSON.stringify(spell.recipe.resultSchema, null, 2),
      );

      // Check if our schema matches the spell's argument schema
      const consumesMatch = schemaIntersection(
        schema,
        spell.recipe.argumentSchema,
      );
      console.log("Consumes match result:", consumesMatch);
      if (consumesMatch) {
        consumes.push({
          key,
          similarity: 1.0,
        });
      }

      // Check if our schema matches the spell's result schema
      const producesMatch = schemaIntersection(
        schema,
        spell.recipe.resultSchema,
      );
      console.log("Produces match result:", producesMatch);
      if (producesMatch) {
        produces.push({
          key,
          similarity: 1.0,
        });
      }
    } catch (error) {
      console.error("Error checking spell:", key, error);
      continue;
    }
  }

  return {
    data: data.sort((a, b) => b.similarity - a.similarity).map((d) => d.key),
    consumes: consumes.sort((a, b) => b.similarity - a.similarity).map((d) =>
      d.key
    ),
    produces: produces.sort((a, b) => b.similarity - a.similarity).map((d) =>
      d.key
    ),
  };
}

function schemaIntersection(
  schema1: Record<string, unknown>,
  schema2: Record<string, unknown>,
): boolean {
  // Normalize by looking for properties or using the object directly
  const properties1 = (schema1.properties || schema1) as Record<
    string,
    unknown
  >;
  const properties2 = (schema2.properties || schema2) as Record<
    string,
    unknown
  >;

  // Compare the properties of schema1 against schema2
  for (const [key, value1] of Object.entries(properties1)) {
    const value2 = properties2[key];
    if (!value2) return false;

    const type1 = (value1 as any).type;
    const type2 = (value2 as any).type;

    // Handle arrays - check both type and items schema
    if (type1 === "array" && type2 === "array") {
      const items1 = (value1 as any).items;
      const items2 = (value2 as any).items;
      if (!items1 || !items2) return false;

      // Recursively check array item schemas
      if (!schemaIntersection({ item: items1 }, { item: items2 })) {
        return false;
      }
      continue;
    }

    // Handle nested objects
    if (type1 === "object" && type2 === "object") {
      // Recursively check nested schemas
      if (!schemaIntersection(value1 as any, value2 as any)) {
        return false;
      }
      continue;
    }

    // Simple type comparison for primitives
    if (type1 !== type2) return false;
  }

  return true;
}
