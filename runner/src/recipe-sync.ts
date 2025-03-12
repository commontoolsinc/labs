import {
  addRecipe,
  getRecipe,
  getRecipeName,
  getRecipeParents,
  getRecipeSpec,
  getRecipeSrc,
} from "./recipe-map.ts";
import { buildRecipe } from "../../charm/src/localBuild.ts";
import {
  createItemsKnownToStorageSet,
  getBlobbyServerUrl,
  loadFromBlobby,
  saveToBlobby,
  setBlobbyServerUrl,
} from "./blobby-storage.ts";

// For backward compatibility
export function setBobbyServerUrl(url: string) {
  setBlobbyServerUrl(url);
}

// Track recipes known to storage to avoid redundant saves
const recipesKnownToStorage = createItemsKnownToStorageSet();

// FIXME(JA): this really really really needs to be revisited
export async function syncRecipeBlobby(id: string) {
  if (getRecipe(id)) {
    if (recipesKnownToStorage.has(id)) return;
    const src = getRecipeSrc(id);
    const spec = getRecipeSpec(id);
    const parents = getRecipeParents(id);
    if (src) saveRecipe(id, src, spec, parents);
    return;
  }

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

  const recipeId = addRecipe(recipe!, src, spec, parents);
  if (id !== recipeId) {
    throw new Error(`Recipe ID mismatch: ${id} !== ${recipeId}`);
  }
  recipesKnownToStorage.add(recipeId);
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
  if (recipesKnownToStorage.has(id) && !spellbookTitle) return;
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
