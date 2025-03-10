import { z } from "zod";

export const RecipeSchema = z.object({
  argumentSchema: z.any(), // Schema type from jsonschema
  resultSchema: z.any(), // Schema type from jsonschema
  initial: z.any().optional(),
});

export type Recipe = z.infer<typeof RecipeSchema>;

export const SpellSchema = z.object({
  recipe: RecipeSchema,
  recipeName: z.string().optional(),
  spellbookTitle: z.string().optional(),
  spellbookTags: z.array(z.string()).optional(),
});

export type Spell = z.infer<typeof SpellSchema>;
