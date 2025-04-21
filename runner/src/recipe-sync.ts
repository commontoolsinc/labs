import { storage } from "./storage.ts";
import { JSONSchema, Schema } from "@commontools/builder";
import {
  getRecipe,
  getRecipeName,
  getRecipeParents,
  getRecipeSpec,
  getRecipeSrc,
  registerRecipe,
} from "./recipe-map.ts";
import { getCell } from "./cell.ts";
import { buildRecipe } from "./local-build.ts";
import {
  createItemsKnownToStorageSet,
  getBlobbyServerUrl,
  loadFromBlobby,
  saveToBlobby,
  setBlobbyServerUrl,
} from "./blobby-storage.ts";

export const recipeSrcSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    src: { type: "string" },
    spec: { type: "string" },
    parents: { type: "array", items: { type: "string" } },
    recipeName: { type: "string" },
  },
  required: ["id", "src"],
} as const satisfies JSONSchema;
export type RecipeSrc = Schema<typeof recipeSrcSchema>;

export const recipeSrcListSchema = {
  type: "array",
  items: { ...recipeSrcSchema, asCell: true },
} as const satisfies JSONSchema satisfies JSONSchema;

// For backward compatibility
export function setBobbyServerUrl(url: string) {
  setBlobbyServerUrl(url);
}

// Track recipes known to sto to avoid redundant saves
const recipesKnownToStorage = createItemsKnownToStorageSet();

// FIXME(JA): this really really really needs to be revisited
export async function syncRecipeBlobby(id: string) {
  console.log("syncRecipeBlobby", id);
  if (getRecipe(id)) {
    console.log("recipe exists", id);
    if (recipesKnownToStorage.has(id)) return;
    const src = getRecipeSrc(id);
    const spec = getRecipeSpec(id);
    const parents = getRecipeParents(id);
    if (src) saveRecipe(id, src, spec, parents);
    return;
  }

  console.log("loading from blobby", id);
  const response = await loadFromBlobby<{
    src: string;
    spec?: string;
    parents?: string[];
  }>("spell", id);

  if (!response) return;

  const src = response.src;
  const spec = response.spec || "";
  const parents = response.parents || [];

  const { recipe, errors } = await buildRecipe(src);
  if (errors) throw new Error(errors);

  console.log("registering recipe", id);
  registerRecipe(id, recipe!, src, spec, parents);
  recipesKnownToStorage.add(id);
}

function saveRecipe(
  id: string,
  src: string,
  spec?: string,
  parents?: string[],
  spellbookTitle?: string,
  spellbookTags?: string[],
): Promise<boolean> {
  // If the recipe is already known to storage, we don't need to save it again,
  // unless the user is trying to attach a spellbook title or tags.
  if (recipesKnownToStorage.has(id) && !spellbookTitle) {
    return Promise.resolve(true);
  }
  recipesKnownToStorage.add(id);

  const data = {
    src,
    recipe: JSON.parse(JSON.stringify(getRecipe(id))),
    spec,
    parents,
    recipeName: getRecipeName(id),
    spellbookTitle,
    spellbookTags,
  };

  return saveToBlobby("spell", id, data);
}

export async function ensureRecipeSourceCell(space: string, recipeId: string) {
  if (!recipeId) return;
  console.log("syncing recipe cells", recipeId);
  const recipe = getCell(
    space,
    { recipeId, type: "recipe" },
    recipeSrcSchema,
  );
  await storage.syncCell(recipe);
  console.log("recipe", recipe.get());
  if (recipe.get()?.id === recipeId) {
    console.log("recipe exists locally", recipeId);
    return; // no-op, we have it already
  }

  let src = getRecipeSrc(recipeId);
  if (!src) {
    console.log("syncing recipe blobby", recipeId);
    await syncRecipeBlobby(recipeId);
  }

  src = getRecipeSrc(recipeId);
  console.log("recipe src", src?.length);

  if (!src) {
    throw new Error(`can't find the recipe ${recipeId} locally or in blobby`);
  }

  recipe.set({
    id: recipeId,
    src,
    spec: getRecipeSpec(recipeId),
    parents: getRecipeParents(recipeId),
    recipeName: getRecipeName(recipeId),
  });

  console.log("recipe set", recipeId);

  await storage.syncCell(recipe);
  await storage.synced();
}
